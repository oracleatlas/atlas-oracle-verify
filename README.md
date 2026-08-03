# Verify Oracle Atlas

Three scripts that reproduce the numbers on [oracleatlas.xyz](https://oracleatlas.xyz)
from the chain, without trusting that page or this one.

Zero dependencies. No API key. No install. Node 22+.

```bash
node cadence.mjs  0x<feed>          # how often a feed actually publishes
node freeze.mjs   0x<feed>          # every long gap, dated
node coverage.mjs                   # how many stock tokens have a live oracle
```

Feed addresses are printed on the site next to each ticker.

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
moment"), while a median over 45 rounds is a structural property of the feed. If
the site and this script disagree, the site is wrong.

**`freeze.mjs`** — walks a feed backwards and prints every gap over 24 hours with
its start, end and duration. The finding is not that the feeds break. It is that
they don't: the gaps begin on Friday and every single unfreeze lands at 00:00 UTC
on Monday. Outages scatter. These don't.

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

## License

MIT.
