// How often does one feed actually publish?
//
// Reproduces the cadence table on oracleatlas.xyz. The point of the measurement
// is that an instantaneous age is refutable in one sentence — "you sampled at a
// weird moment" — and a median over 45 consecutive rounds is not. It is a
// structural property of the feed, and you should get the same answer we do.
//
//   node cadence.mjs 0xa088fad0a0a62693af068e2edb80b1578c8a9365
//
// Feed addresses are printed on the site next to every ticker. No dependencies,
// no API key, Node 22+.

const RPC = process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SEL_LATEST = "0xfeaf968c"; // latestRoundData()
const SEL_ROUND = "0x9a6fc8f5";  // getRoundData(uint80)
const SEL_DESC = "0x7284e416";   // description()
const ROUNDS = 45;

const feed = process.argv[2];
if (!feed?.startsWith("0x")) {
  console.error("usage: node cadence.mjs <feed address>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chunked because the public endpoint answers 429 above ~12 calls per batch.
async function ethCall(calls) {
  const out = new Array(calls.length).fill(null);
  for (let i = 0; i < calls.length; i += 12) {
    const slice = calls.slice(i, i + 12);
    const body = slice.map((c, k) => ({
      jsonrpc: "2.0", id: i + k, method: "eth_call",
      params: [{ to: c.to, data: c.data }, "latest"],
    }));
    const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    for (const r of await res.json()) if (r.result && r.result !== "0x") out[r.id] = r.result;
    await sleep(120);
  }
  return out;
}

const words = (hex) => hex.slice(2).match(/.{64}/g) ?? [];

function decodeRound(raw) {
  const w = words(raw ?? "");
  if (w.length < 5) return null;
  const updatedAt = Number(BigInt("0x" + w[3]));
  // A round that never closed carries updatedAt 0. Counting it would invent a
  // gap of decades and make the median meaningless.
  if (!updatedAt) return null;
  return { roundId: BigInt("0x" + w[0]), updatedAt };
}

function decodeString(raw) {
  if (!raw) return null;
  const hex = raw.slice(2);
  if (hex.length < 128) return null;
  const len = Number(BigInt("0x" + hex.slice(64, 128)));
  return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
}

const fmt = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
};

const [latestRaw, descRaw] = await ethCall([
  { to: feed, data: SEL_LATEST },
  { to: feed, data: SEL_DESC },
]);

const head = decodeRound(latestRaw);
if (!head) {
  console.error(`no readable round at ${feed} — is that a Chainlink aggregator on this chain?`);
  process.exit(1);
}

// roundId on a proxy is (phaseId << 64) | aggregatorRoundId. Walking backwards
// stays inside the current phase; crossing the boundary reverts, which shows up
// as a null and simply ends the sample. Rounds from a previous aggregator are a
// different series and stitching them together would fabricate continuity.
const calls = [];
for (let back = 1; back < ROUNDS; back++) {
  const rid = head.roundId - BigInt(back);
  if (rid <= 0n) break;
  calls.push({ to: feed, data: SEL_ROUND + rid.toString(16).padStart(64, "0") });
}

const stamps = [head.updatedAt];
for (const raw of await ethCall(calls)) {
  const r = decodeRound(raw);
  if (r) stamps.push(r.updatedAt);
}
stamps.sort((a, b) => b - a);

const gaps = [];
for (let i = 0; i < stamps.length - 1; i++) {
  const g = stamps[i] - stamps[i + 1];
  if (g > 0) gaps.push(g);
}
const sorted = [...gaps].sort((a, b) => a - b);
const mid = sorted.length >> 1;
const median = sorted.length ? (sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)) : null;

console.log(`\n${decodeString(descRaw) ?? feed}`);
console.log(`  ${stamps.length} rounds sampled, ${gaps.length} gaps`);
console.log(`  newest round   ${new Date(stamps[0] * 1000).toISOString()}`);
console.log(`  oldest round   ${new Date(stamps[stamps.length - 1] * 1000).toISOString()}`);
console.log(`  median gap     ${median === null ? "n/a" : fmt(median)}`);
console.log(`  max gap        ${gaps.length ? fmt(Math.max(...gaps)) : "n/a"}`);
console.log(`\n  age right now  ${fmt(Math.floor(Date.now() / 1000) - stamps[0])}`);
console.log(`\nThe max gap on an equity feed is usually a weekend. Run freeze.mjs to see them dated.\n`);
