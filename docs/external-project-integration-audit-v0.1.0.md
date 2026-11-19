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
- Narrative and wallet-intelligence shadow work exists as prior PR history, but it is not all present on main. PR #92 (wallet intelligence shadow) and #93 (narrative observation shadow) are closed without merge; PR #102 (narrative source-coverage hardening) and #105 (wallet finality/evidence hardening) are still open Draft PRs at the time of this audit.
- Four.meme event decoding, the NodeReal adapter, and KV chunk byte cap from #94/#96/#98 are merged into main. PR #100 (opt-in scheduled Four.meme shadow observer) remains open as a Draft PR and is disabled by default.

Do not describe closed-unmerged or Draft PR modules as active production features.

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


## Follow-up source-level review of existing shadow PRs (2026-11-20)

### Narrative shadow PR #102

- The evaluator is intentionally pure and currently has no real source adapters, scheduler, storage, or entity-to-contract resolver. It is therefore not a live social monitor and cannot yet discover meme tokens by itself.
- The coverage rule is conservative: all configured expected sources must report `ok`; missing/failed/disabled sources make coverage incomplete. Keep the expected-source list limited to sources actually enabled for that deployment, and expose each source's health in any future report.
- The two-window momentum calculation requires the same minimum number of sources in both windows. This reduces false acceleration caused by a newly added source, but it does not establish that a narrative refers to a particular token. Human-reviewed entity mapping remains mandatory.
- Recommendation: retain as a shadow evaluator; do not merge as a complete feature until source adapters, persistent observations, freshness/coverage reporting, mapping review, and historical false-positive tests exist.

### Wallet shadow PR #105

- The wallet evaluator requires supplied closed-token metrics and at least 80% data coverage; it is not a wallet-history provider. No currently verified source in this PR populates full cross-token closed positions, realized PnL, or win rate.
- The collector is BSC V2-pool-only and only for pools supplied by a caller. It stores transaction initiator observations, not beneficial-owner identities. Routers, relayers and smart accounts can make `transaction.from` differ from the end trader.
- The collector does not discover pools, calculate USD values, decode V3, or decode Solana transactions. It uses a bounded recent bootstrap and explicitly labels coverage as `observed_pool_only`.
- The PR documentation itself notes the absence of canonical block-hash checkpoints and same-height reorg rewind in this wallet collector. Finalized height is a strong boundary, but unattended collection should still have a tested canonical checkpoint/reconciliation strategy and visible gaps.
- Recommendation: do not label wallets as “Smart Money” from these observations. At most display “observed transaction initiator” and observed buy/sell counts for the exact monitored pools. Keep wallet-quality status `unknown` until full history and coverage are independently sourced.

### Four.meme scheduled observer PR #100

- The scheduled handler and Cron trigger are production-facing Worker/config changes even though the feature flag defaults off. A disabled-by-default test is useful but does not make the code documentation-only.
- Before considering merge/deployment, independently inspect the exact production diff, verify disabled mode causes no RPC/KV writes, verify opt-in configuration cannot be accidentally enabled, measure KV consumption and provider quota, and validate rollback behavior.
- The first enabled run anchors at the then-current finalized height and intentionally performs no historical backfill. The daily report must not imply that this gives complete historical coverage.

## Integration gate decision

At this stage, PR #106 is a documentation-only audit and its CI passed. Keep #100, #102, and #105 as Draft until their respective runtime, data-quality, coverage, and deployment gates are met. No external repository code has been copied into production, and no production deployment has been performed.


## User direction: combine the strongest ideas into future intelligence briefings

The user explicitly wants future intelligence/push reports to combine the useful strengths of the reviewed projects, not merely list seven repositories. Adopt ideas selectively by evidence value, portability, licensing, and operational safety.

### Adopt / reimplement

