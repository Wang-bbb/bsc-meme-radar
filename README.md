# BSC Meme 雷达（PWA MVP）

只读观察工具，不会自动交易，不需要钱包私钥、助记词或币安 API Key。

## 文件
- `index.html`、`manifest.json`、`sw.js`：手机 PWA 网页
- `worker.js`：Cloudflare Worker 行情代理与筛选 API

## 1. 配置网页 API 地址
部署 Worker 后，复制它的 HTTPS 地址。打开 `index.html`，找到：
`const API_BASE=localStorage.getItem("radar_api_base")||"";`
将空字符串改为 Worker 地址，例如：
`const API_BASE=localStorage.getItem("radar_api_base")||"https://你的worker地址.workers.dev";`
保存后再提交。

## 2. 部署 Cloudflare Worker
在 Cloudflare Dashboard → Workers & Pages → Create Worker，粘贴 `worker.js` 全部内容并 Deploy。复制 Worker URL。Worker 会请求 DexScreener 公共 API；外部 API 的可用性和速率限制可能变化。

## 3. 开启 GitHub Pages
仓库 Settings → Pages → Build and deployment → Source 选 Deploy from a branch；Branch 选 `main`，目录选 `/(root)`，点击 Save。GitHub Pages 会从仓库根目录的 `index.html` 发布网页。等待部署完成后打开页面。

## 4. vivo 手机安装
用手机浏览器打开 GitHub Pages 网站 → 浏览器菜单 → 添加到主屏幕/安装应用。

## 当前限制
- 候选来源是 DexScreener 最新 token profiles，不保证覆盖全部新池；每轮最多逐一查询 35 个候选。
- 只接受报价代币地址严格匹配 BSC USDT（`0x55d398326f99059ff775485246999027b319795`）的直接交易池，不把 USDC/WBNB 交易池算作 USDT。
- “有 USDT 交易对”不代表一定可以安全买卖。
- 当前只在应用打开时手动刷新；无后台持续扫描和自动推送。
- 未实现完整 honeypot 模拟、合约权限审计、持仓集中度或 LP 锁定检查；不能保证识别所有骗局。
- 公开网页与 Worker URL 可能被他人访问；不要放入任何私钥、助记词或交易所密钥。
