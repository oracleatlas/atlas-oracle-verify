# Verify Oracle Atlas

Three scripts that reproduce the numbers on [oracleatlas.xyz](https://oracleatlas.xyz)
from the chain, without trusting that page or this one.

Zero dependencies. No API key. No install. Node 22+.

```bash
node cadence.mjs  0x<feed>          # how often a feed actually publishes
node freeze.mjs   0x<feed>          # every long gap, dated
node coverage.mjs                   # how many stock tokens have a live oracle
```

Every script takes a feed address. Get them all, ticker by ticker, from the
same API the site is built on — no key, no install:

```bash
node -e 'fetch("https://oracleatlas.xyz/api/v1/feeds").then(r=>r.json()).then(d=>d.feeds.forEach(f=>console.log(f.ticker.padEnd(6),f.feed)))'
```

That list is the first link in the chain: from there every number on the site is
two RPC calls you make yourself, against a node we do not control.

---

## Why this repo exists

The site makes a specific promise: *every number here is reproducible with two
RPC calls against a public endpoint.* A promise like that is worth exactly as
much as the reader's ability to test it, and "read our code" is not a test when
the code is a monitor you would have to run for a week.

So these are not the monitor. They are the shortest path from a claim on the
page to the same number arriving on your terminal from a node we do not control.
Point them at a different RPC with `RH_RPC_URL` if you would rather not use the
default.

Run them against a claim you doubt. That is the intended use.

## What each one checks

**`cadence.mjs`** — samples 45 consecutive rounds and reports the median and
maximum gap. The site quotes cadence rather than instantaneous age on purpose:
an age is one photograph and is refutable in a sentence ("you sampled at a weird
moment"), while a median over 45 rounds is a structural property of the feed.

**Expect the medians to differ slightly, and know why before you call it a
contradiction.** This script samples the 45 rounds that exist the moment you run
it. The site refreshes its cadence once a day — 45 rounds across every feed is
~1,500 round reads — and publishes the timestamp of that measurement as
`cadenceMeasuredAt` in `/api/v1/feeds`, next to the `generatedAt` of the page
itself. On a feed that publishes twice a day the two windows are a round or two
apart, which moves the median by a few percent and neither number is wrong.

What must match exactly is the **max gap** and every row of `freeze.mjs`: those
are specific events, not a rolling statistic, and they do not move. If those
disagree, the site is wrong.

**`freeze.mjs`** — walks a feed backwards and prints every gap over 24 hours with
its start, end and duration. The finding is not that the feeds break. It is that
they don't: the gaps begin on Friday and every single unfreeze lands at 00:00 UTC
on Monday. Outages scatter. These don't.

This is also how you audit [the record](https://oracleatlas.xyz/archive.html).
Every weekend the site has on file gets a permanent page with a window on it —
`/weekend/2026-08-03.html` and so on. Point `freeze.mjs` at any feed and the gaps
it prints should line up with those windows. If a weekend on that list has no
matching gap on the chain, the list is wrong and you found it without asking
anyone.

**`coverage.mjs`** — the headline. Enumerates the `AnswerUpdated` topic across a
week of blocks, reads `description()` on every aggregator that published, and
matches against the Robinhood stock tokens from the explorer.

It never uses a name to *find* a feed, only to label one, and that is the part
worth checking. Three description conventions coexist on this chain for the same
kind of feed:

```
Robinhood AAPL / USD
RHNVDA / USD
Robinhood DELL-USD
```

A regex written against the first drops NVDA, TSLA, SPY and MSFT — and still
returns a table that looks complete. Names can't defeat a log query.

## What these scripts do not prove

- **`coverage.mjs` reports what published, not what exists.** A token with "no
  live feed" may have an aggregator that has gone quiet, or may have never had
  one. Pass `--days 31` to scan the chain's full history and tell those apart.
  An aggregator deployed but which has never emitted `AnswerUpdated` is invisible
  to log enumeration by construction, and nothing here can see it.
- **The composite signal is not reproduced here.** `STALE_AND_DIVERGENT` needs
  DEX prices as well as oracle prices, which means a second data source and a
  liquidity judgment. These three scripts are the oracle side only — the side
  that is purely on-chain and therefore purely checkable.
- **Nothing here reads a balance or a token.** These scripts have no wallet
  concept and never will.
- **The archive is checkable one weekend at a time, not in bulk.** `freeze.mjs`
  confirms that a claimed window really happened on a given feed. It does not
  confirm that the archive lists every weekend it should — for that, the index
  itself declares the gaps: a weekend nobody observed is published as *not
  measured* rather than omitted, so the thing to audit is whether a row is
  missing entirely, and the row set is every Monday in the range.

## The project

[oracleatlas.xyz](https://oracleatlas.xyz) is the live monitor these scripts
check, and [the record](https://oracleatlas.xyz/archive.html) is every weekend it
has on file — including the ones nobody was watching, which stay on the list as
*not measured* instead of disappearing from it.

[What it has found](https://github.com/oracleatlas) ·
[@OracleAtlas_bot](https://t.me/OracleAtlas_bot) for transition alerts.

## License

MIT.
