// The headline number: how many tokenized stocks have a live oracle, and how
// many do not.
//
// This is the slow one — it enumerates log topics across a week of blocks, so
// budget a few minutes. It is also the one worth running, because it is the
// claim most easily faked and the method is the actual finding.
//
//   node coverage.mjs [--days 7]
//
// Feeds are NEVER located by name. Three description conventions coexist on this
// chain for the same kind of feed:
//
//     Robinhood AAPL / USD
//     RHNVDA / USD
//     Robinhood DELL-USD
//
// A regex written against the first silently drops NVDA, TSLA, SPY and MSFT —
// and still prints a table that looks complete. So discovery enumerates the
// AnswerUpdated topic instead and only reads names to LABEL what it found.
// Names can't defeat a log query. That is the design decision this script
// exists to let you check.
//
// No dependencies, no API key, Node 22+.

const RPC = process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const BLOCKSCOUT = process.env.RH_BLOCKSCOUT ?? "https://robinhoodchain.blockscout.com";

// keccak256("AnswerUpdated(int256,uint256,uint256)")
const TOPIC = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f";
const SEL_DESC = "0x7284e416";
const TOKEN_SUFFIX = "• Robinhood Token";
const BLOCKS_PER_DAY = Math.round(86_400_000 / 101); // ~101ms blocks

const i = process.argv.indexOf("--days");
const DAYS = i === -1 ? 7 : Number(process.argv[i + 1]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.ok) {
      const j = await res.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`RPC HTTP ${res.status}`);
    await sleep(400 * 2 ** attempt);
  }
  throw new Error(`${method} failed`);
}

async function ethCall(calls) {
  const out = new Array(calls.length).fill(null);
  for (let k = 0; k < calls.length; k += 12) {
    const slice = calls.slice(k, k + 12);
    const body = slice.map((c, n) => ({
      jsonrpc: "2.0", id: k + n, method: "eth_call",
      params: [{ to: c.to, data: c.data }, "latest"],
    }));
    const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    for (const r of await res.json()) if (r.result && r.result !== "0x") out[r.id] = r.result;
    await sleep(120);
  }
  return out;
}

function decodeString(raw) {
  if (!raw) return null;
  const hex = raw.slice(2);
  if (hex.length < 128) return null;
  const len = Number(BigInt("0x" + hex.slice(64, 128)));
  if (!len || len > 128) return null;
  return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8").trim();
}

// The node's log limit is a timeout, not a fixed block count, so the same range
// can succeed once and fail a minute later. Bisect on failure rather than
// picking a small chunk and paying for it on every window.
async function emitters(from, to, chunk = 400_000) {
  const found = new Set();
  async function scan(start, end, depth = 0) {
    try {
      const logs = await rpc("eth_getLogs", [{ fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16), topics: [TOPIC] }]);
      for (const l of logs) found.add(l.address.toLowerCase());
    } catch (err) {
      if (!/timed out|too many|range|limit|exceed/i.test(String(err)) || end <= start || depth >= 10) throw err;
      const mid = Math.floor((start + end) / 2);
      await scan(start, mid, depth + 1);
      await scan(mid + 1, end, depth + 1);
    }
  }
  const total = Math.ceil((to - from + 1) / chunk);
  let done = 0;
  for (let s = from; s <= to; s += chunk) {
    await scan(s, Math.min(s + chunk - 1, to));
    process.stderr.write(`\r  logs: window ${++done}/${total}, ${found.size} aggregators   `);
    await sleep(120);
  }
  process.stderr.write("\n");
  return [...found];
}

