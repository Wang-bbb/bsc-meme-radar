# Narrative observation shadow module

This module compares rank-derived activity for a manually reviewed topic across independent content sources and compares two adjacent time windows.

## Scope

- Pure evaluator only. No scraping, proxying, cookies, X credentials, API keys, database, Worker route, KV writes, notifications, or scheduled polling.
- A caller must supply an already-reviewed `entity` mapping. It does not guess that a phrase is a ticker or contract address.
- Only sources declared in `expectedSources` and marked `ok` in `sourceStatuses` contribute observations.
- Every expected source must be healthy for complete declared coverage. Failed or missing source status is not interpreted as zero interest.
- A momentum comparison uses only sources that have valid observations in both windows. A newly appearing source cannot create artificial acceleration by increasing the number of contributing sources.
- At least two sources are required for a cross-source momentum label. Missing comparable history yields `warming_up`, not a momentum score.
- `momentum_candidate` is a research label only. It does not imply a token is safe, does not create a buy recommendation, and cannot affect production candidate scores.

## Input

`evaluateNarrativeEvidence({ observations, sourceStatuses, nowMs, windowMs, expectedSources })`

Each observation contains `entity`, `source`, `observedAt` (Unix ms), `rank`, and `listSize`. Each source status is `ok`, `failed`, or `disabled`. The caller must provide the full `expectedSources` list. Repeated observations from one source contribute only their maximum rank score per window.

## Remaining work before any live use

1. Select public, policy-compliant sources and confirm their stability and limits.
2. Add bounded collection, source health, deduplication, and persistent history.
3. Build human-reviewed phrase-to-token mappings with explicit ambiguity.
4. Validate false-positive rates on collected history.
5. Keep all outputs shadow-only until independently reviewed.

This module intentionally does not implement any platform scraper or call a paid provider. The external narrative project uses a Node/SQLite service and its own polling/scraping assumptions; it is not directly portable to this Cloudflare Worker.
