# 多链 Meme Radar（PWA）

只读观察工具，用于发现 BSC、Solana、Ethereum、Base 的早期新池线索。不会自动交易，不需要钱包私钥、助记词或交易所 API Key。

## 当前功能
- 覆盖链：BSC、Solana、Ethereum、Base。
- 默认观察窗口：最近 15 分钟，可切换 30 / 60 分钟。
- 默认最低流动性：约 5,000 USD。
- 排序：优先池龄最新；同等池龄参考成交量。
- BSC：使用 NodeReal RPC 扫描已配置的 V2/V3 DEX 工厂，仅筛选 BSC USDT 直连池。
- Solana：使用 GeckoTerminal public API 的 new_pools 索引，并以 DexScreener / DexPaprika 作为有限备用源；当索引源失败或没有合格池时，使用 Solana JSON-RPC 做独立交叉检查。当前仅对 Raydium CPMM initialize 指令实现协议级解码，并核验池账户程序归属、双侧 Vault Token 程序和 Mint 关联；其他已知协议仍只输出活动线索，不生成候选。
- Ethereum / Base：优先使用 GeckoTerminal 索引；索引源无合格池或失败时，可选使用独立 RPC 扫描配置的 Uniswap V2 工厂稳定币直连池（Ethereum: USDT/USDC/DAI；Base: USDC/USDbC/USDT）。该 RPC 兜底仅覆盖一个 V2 工厂，不是全链新池索引。
- 其他链索引结果显示报价资产符号，但**不代表钱包兑换路径已验证**。
- 前端合并 BSC 与其他三链结果，并按池龄排序。
- 每条链每轮最多对最早的 5 个候选执行安全检查；通过的进入候选列表，明确高危的进入拦截区，检测失败或信息不完整的进入待复核区。未检查的候选不会进入通过筛查列表。