async function stockTokens() {
  const out = new Map();
  let cursor = null, firstSeen = null;
  for (let page = 0; page < 30; page++) {
    const u = new URLSearchParams({ q: "Robinhood Token", ...(cursor ?? {}) });
    const res = await fetch(`${BLOCKSCOUT}/api/v2/search?${u}`, { headers: { accept: "application/json" } });
    if (!res.ok) {
      // Blockscout ha messo la sua API dietro una sfida anti-bot: verificato il
      // 01/09/2026, 0 richieste su 12 passate, e ogni path sotto /api risponde
      // 403 a un client che non sia un browser. Non e' un errore di questo
      // script e non si aggira con uno user-agent — provato.
      //
      // Un messaggio che dice "HTTP 403" e basta manda chi legge a cercare un
      // bug che non ha.
      if (res.status === 403) {
        throw new Error(
          `blockscout returned 403 for ${BLOCKSCOUT}\n` +
          `  The explorer's API is behind an anti-bot challenge, so this script cannot enumerate\n` +
          `  the token list from it. This is the explorer's change, not a bug here.\n` +
          `  cadence.mjs and freeze.mjs do not use the explorer and still work: they read the chain\n` +
          `  directly, and they are the two that check the numbers the site actually publishes.\n` +
          `  Point this at another Blockscout instance with RH_BLOCKSCOUT=<url> if you have one.`,
        );
      }
      throw new Error(`blockscout HTTP ${res.status}`);
    }
    const data = await res.json();
    const items = data.items ?? [];
    if (!items.length) break;
    const fp = JSON.stringify(items[0]);
    if (page > 0 && fp === firstSeen) break; // the explorer ignored our cursor
    if (page === 0) firstSeen = fp;
    for (const it of items) {
      const name = String(it.name ?? "");
      if (it.type !== "token" || !name.includes(TOKEN_SUFFIX)) continue;
      const ticker = String(it.symbol ?? "").toUpperCase();
      if (ticker && !out.has(ticker)) out.set(ticker, name.replace(TOKEN_SUFFIX, "").replace(/\s*•\s*$/, "").trim());
    }
    cursor = data.next_page_params ?? null;
    if (!cursor) break;
  }
  return out;
}

// Every ticker a description could denote, with the convention that produced it.
// Which are real is decided by checking against the token list — that is what
// keeps BTC/USD out without maintaining a denylist that would rot.
function candidates(desc) {
  const out = [];
  let m;
  if ((m = /^Robinhood\s+(.+?)\s*\/\s*USD$/i.exec(desc))) out.push([m[1].toUpperCase(), "Robinhood X / USD"]);
  if ((m = /^Robinhood\s+(.+?)\s*-\s*USD$/i.exec(desc))) out.push([m[1].toUpperCase(), "Robinhood X-USD"]);
  if ((m = /^RH([A-Z0-9.]+)\s*[/-]\s*USD$/i.exec(desc))) out.push([m[1].toUpperCase(), "RHX / USD"]);
  if ((m = /^([A-Z0-9.]+)\s*[/-]\s*USD$/i.exec(desc))) out.push([m[1].toUpperCase(), "bare X / USD"]);
  return out;
}

process.stderr.write(`tokens from the explorer...\n`);
const tokens = await stockTokens();
process.stderr.write(`  ${tokens.size} Robinhood stock tokens\n`);

const head = Number(BigInt(await rpc("eth_blockNumber", [])));
const from = Math.max(0, head - BLOCKS_PER_DAY * DAYS);
process.stderr.write(`scanning blocks ${from.toLocaleString()}..${head.toLocaleString()} (${DAYS}d)\n`);
const aggs = await emitters(from, head);

const descs = await ethCall(aggs.map((to) => ({ to, data: SEL_DESC })));

const matched = new Map();
const byConvention = new Map();
const ignored = [];
descs.forEach((raw, n) => {
  const desc = decodeString(raw);
  if (!desc) return;
  const hit = candidates(desc).find(([t]) => tokens.has(t));
  if (!hit) return void ignored.push(desc);
  if (!matched.has(hit[0])) {
    matched.set(hit[0], { feed: aggs[n], desc });
    byConvention.set(hit[1], (byConvention.get(hit[1]) ?? 0) + 1);
  }
});

const blind = [...tokens.keys()].filter((t) => !matched.has(t)).sort();

console.log(`\n═══ coverage over the last ${DAYS} days ═══\n`);
console.log(`  ${tokens.size} stock tokens · ${matched.size} with a feed that published · ${blind.length} without\n`);
console.log(`  description conventions actually in use:`);
for (const [k, v] of [...byConvention].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(3)}  ${k}`);
console.log(`\n  A regex against the most common convention alone would have found ${byConvention.get("Robinhood X / USD") ?? 0}`);
console.log(`  of ${matched.size} feeds and reported a table that looks complete.\n`);
console.log(`  no live feed in the window (${blind.length}):`);
console.log(`  ${blind.join(" ")}\n`);
console.log(`  non-equity feeds on this chain, ignored: ${ignored.length}\n`);
console.log(`  "No live feed" means no price published in ${DAYS} days. It does NOT mean no feed`);
console.log(`  exists — pass --days 31 to scan the chain's whole history and see which of those`);
console.log(`  tickers once had an oracle that stopped.\n`);
