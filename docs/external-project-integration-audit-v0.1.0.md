# External Meme Monitor Integration Audit

- Workstream: `GPT-Radar-Integration`
- Version: `GPT-Radar-Integration-v0.1.0`
- Target repository: `Wang-bbb/bsc-meme-radar`
- Base: `main`
- Scope: read-only source audit and integration plan only
- Production impact: none; no Worker runtime, route, Cron, KV, secrets, scoring, candidate eligibility, or deployment changes

## Executive decision

Do not merge the seven repositories wholesale. Treat them as research references and integrate only independently verified, read-only capabilities into the existing Meme Radar through isolated modules and shadow evaluation.

The existing repository already contains Four.meme TokenManager2 event decoding, finalized-block collection primitives, a bounded NodeReal adapter, narrative shadow evaluation, and wallet-intelligence shadow evaluation. New work must extend these foundations rather than duplicate them.

## Repository-by-repository findings

### 1. Miluer-tcq/meme-narrative-radar

- Public repository, default branch `main`, MIT license present.
- Useful ideas: multi-platform public trend collection (Weibo, Douyin, Baidu, Bilibili, Zhihu, Toutiao, Xiaohongshu), source-level health records, rank/momentum/spread aggregation, and distinguishing general trend attention from crypto penetration.
- Limitations: Node.js >=22.5, SQLite and Node-specific modules; not a drop-in Cloudflare Worker module. X/Twitter collection invokes `xreach` and explicitly requires agent-reach plus Twitter cookies; it is not a guaranteed anonymous/free X feed.
- Its `signals.js` includes holding/exit/position language and alert behavior. Do not import its trading/holding workflow or present its heuristic signals as proven profitable.
- Decision: MIT attribution permits future selective code reuse, but initial integration should be a clean Worker-compatible read-only source adapter. Preserve per-source coverage and freshness; never convert a failed source to zero heat.

### 2. simons-freedom/X-monitor

- Public repository; no LICENSE file found at repository root during this audit.
- Useful idea only: accept a user-configured webhook payload containing a post, timestamp, author metadata and media links; run text/image narrative extraction; emit a candidate hint for independent on-chain matching.
- Critical security finding: `core/chain_validator.py` constructs a payload whose `signature` field is `base64.b64encode(validate_key.encode())`, then sends it to a hard-coded plain-HTTP endpoint at `141.98.197.171:8000`. This is the private key itself encoded as Base64, not a cryptographic signature. Do not run this code, do not supply it with any wallet key, and do not import this validator. If anyone has already supplied a real key to this code, treat that key as compromised and move assets using a clean device and a new wallet.
- README also documents private-key/RPC configuration and automatic chain execution; `core/trader.py` is explicitly a trading module.
- Webhook intake also depends on a separately hosted push provider (the README mentions API-dance) or Telegram/KBot setup; this is not a free, self-contained X public API.
- Decision: no source-code reuse unless a license is added and independently reviewed. If later used, accept only sanitized webhook data with no wallet credentials, no private-key handling, no trade execution, and no untrusted remote code.

### 3. woshiguotao/meme-signal-monitor

- Public repository; no LICENSE file found at repository root during this audit.
- Useful ideas: separate discovery, token metadata, market dynamics, audit, developer history, smart-money observations and market-pattern checks.
- Limitations: source calls Binance Web3 public wallet-direct endpoints and a third-party K-line host; availability, access policy, schema stability, quotas and terms need independent validation. README describes Binance Web3 skills integration. Default liquidity threshold is $3,000, not the user's $5,000 requirement. Its score combines audit, liquidity, holder counts, developer and smart-money signals; this must not be copied as a substitute for hard safety gates.
- Decision: no code copying without a clear license. Reimplement only provider-agnostic concepts after endpoint/schema and policy checks. Keep $5,000 minimum and preserve unknown/missing evidence as review, never as a pass.

### 4. mx7625MX/BSC- (including PR #1)

- Public repository; no LICENSE file found at repository root during this audit.
- PR #1 describes a BSC MEME sniper with automated trading, rapid selling, copy trading and buy-volume triggers. The repository also documents wallet/private-key management and transaction execution.
- Decision: exclude trading, wallet, signing, private-key, transaction submission and sniper code. At most, study generic read-only event-monitoring concepts after code-level review and licensing clarification. Do not install or run the project as part of this radar.

### 5. hahzterry/solana-meme-monitor

- Public repository, MIT license present.
- Useful concepts: transaction sampling, wallet observations, whale-movement labels, retry/failover structure and explicit time-window analysis.
- Limitations found in source: `TransactionMonitor` polls signatures for the SPL Token Program address by default, not a complete new-pool discovery index; `PatternAnalyzer.detectPumpAndDump` and `detectAccumulation` are stubs returning null; `PriceService` tracks a fixed list of CoinGecko token IDs rather than arbitrary mint addresses and hard-codes a local proxy. The project uses MySQL/TypeORM and an ElizaOS Solana plugin, which is not a fit for the current Worker runtime.
- Decision: MIT attribution allows selective future reuse, but do not import it as a working Solana new-pool scanner. Reuse only tested, isolated ideas after validating protocol-specific pool creation and vault/mint ownership against current official program IDs.

### 6. Tech-Melon/fourmeme_newcoin_monitor