## “牛来”历史案例：只提取走势结构，不照搬结果
参考合约：`0xbeea1d618e533a387d941f58a7d4c9b7bd377777`（BNB Chain，牛来）。公开复盘资料描述其生命周期：部署/迁移阶段约 4.5 万美元市值；8 月 15 日早段首次达到约 50 万美元；当日 19:00 左右突破约 500 万美元；8 月 16 日凌晨突破约 2,000 万美元；随后接近 5,000 万美元并在高位出现回撤。该案例说明值得监控的不是单点涨幅，而是“早期启动 → 成交与注意力同步扩张 → 多阶段放量突破 → 高位分歧/回撤”的序列。以上为公开复盘中的历史节点，不代表本项目已独立重建逐笔成交。
- 本项目把可从链上行情验证的部分转成：5分钟成交量相对前15分钟基准、5分钟价格加速度、近10根K线持续性、买卖平衡、流动性变化、从局部高点回撤。
- 不把外部社媒热度/KOL发文时间伪装成链上信号；未来若接入可审计的社媒数据源，单独展示来源与时间戳。
- 不把“牛来”当成安全合约模板。公开数据源对其持币集中度和 LP 保护结论存在差异；部分资料显示前十持币约 84%–89%、最大单一账户约 41.75%，另有资料显示 LP 未锁定或保护证据不完整。因此历史上涨表现不能抵消合约、持币集中度和 LP 风险。
- 牛来是事后成功样本，存在幸存者偏差。本评分必须同时用暴涨失败样本、慢涨样本、横盘样本做回测，避免只拟合一个赢家。

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
- [Meme Radar 开源版](https://github.com/nhovongoc0-max/meme-radar)：AGPL-3.0；参考其多维风险证据、限额/退避、缺失字段保留未知，以及通过组与拒绝组的多时间窗影子表现评估思路。本仓库不复制其源码；若未来考虑引入代码，先评估 AGPL-3.0 对网络服务和衍生作品的开源义务。
- 后续如需引入具体代码，只从许可证明确允许的项目引入，并保留版权声明、许可证文本和来源说明；无许可证仓库仅借鉴通用思路，不搬运实现。
- 后续验证方向：按合约地址记录通过组与拒绝组在 5m / 15m / 30m / 1h / 2h / 6h / 24h 的影子价格表现，单独报告可用样本数与缺失数；样本不足时不调权重、不宣称策略有效。

## 牛来案例带来的筛选启发
GMGN 在 2026-09-07 发布的牛来复盘记录了一个值得学习的反例：代币创建时间早于叙事热度爆发；后续快照中 Top 10 占比约 17.33%，但剔除池子/交易所地址后 Top 100 累计仍约 54.39%；最早 70 名买家中 65 名已全部卖出，另有部分持仓地址的筹码并非通过买入取得。该案例说明：
- 不能只看涨幅、Top 10 或买入笔数；必须逐步补充 Top 100 集中度、池子/交易所地址排除、转入筹码识别。
- 观察最早买家队列的持仓保留率和退出速度；早期买家集中清仓是重要的分配/卖压信号。
- 识别同名代币与同一开发者连续发币；名称、图标和叙事不能替代合约地址身份。
- 开发者历史、钱包共同资金来源和协调买入应作为后续深度审计项，而不是用简单买卖次数推断“聪明钱”。
- 这些是历史案例中的观测，不代表同样形态必然复现，也不能把事后成功币的特征当成确定性预测规则。
参考：[GMGN《牛来这样的热门 Meme 币，发现之后要核查什么？》](https://gmgn.ai/blog/zh-cn/what-to-check-after-finding-a-trending-memecoin/)

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


## 早期钱包行为观察（PR #41）
- 通过 GeckoTerminal pool trades 索引样本统计独立买家、卖家、重复买家、买卖双向钱包和前三大买家成交额占比。
- 样本少于 8 笔时标记为 insufficient，不输出健康判断。
- 前三大买家占买入额至少 60%、样本只有买入没有卖出、或重复买家占比较高时给出观察提醒。
- 不将钱包地址相同解释为同一控制人，不猜测开发者钱包或关联钱包；识别关联资金需要额外链上资金流证据。
- 索引数据有限、可能限流或缺失；钱包行为指标只作为走势质量补充，不覆盖合约安全门槛，也不触发自动交易。


## Solana RPC 独立活动交叉检查（PR #42）
- 当 GeckoTerminal 没有返回符合条件的池或请求失败时，Worker 会使用 `SOLANA_RPC_URL`（未配置时使用 Solana 公共主网 RPC）抽样检查 Pump.fun、PumpSwap、Raydium AMM v4、Raydium CPMM、Meteora DLMM 和 Orca Whirlpool 程序的近期交易。
- 每个程序最多查询最近 20 条签名，并最多抽样读取 1 笔交易；单轮最多约 12 次 RPC 请求。诊断会显示扫描程序数、窗口内交易数、抽样交易数、SPL Mint 初始化线索和池初始化日志线索。
- 这不是完整 Solana 新池索引：目前没有完成各协议的账户布局/指令解码、池地址与 token side 识别、创建时间核验、vault 储备/流动性计算。因此 `candidatePoolsAdded` 固定为 0，Mint/日志线索只用于诊断，不进入原始池数、候选排名或安全通过列表。
- 要把 RPC 交易线索升级成真实候选，必须逐协议实现并测试池创建指令解码、池账户归属、mint/vault 关联和链上储备读取；未完成前不能用交易签名或 Mint 初始化事件伪装成新池。
- Solana RPC 429/402 触发共享边缘冷却，避免连续刷新重复请求；5xx 最多重试一次，仍失败则进入短冷却。DexScreener/DexPaprika/GeckoTerminal 的 5xx 也会进入冷却。冷却是限流保护，不代表上游服务恢复。
- 推荐在 Cloudflare Worker Secret 中配置自己的 `SOLANA_RPC_URL`，以减少公共节点限流；不要把含密钥的 RPC URL 提交到仓库或聊天中。
- 已知程序 ID 参考：[Raydium 官方程序地址文档](https://github.com/raydium-io/raydium-docs-v1/blob/main/reference/program-addresses.mdx)、[Solana DEX/Launchpad 指令与程序目录](https://github.com/mahfuz67/solana-stream-skill/blob/main/skill/resources.md)。上线前仍需复核官方地址与指令版本。


## Raydium CPMM 协议级新池解码（PR #43）
- 当 Solana 索引源失败，或返回 HTTP 200 但没有合格池时，独立 RPC 交叉检查仍会运行，避免把空索引页误认为没有新池。
- 当前仅解码 Raydium CPMM `initialize` 指令，使用官方 `raydium-io/raydium-idl` 中的指令 discriminator 和账户顺序；检查交易成功状态、创建时间窗口、pool_state owner、两个 vault 的 Token 程序 owner，以及每个 vault 的 Mint 是否与初始化指令的 token_0/token_1 mint 对应。
- 单轮最多读取 4 笔 Raydium CPMM 近期交易，并最多执行 3 组池/Vault 账户核验；与其他程序抽样合计限制 RPC 请求量，429/402 仍触发共享冷却。
- 仅当池子恰好包含一个已识别 USDC/USDT 报价 Mint，且稳定币侧储备×2估算值达到最低流动性门槛时，才加入新池观察列表。此估算不是可成交深度、真实总锁仓价值或钱包兑换路径验证。
- 新候选的成交量、买卖笔数、K线、钱包流向和卖出能力仍标记为不可用/待复核；不会因为链上池账户解码成功就进入安全通过名单。
- Pump.fun bonding curve、PumpSwap、Raydium AMM v4、Meteora DLMM、Orca Whirlpool 仍未生成 RPC 候选；不能把它们的程序活动日志或 Mint 初始化线索冒充真实池。
- 依据：[Raydium 官方 CPMM IDL](https://github.com/raydium-io/raydium-idl/blob/master/raydium_cpmm/raydium_cp_swap.json)、[Raydium CPMM 初始化源码](https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/instructions/initialize.rs)。本项目只按其公开接口解码链上数据，不复制其实现代码。
