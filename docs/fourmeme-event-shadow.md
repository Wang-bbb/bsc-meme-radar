# Four.meme TokenManager2 event shadow

## Purpose

This is a read-only, isolated foundation for observing Four.meme BSC V2 launches and their subsequent on-chain activity. It does not discover tokens on its own, call an RPC, persist cursors, run on a schedule, expose a Worker route, notify, rank, or change candidate eligibility.

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

- Input must already be decoded against the official V2 ABI. This module does not guess topic hashes or decode raw `eth_getLogs` data.
- Event source must be the canonical TokenManager2 contract. V1 is not included.
- Integer values stay decimal strings; no unsafe JavaScript number conversion.
- `TokenPurchase.account` is explicitly a recipient and is **not necessarily** the transaction sender. The optional transaction sender is kept in a separate field.
- `TokenSale.account` is the seller.
- `TradeStop` marks the end of bonding-curve trading; it does not prove a successful DEX migration.
- `LiquidityAdded.base` is the token; `quote == address(0)` means BNB. Its `offers` field is the token amount added to LP, not remaining curve offers.
- Only events explicitly marked `finalized` contribute to summaries. Confirmed/unfinalized events are ignored so an unstable chain tip cannot silently become evidence.
- Event identity is transaction hash + log index. Reorg-safe persistence still requires a future collector to store block hashes, rewind/replay an overlap window, and reconcile replaced blocks before advancing its cursor.
- A summary is on-chain observation only. It does not imply sellability, safe contract code, adequate DEX liquidity, profitable wallets, or future price appreciation.

## Bounded collector shadow

A separate `fourmeme-event-collector.js` module now provides a dependency-injected, read-only collector core:

- Requires an explicit finalized-height provider; it never reads the unstable latest tip itself.
- Bounds each invocation by block count and log count.
- Requires canonical block hashes for every block in the scan range and checks every returned log against its block hash.
- Stores replaceable per-block KV records, including empty blocks, so replay can overwrite orphaned observations.
- Keeps a rolling per-block hash checkpoint window (default 128 blocks). A detected shallow reorg rewinds to the last matching checkpoint and replays; a reorg reaching beyond the retained window halts for manual recovery rather than guessing.
- Writes block observations before cursor state. If a KV write fails, the cursor is not advanced and the same range can be replayed.
- Uses a 30-day TTL for per-block event records; cursor/checkpoint state has no TTL.

This is still a shadow library, not an active Worker collector. No RPC adapter, scheduler, Worker route, or dashboard integration has been added. BNB Chain's BSC JSON-RPC documentation defines the `finalized` block tag for `eth_getBlockByNumber`; the existing NodeReal endpoint used by this project has not yet been live-tested for that tag. The host must implement `getBlockHashes` efficiently (prefer JSON-RPC batching) and must prove that `getFinalizedBlockNumber` returns that finalized height. If the configured free RPC does not support it, collection must remain disabled rather than silently falling back to `latest` or an arbitrary confirmation count.

## Next integration gates (not implemented here)

1. Verify raw RPC log decoding against independently observed official contract events.
2. Verify a real public REST token-search response before writing a parser. Do not infer a schema from CLI flags or documentation examples. The current GitHub Actions smoke request received HTTP 403 with a location-restriction HTML page, so no REST response schema has been captured; do not attempt to bypass that restriction.
3. Use the existing free BSC RPC only; bound block ranges and request counts. On quota/rate-limit errors, report a coverage gap and stop.
4. Read finalized block height, persist cursor and block hashes, replay an overlap window, and deduplicate.
5. Join TokenCreate → purchases/sales → LiquidityAdded by token contract address, never symbol.
6. Keep Four.meme candidates in a separate observation lane until existing $5,000 liquidity and all current safety gates independently pass.

No paid API, private key, wallet connection, signing, transaction submission, trading, or automatic deployment is used.
