# Narrative observation shadow module

This module borrows the useful part of meme-narrative-radar: compare a topic's
rank-derived activity across independent content sources and compare the
current time window with the preceding window.

## Scope

- Pure evaluator only. No scraping, proxying, cookies, X credentials, API keys,
  database, Worker route, KV writes, notifications, or scheduled polling.
- A caller must supply an already-reviewed `entity` mapping. It does not guess
  that a Chinese phrase is a ticker or contract address.
- Failed upstream sources make coverage incomplete; they are not interpreted
  as zero interest.
- Missing prior-window evidence yields `warming_up`, not a momentum score.
- `momentum_candidate` is a research label only. It does not imply a token is
  safe, does not create a buy recommendation, and cannot affect production
  candidate scores.

## Input

`evaluateNarrativeEvidence({ observations, sourceStatuses, nowMs, windowMs })`

Each observation contains `entity`, `source`, `observedAt` (Unix ms),
`rank`, and `listSize`. Each source status is `ok`, `failed`, or
`disabled`. The caller must also provide the full `expectedSources` list.
Missing status, failed status, disabled status, or an empty expected-source list
means coverage is incomplete; partial coverage can never be called a complete
cross-platform signal. Scores are derived from rank within that source's list; repeated
observations from one source contribute only their maximum score per window.

## Remaining work before any live use

1. Select public, policy-compliant sources and confirm their stability/limits.
2. Add bounded collection, source health, deduplication, and persistent history.
3. Build human-reviewed phrase-to-token mappings with explicit ambiguity.
4. Validate false-positive rates on collected history.
5. Keep all outputs shadow-only until independently reviewed.

This module intentionally does not implement any platform scraper or call a
paid provider. The external narrative project uses a Node/SQLite service and
its own polling/scraping assumptions; it is not directly portable to this
Cloudflare Worker.