| Capability | Source inspiration | Decision and constraints |
|---|---|---|
| Multi-platform narrative heat | meme-narrative-radar | Adopt normalized topic observations, source freshness, source-health coverage, cross-source momentum and trend ranking. Reuse MIT code only with attribution; otherwise independently implement the schema. |
| Social/webhook candidate hints | X-monitor | Adopt only the sanitized inbound-hint concept (post URL/id, author handle, timestamp, text/media metadata). No cookies, session tokens, private keys, remote validator, or trading code. Source must be lawfully configured and its terms checked. |
| Multi-factor candidate research | meme-signal-monitor | Adopt the analysis dimensions: token metadata, market change, audit, deployer/project history, wallet cohort, and market-pattern context. Reimplement independently unless a clear license is obtained. Security gates remain hard vetoes, not weighted score inputs. |
| Wallet-flow observation | solana-meme-monitor + existing wallet shadow | Adopt bounded sampling, retry/failover, time windows, and cohort labels. Keep chain-specific decoders and finality rules. Never call an observed transaction initiator a proven beneficial owner. |
| Four.meme event verification | fourmeme_newcoin_monitor | Keep only the idea of a secondary listing/ticker cross-check. The authoritative signal remains finalized on-chain TokenManager2 events and verified migrated pool state. |
| Public market presentation | TIGER-POWER-Terminal | Adopt only a clean read-only market/flow presentation concept. No wallet login, account connection, transfers, signatures, order entry, or auto-trading. |
| BSC fast event scanning | BSC- PR | Reuse only independently verified read-only event-decoding ideas where useful. No sniper, private-key, copy-trading, or transaction-submission code. |

### Evidence hierarchy for the combined daily intelligence report

1. **Chain truth (highest authority):** finalized creation/migration/swap events, verified factory/pool/token addresses, canonical quote-token contract, RPC block/finality evidence.
2. **Independent market confirmation:** at least two independent market-data sources where available; compare liquidity, price, volume, buys/sells and pair age. Disagreement is shown, not averaged away blindly.
3. **Security and liquidity hard gates:** sellability/honeypot checks, owner permissions, taxes, holder concentration, LP state and liquidity trend. Unknown means review, never pass.
4. **Wallet/flow context:** early-buyer cohort, repeat participation, observed buy/sell balance, retention/exit and known watch-address interactions. Label coverage and attribution limits; never let a whale label bypass safety.
5. **Narrative and social attention:** cross-platform topic momentum, engagement/rank changes, source breadth and freshness. Narrative is a discovery/priority hint, not proof of token identity or safety.
6. **Human-readable context:** project links, official announcements, community discussion and notable uncertainty. Separate facts, interpretations and hypotheses.

### Source roles and current API caveats

- Keep GeckoTerminal, DexScreener and DexPaprika as complementary market-data providers rather than treating one as universal truth. Their endpoints, rate limits, latency and availability must be measured and cooldowns preserved.
- DexScreener's current API reference distinguishes pair/token endpoints (300 requests/minute) from profile/boost/order endpoints (60 requests/minute). Profiles, boosts and paid promotion signals may surface attention, but paid boosts must be explicitly labelled as promotion and must never be treated as organic demand or safety evidence.
- GeckoTerminal's official support page currently describes its public API as beta with a 30 calls/minute free limit. Plan request budgets accordingly and surface cooldowns/partial coverage.
- DexPaprika's current pricing page lists a free API-key tier with 100K credits/month and 30 requests/minute; its free tier has data-freshness limitations relative to paid plans. Do not assume the old unkeyed endpoint is an unlimited production fallback.
- X and Reddit must not be treated as free, unrestricted firehoses. Use only supported, authorized API access or a user-configured lawful feed; honor platform policy, approval, authentication and limits. If no lawful stable feed is available, report social coverage as unavailable rather than scraping around restrictions.

### Report behavior

- Produce one merged report with chain-separated candidates, age buckets (<1h, 1–6h, 6–24h), ranked evidence, and explicit pass/review/reject reasons.
- Each candidate should include source provenance, timestamps, source freshness, coverage, quote-token contract, pool/token identity, liquidity/volume/trade windows, safety evidence, wallet-flow caveats, narrative references and direct explorer/DEX links.
- De-duplicate by chain + token contract + pool address, not symbol/name. A symbol collision must never merge two tokens.
- Show source disagreements and unavailable sources. A provider outage, rate limit, disabled integration, or missing history must never be presented as “zero activity” or “no new tokens.”
- Distinguish organic market activity from paid boosts/ads, influencer claims, and unverified community reports.
- Keep a strict read-only boundary. No wallet connection, private key, signing, transfer, order placement, automated buy/sell, or trade execution.
- No scheduled push is active merely because this design is documented. Enable delivery only after the report has passed data-quality, coverage, security and false-positive validation, with explicit user-facing deployment confirmation.