- Public repository; no LICENSE file found at repository root during this audit.
- Useful idea: Four.meme ticker API as a possible independent discovery cross-check.
- Limitations: polls every five seconds, identifies new listings by symbol-set difference, keeps state only in memory, and pushes Telegram notifications. Symbol-based identity can collide; process restart reinitializes history; this does not prove finalized on-chain creation, DEX migration, a real USDT pair, liquidity, or sellability. It also uses TLS impersonation/proxy settings to access the endpoint.
- Existing radar already has a stronger isolated official TokenManager2 event decoder, finalized-only bounded collector, reorg/checkpoint logic, and NodeReal read-only adapter shadow.
- Decision: do not duplicate its polling loop or use ticker results as candidate proof. At most, later compare its public ticker hints with finalized on-chain events if terms and schema permit.

### 7. bzd6661/TIGER-POWER-Terminal

- Public repository; no LICENSE file found at repository root during this audit.
- README describes a Binance Agentic Wallet BSC trading terminal with wallet login, buy/sell, transfers, holdings, copy/wallet tracking and auto-transfer features. It explicitly warns against exposing the panel publicly.
- Decision: exclude the trading terminal, Binance wallet integration, account handling, signing, transfers and order execution. Do not install or run it for this read-only project. Only generic, independently implemented ideas for displaying public market observations may be considered after license clarification.

## Existing main-repository overlap

The current main branch already documents or contains:
- BSC direct-USDT pool scanning and the $5,000 minimum-liquidity rule.
- GeckoTerminal/DexScreener/DexPaprika discovery and provider cooldown/coverage diagnostics.
- Solana PumpSwap and Raydium CPMM protocol-level pool decoding and bounded RPC cross-checks.
- Four.meme TokenManager2 V2 raw event decoding for TokenCreate, TokenPurchase, TokenSale, TradeStop and LiquidityAdded.
- Finalized-height collection, canonical block-hash checks, replay/reorg handling and bounded KV chunk writes in isolated shadow modules.
- Narrative observation shadow evaluation and wallet-intelligence shadow evaluation.

Relevant existing PRs include #92 (wallet intelligence shadow), #93/#102 (narrative shadow), #94/#96/#98 (Four.meme event/NodeReal/KV shadow foundations), and #100 (opt-in scheduled Four.meme shadow observer, disabled by default). These are not all production-integrated; do not describe shadow-only modules as active production features.

## Proposed integration architecture

1. **Discovery adapters**: existing BSC and Solana discovery first; Four.meme official finalized events remain the authoritative event lane. Any external ticker/index is only a hint.
2. **Narrative observations**: source adapters emit normalized `{source, topic, observedAt, rank, engagement, sourceStatus}`; store source coverage and freshness. Compare momentum only across the same healthy source set.
3. **Social/webhook hints**: optional X webhook input only if the user later provides a lawful, supported feed. Accept post metadata and content only; no account cookies, private keys, wallet credentials, or trading calls.
4. **Wallet/flow observations**: extend existing shadow wallet evaluator. Require finalized chain evidence, cohort retention/exit metrics, and source coverage; do not infer common ownership from address similarity alone.
5. **Independent hard-risk gates**: honeypot/sell simulation, contract permissions, tax, LP and holder concentration remain separate from narrative and momentum. Unknown evidence stays review-only.
6. **Daily report**: produce age buckets (<1h, 1-6h, 6-24h), exact chain/pool/token identity, quote-token contract, liquidity, volume/trades, evidence freshness, risk results, source coverage and direct explorer/DEX links. BSC formal candidates must have canonical BSC USDT as the actual quote asset and >=$5,000 liquidity.
7. **Shadow evaluation**: record outcomes at 30m, 2h, 6h and 24h for accepted and rejected samples. Do not tune thresholds from a handful of winners; include failed pumps, slow fades and flat tokens.

## Licensing and supply-chain rules

- MIT-licensed narrative and Solana repositories may be considered for selective reuse with attribution and retained license text.
- No LICENSE file was found at the root of X-monitor, meme-signal-monitor, BSC-, fourmeme_newcoin_monitor or TIGER-POWER-Terminal during this audit. Treat their code as all-rights-reserved unless the authors provide an explicit license or permission. Referencing public behavior or independently implementing generic ideas is not code reuse.
- Do not install dependencies or execute external project scripts as part of this audit. Review package manifests and source statically first.
- No new paid API, credential, cookie, private key, wallet connection, signature, transaction submission or trade execution is permitted in this integration workstream.

## Next implementation gates

- Verify each intended external endpoint against current official documentation and a small read-only smoke test; record response time, quota behavior, schema and terms.
- Build one isolated narrative source adapter and fixtures; keep it shadow-only until coverage and stability are measured.
- Add no X source until a lawful, user-configured feed is available; do not promise free X coverage.
- Continue Four.meme work from existing finalized event shadow; do not enable PR #100 or production scheduling without separate validation and deployment review.
- Add a report serializer only after source schemas and missing-data semantics are tested.
- Every PR and release must carry a clear `GPT-Radar-...` workstream/version label to distinguish this work from other contributors.

## Safety note

The X-monitor key-validation implementation is unsafe: Base64 is reversible encoding, not signing. Its hard-coded HTTP request transmits the encoded key material to a remote host. Never provide that project with real wallet credentials.
