# 多链 Meme Radar（PWA）

只读观察工具，用于发现 BSC、Solana、Ethereum、Base 的早期新池线索。不会自动交易，不需要钱包私钥、助记词或交易所 API Key。

## 当前功能
- 覆盖链：BSC、Solana、Ethereum、Base。
- 默认观察窗口：最近 15 分钟，可切换 30 / 60 分钟。
- 默认最低流动性：约 5,000 USD。
- 排序：优先池龄最新；同等池龄参考成交量。
- BSC：使用 NodeReal RPC 扫描已配置的 V2/V3 DEX 工厂，仅筛选 BSC USDT 直连池。
- Solana：使用 GeckoTerminal public API 的 new_pools 索引，并以 DexScreener / DexPaprika 作为有限备用源。
- Ethereum / Base：优先使用 GeckoTerminal 索引；索引源无合格池或失败时，可选使用独立 RPC 扫描配置的 Uniswap V2 工厂稳定币直连池（Ethereum: USDT/USDC/DAI；Base: USDC/USDbC/USDT）。该 RPC 兜底仅覆盖一个 V2 工厂，不是全链新池索引。
- 其他链索引结果显示报价资产符号，但**不代表钱包兑换路径已验证**。
- 前端合并 BSC 与其他三链结果，并按池龄排序。
- 每条链每轮最多对最早的 5 个候选执行安全检查；通过的进入候选列表，明确高危的进入拦截区，检测失败或信息不完整的进入待复核区。未检查的候选不会进入通过筛查列表。

## 安全筛查范围与限制
- EVM 使用 Honeypot.is 买卖模拟及风险信号，覆盖范围受其支持的链、DEX 和交易路由限制。
- Solana 使用 RugCheck 风险摘要、权限和 LP 锁定信号。
- 通过筛查不代表绝对安全，也不是完整合约审计。
- 尚未完整实现：创建者及关联钱包历史、EVM 全量持币集中度、LP 锁仓合约可信度验证、持续监控流动性撤出。
- 安全数据不可用、模拟失败或信息不完整时，按待复核处理，不进入通过筛查列表。

## 数据覆盖限制
- GeckoTerminal 每条链当前只取 new_pools 第一页（最多 20 个池），不保证覆盖所有新池。
- 公共 API 可能限流；数据约每分钟缓存更新，频繁刷新可能触发 429。
- 多链流动性、成交量、买卖次数和价格变化来自第三方索引，可能延迟、缺失或存在统计口径差异。
- BSC 仅覆盖代码中配置的 DEX 工厂，不等于全 BSC DEX；流动性为估算值，V3 成交统计尚未接入。
- BSC USDT 直连池与其他链的钱包兑换路径是两回事；其他三链目前不提供 USDT 直连或可成交保证。

## 部署说明
1. Cloudflare Worker 使用仓库中的 `worker.js`，并在 Cloudflare Secret 中配置 `NODEREAL_RPC_URL`。
2. 为启用 Ethereum / Base 链上兜底扫描，可在 Cloudflare Dashboard → Workers & Pages → `younbsc-meme-radar` → Settings → Variables and Secrets 中分别添加 Secret：`ETH_RPC_URL`、`BASE_RPC_URL`。两者可分别配置，建议使用支持对应链 `eth_getLogs` 的 RPC 服务；不要把 RPC URL 或 API Key 提交到 GitHub 仓库或聊天中。
3. 未配置对应 Secret 时，该链仍尝试公共索引源，并在扫描诊断中明确标记 RPC fallback 未配置。
4. GitHub Pages 发布仓库根目录的 `index.html`。
5. 手机浏览器打开 Pages 地址，可添加到主屏幕。

Worker 和网页均可能公开访问；不得把私钥、助记词或交易密钥放入仓库、网页或 Worker 响应。

## API
- `/health`：服务状态
- `/scan?minutes=15&minLiquidity=5000`：BSC USDT 直连新池扫描
- `/multiscan?minutes=15&minLiquidity=5000`：Solana、Ethereum、Base 新池索引
- `/security-check?chain=...&address=...`：单个代币安全预检
- `/history?hours=24&dex=pancakeswap-v2`：BSC 单工厂历史验证
