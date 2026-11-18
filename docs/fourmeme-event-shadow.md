# Four.meme TokenManager2 event shadow

## Purpose

This is a read-only, isolated foundation for observing Four.meme BSC V2 launches and their subsequent on-chain activity. It does not discover tokens on its own, call an RPC, persist cursors, run on a schedule, expose a Worker route, notify, rank, or change candidate eligibility.

Official reference:
- TokenManager2 BSC: `0x5c952063c7fc8610FFDB798152D69F0B9550762b`
- V2 events: `TokenCreate`, `TokenPurchase`, `TokenSale`, `LiquidityAdded`
- Official ABI: https://github.com/four-meme-community/fourmeme-docs/blob/main/contracts/interfaces/ITokenManager2.sol
- Event listening guide: https://github.com/four-meme-community/four-meme-ai/blob/main/skills/four-meme-integration/references/event-listening.md

## Deliberate boundaries

- Input must already be decoded against the official V2 ABI. This module does not guess topic hashes or decode raw `eth_getLogs` data.
- Event source must be the canonical TokenManager2 contract. V1 is not included.
- Integer values stay decimal strings; no unsafe JavaScript number conversion.
- `TokenPurchase.account` is explicitly a recipient and is **not necessarily** the transaction sender. The optional transaction sender is kept in a separate field.
- `TokenSale.account` is the seller.
- `LiquidityAdded.base` is the token; `quote == address(0)` means BNB.
- Only events explicitly marked `finalized` contribute to summaries. Confirmed/unfinalized events are ignored so an unstable chain tip cannot silently become evidence.
- Event identity is transaction hash + log index. Reorg-safe persistence still requires a future collector to store block hashes, rewind/replay an overlap window, and reconcile replaced blocks before advancing its cursor.
- A summary is on-chain observation only. It does not imply sellability, safe contract code, adequate DEX liquidity, profitable wallets, or future price appreciation.

## Next integration gates (not implemented here)

1. Verify raw RPC log decoding against independently observed official contract events.
2. Verify a real public REST token-search response before writing a parser. Do not infer a schema from CLI flags or documentation examples.
3. Use the existing free BSC RPC only; bound block ranges and request counts. On quota/rate-limit errors, report a coverage gap and stop.
4. Read finalized block height, persist cursor and block hashes, replay an overlap window, and deduplicate.
5. Join TokenCreate → purchases/sales → LiquidityAdded by token contract address, never symbol.
6. Keep Four.meme candidates in a separate observation lane until existing $5,000 liquidity and all current safety gates independently pass.

No paid API, private key, wallet connection, signing, transaction submission, trading, or automatic deployment is used.
