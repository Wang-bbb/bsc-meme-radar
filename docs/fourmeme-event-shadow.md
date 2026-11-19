# Four.meme TokenManager2 event shadow

## Purpose

This is a read-only, isolated foundation for observing Four.meme BSC V2 launches and their subsequent on-chain activity. The decoder does not fetch RPC data; the collector accepts injected RPC/KV adapters but does not configure providers, run on a schedule, expose a Worker route, notify, rank, or change candidate eligibility.

Official reference:
- TokenManager2 BSC: `0x5c952063c7fc8610FFDB798152D69F0B9550762b`
- V2 events: `TokenCreate`, `TokenPurchase`, `TokenSale`, `TradeStop`, `LiquidityAdded`
- Official ABI: https://github.com/four-meme-community/fourmeme-docs/blob/main/contracts/interfaces/ITokenManager2.sol
- Event listening guide: https://github.com/four-meme-community/four-meme-ai/blob/main/skills/four-meme-integration/references/event-listening.md

## Raw RPC log decoding

The shadow module now exports `decodeFourMemeRawLog(log, { finalityStatus, transactionFrom })`.
It decodes the five non-indexed V2 events from raw `eth_getLogs` entries after checking:

- The emitting address is the canonical BSC TokenManager2 contract.
- Exactly one topic is present (topic0); the official V2 event declarations have no indexed arguments.
- Topic0 matches one of the five canonical event signatures.
- ABI head lengths, address word padding, dynamic string offsets/lengths, and UTF-8 validity.
- The log is not marked `removed`; block/transaction identity and explicit finality are then validated by the normalizer.

Topic0 values are kept next to the decoder and exercised by raw-log fixtures. The TokenPurchase topic is also cross-checked against an independent published Four.meme event reference. The Keccak implementation used to derive the signature constants was checked against the canonical empty-input and ERC-20 Transfer vectors; no runtime hashing dependency is added.

The decoder does not fetch logs, infer transaction senders, determine finality, or manage reorgs. A caller may supply transaction sender metadata separately; for TokenPurchase, the event's `account` remains the recipient, not a proven sender.

## Deliberate boundaries

- Raw `eth_getLogs` data is decoded only for the five documented V2 event signatures; unknown topics and unexpected indexed arguments are rejected.
- Event source must be the canonical TokenManager2 contract. V1 is not included.
- Integer values stay decimal strings; no unsafe JavaScript number conversion.
- `TokenPurchase.account` is explicitly a recipient and is **not necessarily** the transaction sender. The optional transaction sender is kept in a separate field.
- `TokenSale.account` is the seller.
- `TradeStop` marks the end of bonding-curve trading; it does not prove a successful DEX migration.
- `LiquidityAdded.base` is the token; `quote == address(0)` means BNB. Its `offers` field is the token amount added to LP, not remaining curve offers.
- Only events explicitly marked `finalized` contribute to summaries. Confirmed/unfinalized events are ignored so an unstable chain tip cannot silently become evidence.
- Event identity is transaction hash + log index. The separate collector shadow stores canonical block hashes, rewinds/replays on detected reorgs, and advances its cursor only after observation writes succeed.
- A summary is on-chain observation only. It does not imply sellability, safe contract code, adequate DEX liquidity, profitable wallets, or future price appreciation.

## Bounded collector shadow

A separate `fourmeme-event-collector.js` module now provides a dependency-injected, read-only collector core:

- Requires an explicit finalized-height provider; it never reads the unstable latest tip itself.
- Bounds each invocation by block count and log count.
- Requests canonical hashes only for sparse 250-block checkpoints, the scan-range boundaries, and blocks that actually contain matching logs; every returned log is checked against its own canonical block hash.
- Stores replaceable KV chunks, including empty-block entries, instead of one key per block. The scheduled observer configures 250 blocks per chunk; the collector default remains 1,000. Each serialized chunk is measured in UTF-8 bytes and capped at 1 MiB (configurable lower, never higher); an oversized chunk fails closed before the cursor write. A normal run contained within one chunk uses two KV writes total: one chunk record plus cursor/checkpoint state.
- Keeps a rolling checkpoint window (default 8 checkpoints), adding every 250th block plus every block containing a matching event. A detected reorg rewinds to the last matching checkpoint and replays; a reorg reaching beyond the retained window halts for manual recovery rather than guessing.
- Writes chunk observations before cursor state. If a KV write fails or a serialized chunk exceeds its byte cap, the cursor is not advanced and the same range can be replayed. The byte cap does not automatically split an oversized chunk.
- Uses a 30-day TTL for chunk event records; cursor/checkpoint state has no TTL.
- Defaults to at most 1,000 blocks per invocation and caps each new-range canonical-hash batch at 32 block lookups (the retained checkpoint verification is a separate bounded batch). If an event-heavy range exceeds the cap, it stops before making that hash request and does not advance the cursor.
- Even with chunked writes, keep scheduled execution at or below one run per five minutes until actual KV and RPC consumption are measured; pause on any quota error.

