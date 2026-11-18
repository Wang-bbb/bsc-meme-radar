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
- Requests canonical hashes only for sparse 100-block checkpoints, the scan-range boundaries, and blocks that actually contain matching logs; every returned log is checked against its own canonical block hash.
- Stores replaceable 1,000-block KV chunks, including empty-block entries, instead of one key per block. A normal run contained within one chunk uses two KV writes total: one chunk record plus cursor/checkpoint state.
- Keeps a rolling checkpoint window (default 16 checkpoints), adding every 100th block plus every block containing a matching event. A detected reorg rewinds to the last matching checkpoint and replays; a reorg reaching beyond the retained window halts for manual recovery rather than guessing.
- Writes chunk observations before cursor state. If a KV write fails, the cursor is not advanced and the same range can be replayed.
- Uses a 30-day TTL for chunk event records; cursor/checkpoint state has no TTL.
- Defaults to at most 1,000 blocks per invocation. Even with chunked writes, keep scheduled execution at or below one run per five minutes until actual KV and RPC consumption are measured; pause on any quota error.

Chunk records may contain a stale suffix after an interrupted reorg replay; any future reader must treat the cursor/checkpoint state as the committed boundary and must never consume block entries above `cursorBlock`.

This is still a shadow library, not an active Worker collector. No RPC adapter, scheduler, Worker route, or dashboard integration has been added. NodeReal's BSC `eth_getBlockByNumber` API reference explicitly lists `finalized` as a supported block tag, so the documented capability is present; the user's actual API key/endpoint has not yet been live-tested. The host must still verify a successful response and implement `getBlockHashes` as one efficient JSON-RPC batch over the requested sparse block numbers. If the configured free RPC returns an error or quota response, collection must remain disabled and report the coverage gap rather than falling back to `latest` or an arbitrary confirmation count.

## Next integration gates (not implemented here)

1. Verify raw RPC log decoding against independently observed official contract events.
2. Verify a real public REST token-search response before writing a parser. Do not infer a schema from CLI flags or documentation examples. The current GitHub Actions smoke request received HTTP 403 with a location-restriction HTML page, so no REST response schema has been captured; do not attempt to bypass that restriction.
3. Use the existing free BSC RPC only; bound block ranges and request counts. On quota/rate-limit errors, report a coverage gap and stop.
4. Read finalized block height, persist cursor and block hashes, replay an overlap window, and deduplicate.
5. Join TokenCreate → purchases/sales → LiquidityAdded by token contract address, never symbol.
6. Keep Four.meme candidates in a separate observation lane until existing $5,000 liquidity and all current safety gates independently pass.

No paid API, private key, wallet connection, signing, transaction submission, trading, or automatic deployment is used.
