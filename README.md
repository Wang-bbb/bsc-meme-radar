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

## 早期走势质量评分（与安全筛查分开）
- 新增 0–100 走势质量分，只用于候选观察排序，不是安全评分、买入信号或收益预测。
- 指标包含：最近 5 分钟成交量相对前 15 分钟基准的突增倍数、索引源近 1 小时买卖平衡、最近 5 分钟价格加速度、5 分钟流动性变化、池龄阶段。
- 走势数据不足时不强行打分；有效指标权重覆盖不足 60% 时显示“数据不足，暂不评分”，并展示数据完整度。
- 对异常放量、极端买卖失衡、过快价格加速和短时间流动性暴增给出提示；已有的急拉急跌、回撤、LP 流失拦截规则继续独立生效。
- 走势评分绝不覆盖合约安全状态：安全待复核/高危代币不会因为走势分高而进入通过名单。
- 买卖次数目前是索引源近 1 小时统计，不等于独立买家数量；当前版本尚未实现 Solana 资金来源聚类、开发者钱包卖出跟踪或完整的 wash-trading 识别。

## 参考项目与融合边界
- [J33T Intel](https://github.com/petershepherd/j33t-intel)：参考其多信号评分、交易时间聚类、开发者行为和历史回测思路（MIT）；本仓库未复制其源码。
- [Meme Sniper](https://github.com/galvinlam/meme-sniper)：参考候选状态机、买家质量和信号复盘的设计思路；该仓库未提供明确开源许可证，因此不复制其代码。
- [Meme Coin Radar](https://github.com/DelaneKay/Meme-Coin-Radar)：参考买卖失衡、成交量突增、价格加速度的指标设计；仓库未找到明确 LICENSE 文件，因此只参考公开方法描述，不复制源码。
- 后续如需引入具体代码，只从许可证明确允许的项目引入，并保留版权声明、许可证文本和来源说明；无许可证仓库仅借鉴通用思路，不搬运实现。

## 安全筛查范围与限制
- EVM 使用 Honeypot.is 买卖模拟及风险信号，覆盖范围受其支持的链、DEX 和交易路由限制。
- Solana 使用 RugCheck 风险摘要、持币/LP 锁定信号，并独立通过 Solana JSON-RPC 读取 Mint / Freeze Authority 与 Token-2022 扩展；链上证据缺失、未知扩展或权限仍有效时进入待复核。
- 通过筛查不代表绝对安全，也不是完整合约审计。
- 尚未完整实现：创建者及关联钱包历史、EVM 全量持币集中度、Solana 按持有人归并后的链上集中度、LP 锁仓合约可信度验证、持续监控流动性撤出。Solana Token-2022 当前对已识别扩展做风险提示；未知扩展不会当作安全通过。
- 安全数据不可用、模拟失败或信息不完整时，按待复核处理，不进入通过筛查列表。

## 数据覆盖限制
- GeckoTerminal 每条链当前只取 new_pools 第一页（最多 20 个池），不保证覆盖所有新池。
- 公共 API 可能限流；数据约每分钟缓存更新，频繁刷新可能触发 429。
- 多链流动性、成交量、买卖次数和价格变化来自第三方索引，可能延迟、缺失或存在统计口径差异。
- BSC 仅覆盖代码中配置的 DEX 工厂，不等于全 BSC DEX；流动性为估算值，V3 成交统计尚未接入。
- BSC USDT 直连池与其他链的钱包兑换路径是两回事；其他三链目前不提供 USDT 直连或可成交保证。

## 部署说明
1. Cloudflare Worker 使用仓库中的 `worker.js`，并在 Cloudflare Secret 中配置 `NODEREAL_RPC_URL`。Solana 链上安全检查默认使用 Solana 公共 JSON-RPC；建议在 Cloudflare Secret 中额外配置 `SOLANA_RPC_URL`，指向你自己的可靠 Solana RPC 服务，以降低公共节点限流概率。
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