Chunk records may contain a stale suffix after an interrupted reorg replay; any future reader must treat the cursor/checkpoint state as the committed boundary and must never consume block entries above `cursorBlock`.

This remains a shadow library, not an active Worker collector: no scheduled polling, Worker route, or dashboard integration has been added. The isolated NodeReal adapter has passed live read-only finalized-height, canonical-hash batch, and official-contract log-read checks against the configured free BSC endpoint. If the provider returns an error or quota response, collection must remain disabled and report the coverage gap rather than falling back to `latest` or an arbitrary confirmation count.


## Latest live finalized-event sample (2026-11-18)

The latest bounded read-only NodeReal smoke (GitHub Actions run #374) observed BSC mainnet chain ID `0x38`, latest block `134357679`, and finalized block `134357677`. Against the official TokenManager2 contract:

- TokenCreate: 35 raw finalized logs; 35 ABI decodes passed in blocks `134355678–134357677`.
- TokenPurchase: 65 raw finalized logs; 65 ABI decodes passed in the same 2,000-block window.
- TokenSale: 35 raw finalized logs; 35 ABI decodes passed in the same 2,000-block window.
- TradeStop: 0 matching logs in the bounded 20,000-block window `134337678–134357677`.
- LiquidityAdded: 0 matching logs in the same bounded 20,000-block window.

The three observed event types now have real finalized-chain samples, not just fixtures. TradeStop and LiquidityAdded still have no live samples; their decoders remain unit-tested only. An empty sample window is not proof that an event never occurs and must not be reported as successful live validation.

## NodeReal read-only RPC adapter shadow

A separate `fourmeme-nodereal-adapter.js` module now provides a bounded HTTPS JSON-RPC adapter for the collector's injected dependencies:

- Reads the `finalized` block tag for the collector cursor; it does not substitute `latest` or an arbitrary confirmation count.
- Batch-reads canonical block headers by explicit block number, validates returned block numbers and hashes, and caps each batch at 32.
- Reads logs only from the official TokenManager2 contract address and caps each requested range at 2,000 blocks and each response at 500 logs.
- Uses request timeouts, rejects non-HTTPS endpoints, and fails closed on HTTP/RPC errors or malformed responses. Endpoint values and credentials are not logged.
- The adapter is not wired to Worker routes, KV, scheduled execution, or the production candidate pipeline. Live read-only verification against the configured GitHub Actions secret remains a separate gate; unit tests use mocked RPC responses and do not prove the live provider path.

## Next integration gates (not implemented here)

1. Verify raw RPC log decoding against independently observed official contract events.
2. Verify a real public REST token-search response before writing a parser. Do not infer a schema from CLI flags or documentation examples. The current GitHub Actions smoke request received HTTP 403 with a location-restriction HTML page, so no REST response schema has been captured; do not attempt to bypass that restriction.
3. Use the existing free BSC RPC only; bound block ranges and request counts. On quota/rate-limit errors, report a coverage gap and stop.
4. Read finalized block height, persist cursor and block hashes, replay an overlap window, and deduplicate.
5. Join TokenCreate → purchases/sales → LiquidityAdded by token contract address, never symbol.
6. Keep Four.meme candidates in a separate observation lane until existing $5,000 liquidity and all current safety gates independently pass.
7. Before unattended collection, measure actual KV value sizes and daily writes on a bounded test deployment; if a chunk reaches the byte cap, reduce the scan range or introduce a versioned chunk-splitting reader/writer rather than raising the cap blindly.

No paid API, private key, wallet connection, signing, transaction submission, trading, or automatic deployment is used.


## Scheduled shadow integration (draft)

- A ten-minute Cloudflare Cron invokes the Worker `scheduled()` handler.
- Collection is opt-in only: unless `FOURMEME_SHADOW_ENABLED=true` is explicitly configured, each cron invocation returns disabled immediately and performs no KV writes or NodeReal RPC calls.
- The first enabled run anchors at the then-current BSC finalized block. It does not backfill the contract's historical deployment history.
- Each invocation is bounded to at most 250 blocks and 25 logs; if the provider returns too many logs or the KV chunk approaches its byte budget, the scheduler retries progressively smaller ranges down to one block.
- Each stored KV chunk covers at most 250 blocks. At the ten-minute cadence, the normal path uses at most three KV writes per run (chunk, cursor, status), or about 433 writes/day including the one-time start anchor. This is below the current Free-plan 1,000 writes/day quota and leaves headroom for the existing radar; actual account usage must still be monitored. The collector still writes the cursor last and verifies canonical hashes before persisting observations.
- Status is available at `/fourmeme-shadow/status`. When disabled, this endpoint returns the disabled state without reading KV or calling RPC; when enabled, it reads the persisted observation status. Records older than 30 minutes are returned as `stale` with the last run time and prior status, rather than presenting an old success as current; malformed records/timestamps return `status_corrupt`. It reports observation/coverage state only; it does not feed the meme candidate ranking, mark tokens safe, or generate trading signals.
- This PR adds a Cron trigger and Worker handler, so merging it will deploy the Worker. Keep it Draft until the tests, review, and a separate production deployment approval are complete.
