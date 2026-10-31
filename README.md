# 多链 Meme Radar（PWA）

只读观察工具，不会自动交易，不需要钱包私钥、助记词或交易所 API Key。

## 当前升级目标
- 链：BSC、Solana、Ethereum、Base
- 排序：优先池龄最新的候选；同等池龄下参考成交量
- 最低流动性：默认约 5,000 USD
- 资金偏好：USDT 直接交易优先，也计划支持通过钱包路由兑换
- 观察窗口：15 / 30 / 60 分钟

## 当前实现状态（首阶段）
- BSC：保留原有 NodeReal RPC + 已配置 V2/V3 DEX 工厂扫描。
- Solana / Ethereum / Base：新增 `/multiscan`，使用 GeckoTerminal public API 的 new_pools 数据。
- 前端：同时请求 BSC `/scan` 和其他三链 `/multiscan`，按池龄从新到旧排序。
- 前端每条链本轮最多对最早的 5 个候选执行安全检查；通过检查的进入主列表。检测到貔貅或严重风险的直接剔除；安全接口不可用、模拟失败、风险数据不完整或 LP 锁定信号不足的放入待复核区，不进入主列表。
- EVM 买卖模拟只覆盖 Honeypot.is 当前支持的 Ethereum、BSC、Base 和其支持的 DEX 路由；不能覆盖所有池型或所有恶意行为。Solana 使用 RugCheck 摘要风险和 LP 锁定信号。
- 这不是完整审计：目前尚未完成创建者/关联钱包历史、EVM 全量持币集中度、LP 锁仓合约可信度和实时流动性撤出监控。通过筛查不代表绝对安全。
- 其他三链的 USDT 路由：目前**尚未实时报价验证**；报价代币 symbol 显示 USDT 也不代表已通过合约地址核验或可成功成交。后续必须接入各链官方/可信 USDT 合约白名单和实际路由报价。
- GeckoTerminal 每条链本版本只取第一页（最多20个池）；公共 API 约每分钟10次调用、数据约每分钟缓存更新。频繁刷新可能触发限流，不保证捕获所有新池。

## 部署
1. Cloudflare Worker 使用仓库中的 `worker.js`，保留已配置的 `NODEREAL_RPC_URL` Secret。
2. GitHub Pages 发布仓库根目录的 `index.html`。
3. 手机浏览器打开 Pages 地址，可添加到主屏幕。

## 重要限制
- 当前 `/multiscan` 首阶段只覆盖 Solana、Ethereum、Base 的 GeckoTerminal new_pools 索引，不等于完整链上监听。
- 流动性、成交量、买卖次数和价格变化来自第三方索引，可能延迟、缺失或口径不同。
- BSC 现有接口仍有已接入 DEX 范围限制，V3 成交统计尚未完整接入。
- Honeypot.is 模拟及 RugCheck 摘要属于初步过滤，不是完整合约审计；EVM 持币集中度、创建者关联钱包和 LP 锁仓合约验证仍待实现。
- USDT 兑换路径必须逐条验证网络、代币合约、可执行报价、滑点和手续费；跨链兑换不等于每个代币都可买入。
- Worker 和网页公开可访问；不得放入私钥、助记词或交易密钥。

## API
- `/health`：服务状态
- `/scan?minutes=15&minLiquidity=5000`：BSC 原有扫描
- `/multiscan?minutes=15&minLiquidity=5000`：Solana、Ethereum、Base 首阶段新池扫描
- `/history?hours=24&dex=pancakeswap-v2`：BSC 单工厂历史验证
