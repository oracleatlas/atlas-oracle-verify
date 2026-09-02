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
// uiMultiplier() — an issuer-controlled function that exists on Robinhood's own
// stock-token contracts and on nothing else. It is how this script stops
// trusting a name. See the note above stockTokens().
const SEL_UIMULT = "0xa60bf13d";
const TOKEN_SUFFIX = "• Robinhood Token";

// Blockscout answers 403 to a request with no User-Agent. This script shipped
// without one for a day, and its own error message told you a User-Agent would
// not help — which was wrong, and cost anyone who tried to check the headline
// number.
//
// Measured on the same URL, 2 Sep 2026, negatives re-run afterwards to rule out
// a passing mood on their side:
//
//     (no User-Agent)                                     403
//     Mozilla/5.0                                         403
//     curl's default                                      403
//     Mozilla/5.0 (compatible)                            200
//     Mozilla/5.0 (compatible; AtlasVerify/1.0; +repo)    200
//     a real Chrome string                                200
//
// So it wants the ordinary shape, not a specific name. This declares what it is
// and where to find it rather than impersonating a browser: if they decide to
// block this script one day, they should be able to do it on purpose. Override
// it with RH_USER_AGENT if you would rather announce yourself differently.
const UA = process.env.RH_USER_AGENT ??
  "Mozilla/5.0 (compatible; AtlasVerify/1.0; +https://github.com/oracleatlas/atlas-oracle-verify)";
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
    // Backoff on 429/5xx, like rpc() above. Without it this threw on the first
    // rate limit — which it started doing the moment the token check added a few
    // hundred calls to the front of the run. The endpoint is public and shared:
    // the polite thing and the working thing are the same thing here.
    let res = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) break;
      if (res.status !== 429 && res.status < 500) throw new Error(`RPC HTTP ${res.status}`);
      await sleep(600 * 2 ** attempt);
    }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} after retries`);
    for (const r of await res.json()) if (r.result && r.result !== "0x") out[r.id] = r.result;
    await sleep(200);
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
    const res = await fetch(`${BLOCKSCOUT}/api/v2/search?${u}`, {
      headers: { accept: "application/json", "user-agent": UA },
    });
    if (!res.ok) {
      // A 403 HERE, with a User-Agent already sent, is a different fact from the
      // one this script used to report — so the message says what was tried
      // instead of telling you the door is closed.
      if (res.status === 403) {
        throw new Error(
          `blockscout returned 403 for ${BLOCKSCOUT}\n` +
          `  This request DID send a User-Agent (${UA}),\n` +
          `  which was enough on 2 Sep 2026. So either they tightened it again, or this IP is\n` +
          `  being rate limited. Try RH_USER_AGENT=<something else>, or wait and re-run.\n` +
          `  cadence.mjs and freeze.mjs never touch the explorer and are unaffected: they read the\n` +
          `  chain directly, and they are the two that check the numbers on the front page.\n` +
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
      const addr = it.address ?? it.address_hash;
      if (ticker && addr && !out.has(ticker)) {
        out.set(ticker, { name: name.replace(TOKEN_SUFFIX, "").replace(/\s*•\s*$/, "").trim(), address: addr });
      }
    }
    cursor = data.next_page_params ?? null;
    if (!cursor) break;
  }

  // ── and now stop trusting the name ────────────────────────────────────────
  //
  // The suffix "• Robinhood Token" is a STRING IN A NAME. Anyone can mint a
  // token that ends with it, and plenty have. Measured 2 Sep 2026: the
  // explorer's own search returns 452 tickers carrying that suffix, and only
  // 196 of them answer uiMultiplier() — the rest are wrappers (WAAPL, LPNVDA,
  // AUTSLA) and jokes (HOODRAT, ANTICHRIST, SHIT) wearing the name.
  //
  // So a script that counted the name would report 452 tokenized stocks on a
  // chain that has 196, and would print a table that looks complete. That is
  // the same failure this script already refuses on the FEED side — where
  // discovery enumerates a log topic and only reads descriptions to label. This
  // is that rule finally applied to the token side too: the explorer proposes,
  // the chain decides.
  const rows = [...out.entries()];
  const answered = await ethCall(rows.map(([, v]) => ({ to: v.address, data: SEL_UIMULT })));
  const confirmed = new Map();
  for (let n = 0; n < rows.length; n++) {
    if (answered[n]) confirmed.set(rows[n][0], rows[n][1].name);
  }
  process.stderr.write(
    `  ${out.size} carry the name, ${confirmed.size} answer uiMultiplier() and are real\n`,
  );
  if (!confirmed.size) {
    throw new Error(
      "no token answered uiMultiplier(). Either the RPC is lying to us or the interface changed —\n" +
      "  either way this is a 'do not know', not a chain with zero tokenized stocks.",
    );
  }
  return confirmed;
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
