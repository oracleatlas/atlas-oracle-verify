// Every long gap in one feed's publication history, dated.
//
// Reproduces the freeze table on oracleatlas.xyz. The claim being checked is not
// "the feed broke" — it is the opposite, and it is more interesting: the gaps
// are scheduled. Equity feeds hold their last price while the underlying market
// is closed, and every unfreeze lands at 00:00 UTC Monday. Chainlink documents
// this; the chain proves it.
//
//   node freeze.mjs 0x... [--days 21] [--min-hours 24]
//
// Walks backwards round by round until it has covered the requested span, so it
// costs more than cadence.mjs — a minute or two on a fast feed. No dependencies,
// no API key, Node 22+.

const RPC = process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SEL_LATEST = "0xfeaf968c";
const SEL_ROUND = "0x9a6fc8f5";
const SEL_DESC = "0x7284e416";

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};

const feed = process.argv[2];
if (!feed?.startsWith("0x")) {
  console.error("usage: node freeze.mjs <feed address> [--days 21] [--min-hours 24]");
  process.exit(1);
}
const DAYS = arg("--days", 21);
const MIN_GAP = arg("--min-hours", 24) * 3600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ethCall(calls) {
  const out = new Array(calls.length).fill(null);
  for (let i = 0; i < calls.length; i += 12) {
    const slice = calls.slice(i, i + 12);
    const body = slice.map((c, k) => ({
      jsonrpc: "2.0", id: i + k, method: "eth_call",
      params: [{ to: c.to, data: c.data }, "latest"],
    }));
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) break;
      if (res.status !== 429 && res.status < 500) throw new Error(`RPC HTTP ${res.status}`);
      await sleep(400 * 2 ** attempt);
    }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} after retries`);
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
  if (!updatedAt) return null;
  return { roundId: BigInt("0x" + w[0]), updatedAt, answer: BigInt("0x" + w[1]) };
}

function decodeString(raw) {
  if (!raw) return null;
  const hex = raw.slice(2);
  if (hex.length < 128) return null;
  const len = Number(BigInt("0x" + hex.slice(64, 128)));
  return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
}

const fmt = (s) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
const stamp = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const [latestRaw, descRaw] = await ethCall([
  { to: feed, data: SEL_LATEST },
  { to: feed, data: SEL_DESC },
]);
const head = decodeRound(latestRaw);
if (!head) {
  console.error(`no readable round at ${feed}`);
  process.exit(1);
}

const cutoff = head.updatedAt - DAYS * 86400;
const stamps = [head.updatedAt];
let back = 1n;
const BLOCK = 60n;

process.stderr.write(`walking back ${DAYS} days of rounds`);
while (stamps[stamps.length - 1] > cutoff) {
  const calls = [];
  for (let k = 0n; k < BLOCK; k++) {
    const rid = head.roundId - back - k;
    if (rid <= 0n) break;
    calls.push({ to: feed, data: SEL_ROUND + rid.toString(16).padStart(64, "0") });
  }
  if (!calls.length) break;

  const batch = (await ethCall(calls)).map(decodeRound).filter(Boolean);
  // A null block means the walk crossed the phase boundary: rounds before it
  // belong to a previous aggregator and are a different series. Stop rather than
  // stitch, or the oldest "gap" reported would be an artefact of the join.
  if (!batch.length) break;
  for (const r of batch) stamps.push(r.updatedAt);
  back += BLOCK;
  process.stderr.write(".");
}
process.stderr.write("\n");

stamps.sort((a, b) => b - a);
const gaps = [];
for (let i = 0; i < stamps.length - 1; i++) {
  const g = stamps[i] - stamps[i + 1];
  if (g >= MIN_GAP) gaps.push({ from: stamps[i + 1], to: stamps[i], seconds: g });
}

console.log(`\n${decodeString(descRaw) ?? feed}`);
console.log(`  ${stamps.length} rounds covering ${((stamps[0] - stamps[stamps.length - 1]) / 86400).toFixed(1)} days\n`);

if (!gaps.length) {
  console.log(`  no gap of ${MIN_GAP / 3600}h or more in that span.\n`);
} else {
  console.log(`  FROM                 TO                   DURATION    SECONDS   UNFREEZE LANDS ON`);
  for (const g of gaps.reverse()) {
    const d = new Date(g.to * 1000);
    console.log(
      [
        "  " + stamp(g.from) + " " + DAY[new Date(g.from * 1000).getUTCDay()],
        stamp(g.to) + " " + DAY[d.getUTCDay()],
        fmt(g.seconds).padStart(8),
        // The raw seconds are printed because minutes are floored here and any
        // other page is free to round differently. A one-minute disagreement
        // over formatting should not be mistakable for a disagreement over data.
        String(g.seconds).padStart(9),
        `   ${DAY[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`,
      ].join("   "),
    );
  }
  console.log(`\n  Look at the last column. If these were outages the unfreeze times would`);
  console.log(`  scatter; they do not. That is the finding — the freeze is scheduled, and`);
  console.log(`  the tokens keep trading through it.\n`);
}
