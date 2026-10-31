const USDT = "0x55d398326f99059ff775485246999027b319795";
const USDT_TOPIC = "0x" + USDT.slice(2).toLowerCase().padStart(64, "0");
const FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865";
const V2_FACTORIES = [
  { name: "PancakeSwap V2", dexId: "pancakeswap", address: FACTORY },
  { name: "Biswap V2", dexId: "biswap", address: "0x858e3312ed3a876947ea49d572a7c42de08af7ee" },
  { name: "ApeSwap V2", dexId: "apeswap", address: "0x0841bd0b734e4f5853f0dd8d7ea041c241fb0da6" },
  { name: "MDEX V2", dexId: "mdex", address: "0x9a272d734c5a0d7d84e0a892e891a553e8066dce" },
  { name: "BabySwap V2", dexId: "babyswap", address: "0x86407bea2078ea5f5eb5a52b2caa963bc1f889da" },
  { name: "Nomiswap V2", dexId: "nomiswap", address: "0xd6715a8be3944ec72738f0bfdc739d48c3c29349" }
];
const V3_FACTORIES = [
  { name: "PancakeSwap V3", dexId: "pancakeswap-v3", address: V3_FACTORY },
  { name: "Uniswap V3", dexId: "uniswap-v3", address: "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7" }
];
const V3_POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "cache-control": "no-store"
};
const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: HEADERS });

async function fetchGeckoTerminal(endpoint) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(endpoint, { method: "GET" });
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch (_) {}
  }

  let lastResponse;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(endpoint, {
      headers: { "accept": "application/json;version=20230203" }
    });
    // Do not immediately retry rate-limited public APIs: cache the 429 briefly
    // so repeated mobile refreshes do not amplify provider throttling.
    if (response.status === 429) {
      if (cache) {
        const headers = new Headers(response.headers);
        headers.set("cache-control", "public, max-age=15");
        try {
          await cache.put(cacheKey, new Response(response.clone().body, {
            status: response.status, statusText: response.statusText, headers
          }));
        } catch (_) {}
      }
      return response;
    }
    if (response.status < 500) {
      if (response.ok && cache) {
        const headers = new Headers(response.headers);
        headers.set("cache-control", "public, max-age=60");
        try {
          await cache.put(cacheKey, new Response(response.clone().body, {
            status: response.status,
            statusText: response.statusText,
            headers
          }));
        } catch (_) {}
      }
      return response;
    }
    lastResponse = response;
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      const delay = Math.min(5000, Math.max(retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1), 500));
      await new Promise((resolve) => setTimeout(resolve, delay));
    } else {
      break;
    }
  }
  return lastResponse || new Response("GeckoTerminal request failed", { status: 502 });
}

async function fetchDexPaprikaJson(endpoint) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(endpoint, { method: "GET" });
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch (_) {}
  }
  const response = await fetch(endpoint, { headers: { "accept": "application/json" } });
  if (cache && (response.ok || response.status === 429)) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "public, max-age=" + (response.status === 429 ? 15 : 60));
    try {
      await cache.put(cacheKey, new Response(response.clone().body, {
        status: response.status, statusText: response.statusText, headers
      }));
    } catch (_) {}
  }
  return response;
}

async function fetchDexScreenerJson(endpoint) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(endpoint, { method: "GET" });
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch (_) {}
  }
  const response = await fetch(endpoint, { headers: { "accept": "application/json" } });
  if (response.status === 429 && cache) {
    // Briefly cache rate-limit responses to prevent each chain fallback from
    // hammering the same shared profile/boost feeds on every refresh.
    const headers = new Headers(response.headers);
    headers.set("cache-control", "public, max-age=15");
    try {
      await cache.put(cacheKey, new Response(response.clone().body, {
        status: response.status, statusText: response.statusText, headers
      }));
    } catch (_) {}
    return response;
  }
  if (response.ok && cache) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "public, max-age=60");
    try {
      await cache.put(cacheKey, new Response(response.clone().body, {
        status: response.status, statusText: response.statusText, headers
      }));
    } catch (_) {}
  }
  return response;
}

const VERIFIED_QUOTE_ASSETS = {
  solana: new Set([
    "so11111111111111111111111111111111111111112",
    "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",
    "es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb"
  ]),
  eth: new Set([
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f"
  ]),
  base: new Set([
    "0x4200000000000000000000000000000000000006",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"
  ])
};
function choosePoolToken(networkId, base, quote, baseId, quoteId) {
  const canonicalQuotes = VERIFIED_QUOTE_ASSETS[networkId] || new Set();
  const baseAddress = String(base.address || (baseId || "").split("_").slice(1).join("_"));
  const quoteAddress = String(quote.address || (quoteId || "").split("_").slice(1).join("_"));
  const isBaseQuote = canonicalQuotes.has(baseAddress.toLowerCase());
  const isQuoteQuote = canonicalQuotes.has(quoteAddress.toLowerCase());
  if (isBaseQuote && isQuoteQuote) return { skip: true, reason: "交易池两侧均为已知主流报价资产" };
  if (isBaseQuote !== isQuoteQuote) {
    return {
      address: isBaseQuote ? quoteAddress : baseAddress,
      symbol: isBaseQuote ? quote.symbol : base.symbol,
      name: isBaseQuote ? quote.name : base.name,
      verified: true,
      side: isBaseQuote ? "quote" : "base"
    };
  }
  return { address: baseAddress, symbol: base.symbol, name: base.name, verified: false, side: "base-ambiguous" };
}

async function rpc(method, params, rpcUrl) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error("BSC RPC HTTP " + response.status);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 700 * Math.pow(2, attempt)));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) throw new Error("BSC RPC HTTP " + response.status);
      const body = await response.json();
      if (body.error) throw new Error("BSC RPC " + body.error.code + ": " + body.error.message);
      return body.result;
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !/429|fetch failed|network|timeout/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700 * Math.pow(2, attempt)));
    }
  }
  throw lastError || new Error("BSC RPC request failed");
}

const hexNum = (n) => "0x" + Math.max(0, n).toString(16);
const fromTopic = (topic) => "0x" + topic.slice(-40).toLowerCase();
const word = (data, index) => data.slice(2 + index * 64, 2 + (index + 1) * 64);
const asNumber = (hex) => Number(BigInt(hex || "0x0"));
const toFloat = (value, decimals) => Number(value) / Math.pow(10, decimals);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { _error: String(e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function decodeAbiString(hex) {
  if (!hex || hex === "0x") return "";
  try {
    const data = hex.slice(2);
    let offset = 0;
    if (data.length === 64) {
      const bytes = data.match(/.{2}/g).map((x) => parseInt(x, 16)).filter((x) => x !== 0);
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
    offset = Number(BigInt("0x" + data.slice(0, 64))) * 2;
    const length = Number(BigInt("0x" + data.slice(offset, offset + 64)));
    const start = offset + 64;
    const bytes = data.slice(start, start + length * 2).match(/.{2}/g) || [];
    return new TextDecoder().decode(new Uint8Array(bytes.map((x) => parseInt(x, 16))));
  } catch (_) { return ""; }
}

async function blockTime(blockNumber, cache, rpcUrl) {
  if (cache.has(blockNumber)) return cache.get(blockNumber);
  const block = await rpc("eth_getBlockByNumber", [hexNum(blockNumber), false], rpcUrl);
  const time = block ? asNumber(block.timestamp) * 1000 : 0;
  cache.set(blockNumber, time);
  return time;
}

async function readV3Pool(log, createdAt, rpcUrl) {
  const token0 = fromTopic(log.topics[1]);
  const token1 = fromTopic(log.topics[2]);
  const fee = asNumber(log.topics[3]);
  const pair = "0x" + word(log.data, 1).slice(-40).toLowerCase();
  const usdtIs0 = token0 === USDT.toLowerCase();
  const token = usdtIs0 ? token1 : token0;
  const balanceCall = await rpc("eth_call", [{
    to: USDT,
    data: "0x70a08231" + pair.slice(2).toLowerCase().padStart(64, "0")
  }, "latest"], rpcUrl);
  const usdtReserve = toFloat(BigInt(balanceCall || "0x0"), 18);
  const safeCall = (data) => rpc("eth_call", [{ to: token, data }, "latest"], rpcUrl).catch(() => "0x");
  const [symbolHex, nameHex, decimalsHex] = await Promise.all([
    safeCall("0x95d89b41"), safeCall("0x06fdde03"), safeCall("0x313ce567")
  ]);
  const decimals = decimalsHex && decimalsHex !== "0x" ? Math.min(36, Math.max(0, asNumber(decimalsHex))) : 18;
  return {
    pair, token0, token1, tokenAddress: token,
    symbol: decodeAbiString(symbolHex) || token.slice(0, 6) + "…" + token.slice(-4),
    name: decodeAbiString(nameHex) || "Unknown token",
    decimals, usdtReserve, liquidityUSD: usdtReserve * 2,
    createdBlock: asNumber(log.blockNumber), createdAt,
    createdTx: log.transactionHash, usdtIs0, fee
  };
}

async function readPair(log, rpcUrl) {
  const token0 = fromTopic(log.topics[1]);
  const token1 = fromTopic(log.topics[2]);
  const pair = "0x" + word(log.data, 0).slice(-40).toLowerCase();
  const usdtIs0 = token0 === USDT.toLowerCase();
  const token = usdtIs0 ? token1 : token0;
  const safeCall = (data) => rpc("eth_call", [{ to: token, data: data }, "latest"], rpcUrl).catch(() => "0x");
  const calls = await Promise.all([
    rpc("eth_call", [{ to: pair, data: "0x0902f1ac" }, "latest"], rpcUrl),
    safeCall("0x95d89b41"),
    safeCall("0x06fdde03"),
    safeCall("0x313ce567")
  ]);
  const reserve0 = BigInt("0x" + word(calls[0], 0));
  const reserve1 = BigInt("0x" + word(calls[0], 1));
  const usdtReserve = toFloat(usdtIs0 ? reserve0 : reserve1, 18);
  const decimals = calls[3] && calls[3] !== "0x" ? Math.min(36, Math.max(0, asNumber(calls[3]))) : 18;
  return {
    pair: pair,
    token0: token0,
    token1: token1,
    tokenAddress: token,
    symbol: decodeAbiString(calls[1]) || token.slice(0, 6) + "…" + token.slice(-4),
    name: decodeAbiString(calls[2]) || "Unknown token",
    decimals: decimals,
    usdtReserve: usdtReserve,
    liquidityUSD: usdtReserve * 2,
    createdBlock: asNumber(log.blockNumber),
    createdTx: log.transactionHash,
    usdtIs0: usdtIs0
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rpcUrl = env.NODEREAL_RPC_URL;
    if (request.method === "OPTIONS") return new Response(null, { headers: HEADERS });
    if (!rpcUrl && ["/scan", "/history"].includes(url.pathname)) {
      return json({ ok: false, error: "Missing NODEREAL_RPC_URL secret" }, 500);
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "BSC Meme Radar API", worker: "running", chain: "BSC", dataSource: "NodeReal BSC RPC + multiple BSC DEX factories", supportedMinutes: [15, 30, 60], note: "只读监控；扫描已接入的 BSC DEX USDT 池" });
    }
    if (url.pathname === "/history") {
      const hours = Number(url.searchParams.get("hours") || 24);
      if (![6, 12, 24].includes(hours)) return json({ ok: false, error: "hours must be 6, 12, or 24" }, 400);
      const allFactories = [
        ...V2_FACTORIES.map((factory) => ({ ...factory, version: "v2", topic: PAIR_CREATED, key: factory.dexId + "-v2" })),
        ...V3_FACTORIES.map((factory) => ({ ...factory, version: "v3", topic: V3_POOL_CREATED, key: factory.dexId }))
      ];
      const dexKey = url.searchParams.get("dex") || "pancakeswap-v2";
      const factory = allFactories.find((item) => item.key === dexKey);
      if (!factory) return json({
        ok: false,
        error: "Unknown dex",
        supportedDex: allFactories.map((item) => ({ key: item.key, name: item.name }))
      }, 400);
      try {
        const latestHex = await rpc("eth_blockNumber", [], rpcUrl);
        const latest = asNumber(latestHex);
        const latestBlock = await rpc("eth_getBlockByNumber", [latestHex, false], rpcUrl);
        const latestTime = asNumber(latestBlock.timestamp) * 1000;
        const sampleBlock = await rpc("eth_getBlockByNumber", [hexNum(Math.max(0, latest - 1000)), false], rpcUrl);
        const elapsed = latestTime - asNumber(sampleBlock.timestamp) * 1000;
        const secondsPerBlock = elapsed > 0 ? elapsed / 1000000 : 0.5;
        const targetBlocks = Math.ceil(hours * 3600 / secondsPerBlock * 1.08);
        const fromBlock = Math.max(0, latest - targetBlocks);
        // One DEX per invocation and 8,000-block chunks keep RPC subrequests below Worker limits.
        const chunkSize = 8000;
        const chunks = [];
        for (let start = fromBlock; start <= latest; start += chunkSize) {
          chunks.push({ fromBlock: start, toBlock: Math.min(latest, start + chunkSize - 1) });
        }
        const results = await mapLimit(chunks, 2, async (chunk) => {
          const logs = await rpc("eth_getLogs", [{
            fromBlock: hexNum(chunk.fromBlock),
            toBlock: hexNum(chunk.toBlock),
            address: factory.address,
            topics: [factory.topic]
          }], rpcUrl);
          const usdtLogs = logs.filter((log) =>
            fromTopic(log.topics[1] || "") === USDT.toLowerCase() ||
            fromTopic(log.topics[2] || "") === USDT.toLowerCase()
          );
          return { chunk, logs, usdtLogs };
        });
        const failedChunks = results.filter((item) => item && item._error);
        const successfulChunks = results.filter((item) => item && !item._error);
        const allLogs = successfulChunks.flatMap((item) => item.logs);
        const usdtLogs = successfulChunks.flatMap((item) => item.usdtLogs);
        const uniqueUsdt = new Map();
        for (const log of usdtLogs) {
          const token0 = fromTopic(log.topics[1] || "");
          const token1 = fromTopic(log.topics[2] || "");
          const poolAddress = factory.version === "v2"
            ? "0x" + word(log.data, 0).slice(-40).toLowerCase()
            : "0x" + word(log.data, 1).slice(-40).toLowerCase();
          uniqueUsdt.set(poolAddress, {
            token0, token1, poolAddress,
            blockNumber: asNumber(log.blockNumber),
            transactionHash: log.transactionHash
          });
        }
        const complete = failedChunks.length === 0;
        return json({
          ok: complete,
          complete,
          mode: "historical-usdt-pool-validation",
          chain: "BSC",
          dex: factory.name,
          dexKey: factory.key,
          factoryAddress: factory.address,
          quoteToken: { symbol: "USDT", address: USDT },
          hours,
          fromBlock,
          latestBlock: latest,
          estimatedSecondsPerBlock: secondsPerBlock,
          chunkSize,
          chunksTotal: chunks.length,
          chunksScanned: successfulChunks.length,
          chunksFailed: failedChunks.length,
          eventCount: allLogs.length,
          usdtPoolEventCount: uniqueUsdt.size,
          sampleUsdtPools: Array.from(uniqueUsdt.values()).slice(0, 20),
          scanErrors: failedChunks.map((item) => ({ chunk: item.chunk, error: item._error })),
          limitations: [
            "本次只扫描一个 DEX 工厂，避免 Cloudflare Worker 单次请求次数超限。",
            "complete=false 时结果不完整，不能将当前 USDT 池数量视为完整统计。",
            "历史建池事件不代表池子当前仍有流动性或代币可正常卖出。",
            "USDT 配对通过精确合约地址识别，不依赖代币名称或 symbol。"
          ]
        });
      } catch (error) {
        return json({
          ok: false,
          complete: false,
          mode: "historical-usdt-pool-validation",
          dex: factory.name,
          error: String(error),
          hint: "历史验证失败不代表没有 USDT 池；请检查 RPC 限流或日志查询范围。"
        }, 502);
      }
    }
    if (url.pathname === "/security-check") {
      const chain = String(url.searchParams.get("chain") || "").toLowerCase();
      const address = String(url.searchParams.get("address") || "").trim();
      const pair = String(url.searchParams.get("pair") || "").trim();
      if (!address) return json({ ok: false, status: "unverified", error: "missing token address" }, 400);
      try {
        if (chain === "solana") {
          const response = await fetch("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(address) + "/report", { headers: { "accept": "application/json" } });
          if (!response.ok) throw new Error("RugCheck HTTP " + response.status);
          const report = await response.json();
          const risks = Array.isArray(report.risks) ? report.risks : [];
          const critical = risks.filter((risk) => ["danger", "critical"].includes(String(risk.level || "").toLowerCase()));
          const warnings = risks.filter((risk) => ["high", "medium", "caution", "warn", "warning", "info"].includes(String(risk.level || "").toLowerCase()));
          const hasUsableReport = !!report.tokenProgram || risks.length > 0 || report.score_normalised != null || report.lpLockedPct != null;
          const lpLockedPct = report.lpLockedPct == null || !Number.isFinite(Number(report.lpLockedPct))
            ? null : Number(report.lpLockedPct);
          const weakLiquidityLock = lpLockedPct !== null && lpLockedPct < 80;
          const unknownLiquidityLock = lpLockedPct === null;
          const rugged = report.rugged === true;
          const mintAuthority = report.mintAuthority ?? report.token?.mintAuthority ?? null;
          const freezeAuthority = report.freezeAuthority ?? report.token?.freezeAuthority ?? null;
          const authorityFieldsPresent = Object.prototype.hasOwnProperty.call(report, "mintAuthority") ||
            Object.prototype.hasOwnProperty.call(report, "freezeAuthority") ||
            Object.prototype.hasOwnProperty.call(report.token || {}, "mintAuthority") ||
            Object.prototype.hasOwnProperty.call(report.token || {}, "freezeAuthority");
          const activeAuthorities = mintAuthority != null || freezeAuthority != null;
          const unknownAuthorities = !authorityFieldsPresent;
          const status = rugged || critical.length ? "blocked" : (!hasUsableReport || warnings.length || weakLiquidityLock || unknownLiquidityLock || activeAuthorities || unknownAuthorities) ? "review" : "pass";
          return json({
            ok: true, chain, tokenAddress: address, provider: "RugCheck",
            status, riskScore: report.score_normalised ?? null, lpLockedPct,
            liquidityLockStatus: unknownLiquidityLock ? "unknown" : weakLiquidityLock ? "below_threshold" : "meets_threshold",
            risks: risks.map((risk) => ({ name: risk.name, level: risk.level, value: risk.value, description: risk.description })),
            reasons: [...(rugged ? ["RugCheck 标记该代币已发生 Rug"] : []), ...critical.map((x) => x.name), ...warnings.map((x) => x.name), ...(!hasUsableReport ? ["RugCheck 报告信息不足"] : []), ...(weakLiquidityLock ? ["已报告的流动性锁定比例低于80%"] : []), ...(unknownLiquidityLock ? ["流动性锁定数据缺失，无法确认；不代表已确认未锁定"] : []), ...(activeAuthorities ? ["Mint 或 Freeze Authority 仍有效"] : []), ...(unknownAuthorities ? ["Mint / Freeze Authority 状态缺失，无法确认"] : [])],
            note: "RugCheck 摘要只覆盖其报告中的链上风险信号；不等于完整审计或实际买卖模拟。"
          });
        }
        const chainIds = { ethereum: 1, eth: 1, bsc: 56, base: 8453 };
        const chainID = chainIds[chain];
        if (!chainID) return json({ ok: false, status: "unverified", error: "unsupported chain" }, 400);
        const params = new URLSearchParams({ address, chainID: String(chainID) });
        if (pair) params.set("pair", pair);
        const response = await fetch("https://api.honeypot.is/v2/IsHoneypot?" + params.toString(), { headers: { "accept": "application/json" } });
        if (!response.ok) throw new Error("Honeypot.is HTTP " + response.status);
        const report = await response.json();
        const simulation = report.simulationResult || {};
        const flags = Array.isArray(report.summary?.flags) ? report.summary.flags : [];
        const criticalFlags = flags.filter((x) => ["critical", "danger"].includes(String(x.severity || "").toLowerCase()));
        const highFlags = flags.filter((x) => ["high", "medium", "warning", "warn"].includes(String(x.severity || "").toLowerCase()));
        const isHoneypot = report.honeypotResult?.isHoneypot === true;
        const riskLevel = report.summary?.riskLevel != null && Number.isFinite(Number(report.summary.riskLevel)) ? Number(report.summary.riskLevel) : null;
        const buyTax = simulation.buyTax != null && Number.isFinite(Number(simulation.buyTax)) ? Number(simulation.buyTax) : null;
        const sellTax = simulation.sellTax != null && Number.isFinite(Number(simulation.sellTax)) ? Number(simulation.sellTax) : null;
        const simOK = report.simulationSuccess === true && report.honeypotResult && typeof report.honeypotResult.isHoneypot === "boolean";
        const hardRisk = isHoneypot || (riskLevel !== null && riskLevel >= 80) ||
          (sellTax !== null && sellTax >= 20) || (buyTax !== null && buyTax >= 30) || criticalFlags.length > 0;
        const reviewRisk = !simOK || riskLevel === null || riskLevel >= 60 ||
          buyTax === null || sellTax === null || buyTax > 10 || sellTax > 10 ||
          highFlags.length > 0 || report.contractCode?.rootOpenSource !== true;
        const status = hardRisk ? "blocked" : reviewRisk ? "review" : "pass";
        return json({
          ok: true, chain, tokenAddress: address, provider: "Honeypot.is",
          status, simulationSuccess: report.simulationSuccess === true,
          isHoneypot: report.honeypotResult?.isHoneypot ?? null,
          risk: report.summary?.risk || "unknown", riskLevel,
          buyTax, sellTax, openSource: report.contractCode?.rootOpenSource ?? null,
          pairAddress: report.pairAddress || report.pair?.pair?.address || null,
          reasons: [
            ...(isHoneypot ? ["检测到貔貅/无法正常卖出"] : []),
            ...(riskLevel !== null && riskLevel >= 60 ? ["Honeypot 风险等级偏高"] : []),
            ...(sellTax !== null && sellTax > 10 ? ["卖出税超过10%"] : []),
            ...(!simOK ? ["买卖模拟未成功或结果不完整"] : []),
            ...(!report.contractCode?.rootOpenSource ? ["合约源码未确认开源"] : []),
            ...criticalFlags.map((x) => x.description || x.flag),
            ...highFlags.map((x) => x.description || x.flag)
          ],
          note: "模拟结果只代表本次检测时点和检测路径；代币权限或流动性变化后风险可能改变。"
        });
      } catch (error) {
        return json({ ok: true, chain, tokenAddress: address, provider: chain === "solana" ? "RugCheck" : "Honeypot.is", status: "unverified", error: String(error), note: "安全数据不可用，按未验证处理，不进入通过安全检查的观察名单。" });
      }
    }
    if (url.pathname === "/multiscan") {
      const minutes = Number(url.searchParams.get("minutes") || 15);
      const minLiquidity = Math.max(0, Number(url.searchParams.get("minLiquidity") || 5000));
      if (![15, 30, 60].includes(minutes)) return json({ ok: false, error: "minutes must be 15, 30, or 60" }, 400);
      const networks = [
        { id: "solana", name: "Solana", dexChain: "solana" },
        { id: "eth", name: "Ethereum", dexChain: "ethereum" },
        { id: "base", name: "Base", dexChain: "base" }
      ];
      const results = [];
      const errors = [];
      const chainSources = [];
      const failedNetworks = [];
      for (const network of networks) {
        try {
          const endpoint = "https://api.geckoterminal.com/api/v2/networks/" + network.id + "/new_pools?include=base_token,quote_token,dex";
          const response = await fetchGeckoTerminal(endpoint);
          if (!response.ok) throw new Error("GeckoTerminal HTTP " + response.status);
          const body = await response.json();
          const included = new Map((body.included || []).map((item) => [item.id, item.attributes || {}]));
          let chainPoolCount = 0;
          for (const item of body.data || []) {
            const a = item.attributes || {};
            const rel = item.relationships || {};
            const baseId = rel.base_token && rel.base_token.data && rel.base_token.data.id;
            const quoteId = rel.quote_token && rel.quote_token.data && rel.quote_token.data.id;
            const base = included.get(baseId) || {};
            const quote = included.get(quoteId) || {};
            const dexId = rel.dex && rel.dex.data && rel.dex.data.id;
            const dex = included.get(dexId) || {};
            const created = Date.parse(a.pool_created_at || "");
            const ageMinutes = created > 0 ? (Date.now() - created) / 60000 : null;
            const liquidity = Number(a.reserve_in_usd || 0);
            if (ageMinutes == null || ageMinutes < 0 || ageMinutes > minutes || liquidity < minLiquidity) continue;
            const tx1h = a.transactions && a.transactions.h1 || {};
            const volume1h = Number(a.volume_usd && a.volume_usd.h1 || 0);
            const priceChange1h = a.price_change_percentage && a.price_change_percentage.h1 != null
              ? Number(a.price_change_percentage.h1) : null;
            const poolAddress = a.address || (item.id || "").split("_").slice(1).join("_");
            const quoteAddress = (quote.address || (quoteId || "").split("_").slice(1).join("_"));
            const candidate = choosePoolToken(network.id, base, quote, baseId, quoteId);
            if (candidate.skip) continue;
            results.push({
              chain: network.name, chainId: network.dexChain,
              dex: dex.name || a.dex_id || "GeckoTerminal indexed DEX",
              symbol: candidate.symbol || "Unknown", name: candidate.name || "Unknown token",
              tokenAddress: candidate.address, tokenSelectionVerified: candidate.verified,
              tokenSelectionNote: candidate.verified ? "" : "交易池两侧均未匹配已知主流报价资产，暂按 base token 显示，代币方向未确认。",
              quoteSymbol: quote.symbol || "Unknown", quoteAddress,
              pairAddress: poolAddress,
              poolUrl: "https://www.geckoterminal.com/" + network.id + "/pools/" + poolAddress,
              dexScreenerUrl: "https://dexscreener.com/" + network.dexChain + "/" + poolAddress,
              createdAt: new Date(created).toISOString(), ageMinutes: Math.round(ageMinutes * 10) / 10,
              liquidityUSDApprox: liquidity, volume1hUSD: volume1h,
              buys1h: Number(tx1h.buys || 0), sells1h: Number(tx1h.sells || 0),
              priceChange1h, usdtRouteStatus: "not_verified", source: "GeckoTerminal",
              riskNote: "第三方新池索引数据；USDT 路由尚未实时报价验证。新池风险高，请独立核实合约、流动性和卖出能力。"
            });
            chainPoolCount++;
          }
          chainSources.push({ chain: network.name, provider: "GeckoTerminal", status: "ok", pools: chainPoolCount });
        } catch (error) {
          failedNetworks.push({ network, error: String(error) });
        }
      }

      // Supplemental fallback only: this feed contains latest token profiles,
      // not a complete global new-pool feed. Pair creation time and liquidity
      // are independently checked before any pool is admitted.
      const fallbackChains = [];
      if (failedNetworks.length) {
        try {
          // The latest token-profile feed is sparse on some chains. Merge it
          // with the latest boosted-token feed, while keeping fallback coverage
          // explicitly partial and validating every pair's age/liquidity below.
          const feedSpecs = [
            { name: "latest token profiles", url: "https://api.dexscreener.com/token-profiles/latest/v1" },
            { name: "latest token boosts", url: "https://api.dexscreener.com/token-boosts/latest/v1" }
          ];
          const feedResults = await Promise.all(feedSpecs.map(async (feed) => {
            try {
              const response = await fetchDexScreenerJson(feed.url);
              if (!response.ok) throw new Error("HTTP " + response.status);
              const items = await response.json();
              if (!Array.isArray(items)) throw new Error("unexpected response");
              return { name: feed.name, items, error: null };
            } catch (error) {
              return { name: feed.name, items: [], error: String(error) };
            }
          }));
          const feedErrors = feedResults.filter((feed) => feed.error)
            .map((feed) => feed.name + ": " + feed.error);
          for (const failed of failedNetworks) {
            const network = failed.network;
            try {
              const addresses = [...new Set(feedResults.flatMap((feed) => feed.items)
                .filter((item) => item && item.chainId === network.dexChain && item.tokenAddress)
                .map((item) => String(item.tokenAddress)))].slice(0, 30);
              if (!addresses.length) {
                const detail = feedErrors.length ? "; feed errors: " + feedErrors.join(" | ") : "";
                throw new Error("DexScreener profiles/boosts feeds have no tokens for this chain" + detail);
              }
              const endpoint = "https://api.dexscreener.com/tokens/v1/" + network.dexChain + "/" + addresses.map(encodeURIComponent).join(",");
              const pairResponse = await fetchDexScreenerJson(endpoint);
              if (!pairResponse.ok) throw new Error("DexScreener token pairs HTTP " + pairResponse.status);
              const pairs = await pairResponse.json();
              if (!Array.isArray(pairs)) throw new Error("DexScreener token pairs returned an unexpected response");
              let chainPoolCount = 0;
              const seenPairs = new Set();
              for (const pair of pairs) {
                if (!pair || pair.chainId !== network.dexChain || !pair.pairAddress || seenPairs.has(pair.pairAddress)) continue;
                seenPairs.add(pair.pairAddress);
                const created = Number(pair.pairCreatedAt || 0);
                const ageMinutes = created > 0 ? (Date.now() - created) / 60000 : null;
                const liquidity = Number(pair.liquidity && pair.liquidity.usd || 0);
                if (ageMinutes == null || ageMinutes < 0 || ageMinutes > minutes || liquidity < minLiquidity) continue;
                const base = pair.baseToken || {};
                const quote = pair.quoteToken || {};
                const candidate = choosePoolToken(network.id, base, quote, "", "");
                if (candidate.skip) continue;
                const quoteAsset = candidate.side === "quote" ? base : quote;
                const tx1h = pair.txns && pair.txns.h1 || {};
                results.push({
                  chain: network.name, chainId: network.dexChain,
                  dex: pair.dexId || "DexScreener indexed DEX",
                  symbol: candidate.symbol || "Unknown", name: candidate.name || "Unknown token",
                  tokenAddress: candidate.address, tokenSelectionVerified: candidate.verified,
                  tokenSelectionNote: candidate.verified ? "" : "交易池两侧均未匹配已知主流报价资产，暂按 base token 显示，代币方向未确认。",
                  quoteSymbol: quoteAsset.symbol || "Unknown", quoteAddress: quoteAsset.address || "",
                  pairAddress: pair.pairAddress,
                  poolUrl: pair.url || "https://dexscreener.com/" + network.dexChain + "/" + pair.pairAddress,
                  dexScreenerUrl: pair.url || "https://dexscreener.com/" + network.dexChain + "/" + pair.pairAddress,
                  createdAt: new Date(created).toISOString(), ageMinutes: Math.round(ageMinutes * 10) / 10,
                  liquidityUSDApprox: liquidity,
                  volume1hUSD: Number(pair.volume && pair.volume.h1 || 0),
                  buys1h: Number(tx1h.buys || 0), sells1h: Number(tx1h.sells || 0),
                  priceChange1h: pair.priceChange && pair.priceChange.h1 != null ? Number(pair.priceChange.h1) : null,
                  usdtRouteStatus: "not_verified",
                  source: "DexScreener profiles + boosts fallback",
                  riskNote: "备用索引合并 DexScreener 最新 Token Profile 与 Boost 名单反查交易池，覆盖范围小于完整新池索引；不代表捕获该链全部新池。"
                });
                chainPoolCount++;
              }
              chainSources.push({
                chain: network.name, provider: "DexScreener profiles + boosts",
                status: "fallback", coverage: "partial", pools: chainPoolCount,
                primaryError: failed.error
              });
              fallbackChains.push(network.name);
            } catch (fallbackError) {
              // Independent third provider: only try DexPaprika when both indexed
              // providers above fail. Its free endpoint returns one page without a key.
              try {
                const query = new URLSearchParams({
                  created_after: "-" + String(minutes) + "m",
                  liquidity_usd_min: String(minLiquidity),
                  order_by: "created_at",
                  sort: "desc",
                  limit: "50"
                });
                const searchUrl = "https://api.dexpaprika.com/networks/" + network.dexChain + "/pools/search?" + query.toString();
                const searchResponse = await fetchDexPaprikaJson(searchUrl);
                if (!searchResponse.ok) throw new Error("DexPaprika pool search HTTP " + searchResponse.status);
                const searchBody = await searchResponse.json();
                if (!Array.isArray(searchBody.results)) throw new Error("DexPaprika returned an unexpected response");
                let chainPoolCount = 0;
                const detailCandidates = searchBody.results.slice(0, 3);
                for (const summary of detailCandidates) {
                  const poolAddress = String(summary.id || "");
                  if (!poolAddress) continue;
                  const detailUrl = "https://api.dexpaprika.com/networks/" + network.dexChain + "/pools/" + encodeURIComponent(poolAddress);
                  const detailResponse = await fetchDexPaprikaJson(detailUrl);
                  // A rate limit or provider outage means this chain's fallback is
                  // incomplete; don't silently report a successful empty result.
                  if (detailResponse.status === 429 || detailResponse.status >= 500) {
                    throw new Error("DexPaprika pool detail HTTP " + detailResponse.status);
                  }
                  if (!detailResponse.ok) continue;
                  const detail = await detailResponse.json();
                  const created = Date.parse(detail.created_at || summary.created_at || "");
                  const ageMinutes = created > 0 ? (Date.now() - created) / 60000 : null;
                  const liquidity = Number(detail.liquidity_usd ?? summary.liquidity_usd ?? 0);
                  if (ageMinutes == null || ageMinutes < 0 || ageMinutes > minutes || liquidity < minLiquidity) continue;
                  const tokens = Array.isArray(detail.tokens) ? detail.tokens : [];
                  const tokenById = new Map(tokens.map((token) => [String(token.id || token.address || "").toLowerCase(), token]));
                  const base = tokenById.get(String(detail.base_token_id || "").toLowerCase()) || {};
                  const quote = tokenById.get(String(detail.quote_token_id || "").toLowerCase()) || {};
                  if (!(base.id || base.address) || !(quote.id || quote.address)) continue;
                  const baseToken = { address: base.address || base.id, symbol: base.symbol, name: base.name };
                  const quoteToken = { address: quote.address || quote.id, symbol: quote.symbol, name: quote.name };
                  const candidate = choosePoolToken(network.id, baseToken, quoteToken, "", "");
                  if (candidate.skip) continue;
                  const activity = detail["1h"] || {};
                  const quoteAsset = candidate.side === "quote" ? baseToken : quoteToken;
                  results.push({
                    chain: network.name, chainId: network.dexChain,
                    dex: detail.dex_name || summary.dex_name || summary.dex_id || "DexPaprika indexed DEX",
                    symbol: candidate.symbol || "Unknown", name: candidate.name || "Unknown token",
                    tokenAddress: candidate.address, tokenSelectionVerified: candidate.verified,
                    tokenSelectionNote: candidate.verified ? "" : "交易池两侧均未匹配已知主流报价资产，暂按 base token 显示，代币方向未确认。",
                    quoteSymbol: quoteAsset.symbol || "Unknown", quoteAddress: quoteAsset.address || "",
                    pairAddress: poolAddress,
                    poolUrl: "https://www.geckoterminal.com/" + network.id + "/pools/" + poolAddress,
                    dexScreenerUrl: "https://dexscreener.com/" + network.dexChain + "/" + poolAddress,
                    createdAt: new Date(created).toISOString(), ageMinutes: Math.round(ageMinutes * 10) / 10,
                    liquidityUSDApprox: liquidity,
                    volume1hUSD: Number(activity.volume_usd || 0),
                    buys1h: Number(activity.buys || 0), sells1h: Number(activity.sells || 0),
                    priceChange1h: activity.last_price_usd_change == null ? null : Number(activity.last_price_usd_change),
                    usdtRouteStatus: "not_verified", source: "DexPaprika independent fallback",
                    riskNote: "第三方独立备用索引；只返回首批有限池并逐池补充代币信息，覆盖范围不完整；USDT 路由未验证。"
                  });
                  chainPoolCount++;
                }
                chainSources.push({
                  chain: network.name, provider: "DexPaprika",
                  status: "fallback", coverage: "partial", pools: chainPoolCount,
                  primaryError: failed.error, previousFallbackError: String(fallbackError)
                });
                fallbackChains.push(network.name);
              } catch (dexPaprikaError) {
                errors.push({ chain: network.name, error: failed.error + "; DexScreener fallback: " + String(fallbackError) + "; DexPaprika fallback: " + String(dexPaprikaError) });
                chainSources.push({ chain: network.name, provider: "GeckoTerminal + DexScreener + DexPaprika", status: "error" });
              }
            }
          }
        } catch (fallbackError) {
          for (const failed of failedNetworks) {
            errors.push({ chain: failed.network.name, error: failed.error + "; DexScreener fallback: " + String(fallbackError) });
            chainSources.push({ chain: failed.network.name, provider: "GeckoTerminal + DexScreener", status: "error" });
          }
        }
      }
      results.sort((a, b) => a.ageMinutes - b.ageMinutes || b.volume1hUSD - a.volume1hUSD);
      return json({
        ok: true,
        complete: errors.length === 0,
        mode: "multichain-new-pools",
        chains: networks.map((x) => x.name),
        minutes,
        minLiquidityUSD: minLiquidity,
        dataSource: "GeckoTerminal primary; DexScreener profiles/boosts fallback; DexPaprika independent fallback when both fail",
        coverage: fallbackChains.length ? "partial" : "primary-index",
        chainSources,
        fallbackChains,
        count: results.length,
        pools: results,
        chainErrors: errors,
        limitations: [
          "本接口首阶段接入 Solana、Ethereum、Base；BSC 继续使用原有 NodeReal 链上扫描接口。",
          "GeckoTerminal new_pools 每页最多返回20个池；本版本每条链只取第一页，不保证覆盖全部新池。",
          "GeckoTerminal 公共 API 可能限流；失败时先尝试 DexScreener 最新 Token Profile 与 Boost 名单，若也失败则尝试 DexPaprika 最近新池搜索。备用源只取有限结果且覆盖不完整，必须显示为部分覆盖，不能当作完整新池扫描；第三方 API 仍可能限流。",
          "流动性、成交量、买卖次数和价格变化来自第三方索引，可能有延迟或缺失。",
          "多链报价资产会显示其索引符号；本版本不判断 USDT 直连，也不验证钱包兑换路径。",
          "本接口只读，不执行兑换或交易。"
        ],
        generatedAt: new Date().toISOString()
      });
    }
    if (url.pathname !== "/scan") return json({ ok: false, error: "not found" }, 404);

    const minutes = Number(url.searchParams.get("minutes") || 15);
    if (![15, 30, 60].includes(minutes)) return json({ ok: false, error: "minutes must be 15, 30, or 60" }, 400);
    const minLiquidity = Math.max(0, Number(url.searchParams.get("minLiquidity") || 5000));

    try {
      const latestHex = await rpc("eth_blockNumber", [], rpcUrl);
      const latest = asNumber(latestHex);
      const latestBlock = await rpc("eth_getBlockByNumber", [latestHex, false], rpcUrl);
      const latestTime = asNumber(latestBlock.timestamp) * 1000;
      let secondsPerBlock = 0.5;
      try {
        const sample = await rpc("eth_getBlockByNumber", [hexNum(Math.max(0, latest - 1000)), false], rpcUrl);
        const elapsed = latestTime - asNumber(sample.timestamp) * 1000;
        if (elapsed > 0) secondsPerBlock = elapsed / 1000000;
      } catch (_) {}
      const blockWindow = Math.min(10000, Math.ceil(minutes * 60 / secondsPerBlock * 1.15) + 100);
      const fromBlock = Math.max(0, latest - blockWindow);
      const factoryFilterBase = { fromBlock: hexNum(fromBlock), toBlock: latestHex };
      const v2FactoryResults = await Promise.all(V2_FACTORIES.map(async (factory) => {
        const logs = await rpc("eth_getLogs", [{ ...factoryFilterBase, address: factory.address, topics: [PAIR_CREATED] }], rpcUrl);
        const usdtLogs = logs.filter((log) =>
          fromTopic(log.topics[1] || "") === USDT || fromTopic(log.topics[2] || "") === USDT
        );
        return { factory, allLogs: logs, usdtLogs };
      }));
      const allV2FactoryLogs = v2FactoryResults.flatMap((x) => x.allLogs);
      const v2UsdtEvents = v2FactoryResults.flatMap(({ factory, usdtLogs }) =>
        usdtLogs.map((log) => ({ ...log, _dex: factory.name, _dexId: factory.dexId }))
      );
      const logMap = new Map();
      for (const log of v2UsdtEvents) {
        const pair = "0x" + word(log.data, 0).slice(-40).toLowerCase();
        logMap.set(pair, log);
      }

      const timeCache = new Map();
      const v3FactoryResults = await Promise.all(V3_FACTORIES.map(async (factory) => {
        const logs = await rpc("eth_getLogs", [{ ...factoryFilterBase, address: factory.address, topics: [V3_POOL_CREATED] }], rpcUrl);
        const usdtLogs = logs.filter((log) =>
          fromTopic(log.topics[1] || "") === USDT || fromTopic(log.topics[2] || "") === USDT
        );
        return { factory, allLogs: logs, usdtLogs };
      }));
      const factoryCodeChecks = await Promise.all(
        [...V2_FACTORIES, ...V3_FACTORIES].map(async (factory) => {
          try {
            const code = await rpc("eth_getCode", [factory.address, "latest"], rpcUrl);
            return {
              dex: factory.name,
              address: factory.address,
              contractCodePresent: !!code && code !== "0x",
              codeBytes: code && code !== "0x" ? Math.max(0, (code.length - 2) / 2) : 0
            };
          } catch (error) {
            return {
              dex: factory.name,
              address: factory.address,
              contractCodePresent: null,
              codeCheckError: String(error)
            };
          }
        })
      );
      const allV3FactoryLogs = v3FactoryResults.flatMap((x) => x.allLogs);
      const v3UsdtEvents = v3FactoryResults.flatMap(({ factory, usdtLogs }) =>
        usdtLogs.map((log) => ({ ...log, _dex: factory.name, _dexId: factory.dexId }))
      );
      const v3LogMap = new Map();
      for (const log of v3UsdtEvents) {
        const pool = "0x" + word(log.data, 1).slice(-40).toLowerCase();
        v3LogMap.set(pool, log);
      }
      const v3CreationLogs = Array.from(v3LogMap.values()).sort((a, b) => asNumber(b.blockNumber) - asNumber(a.blockNumber));
      const v3WithTimes = await mapLimit(v3CreationLogs, 3, async (log) => ({
        log, createdAt: await blockTime(asNumber(log.blockNumber), timeCache, rpcUrl)
      }));
      const v3Fresh = v3WithTimes.filter((x) => x.createdAt > 0 && latestTime - x.createdAt >= 0 && latestTime - x.createdAt <= minutes * 60000);
      const v3Read = await mapLimit(v3Fresh.slice(0, 40), 3, async (x) => {
        const pool = await readV3Pool(x.log, x.createdAt, rpcUrl);
        pool.dex = x.log._dex;
        pool.dexId = x.log._dexId;
        return pool;
      });
      const v3Valid = v3Read.filter((p) => !p._error && p.liquidityUSD >= minLiquidity);

      const creationLogs = Array.from(logMap.values()).sort((a, b) => asNumber(b.blockNumber) - asNumber(a.blockNumber));
      const withTimes = await mapLimit(creationLogs, 3, async (log) => ({
        log: log,
        createdAt: await blockTime(asNumber(log.blockNumber), timeCache, rpcUrl)
      }));
      const fresh = withTimes.filter((x) => x.createdAt > 0 && latestTime - x.createdAt >= 0 && latestTime - x.createdAt <= minutes * 60000);
      const pairData = await mapLimit(fresh.slice(0, 40), 3, async (x) => {
        const p = await readPair(x.log, rpcUrl);
        p.dex = x.log._dex || "PancakeSwap V2";
        p.dexId = x.log._dexId || "pancakeswap";
        p.createdAt = x.createdAt;
        return p;
      });
      const valid = pairData.filter((p) => !p._error && p.liquidityUSD >= minLiquidity);

      let swapError = null;
      let swapLogs = [];
      if (valid.length) {
        try {
          swapLogs = await rpc("eth_getLogs", [{
            address: valid.map((p) => p.pair),
            fromBlock: hexNum(Math.min(...valid.map((p) => p.createdBlock))),
            toBlock: latestHex,
            topics: [SWAP_TOPIC]
          }], rpcUrl);
        } catch (e) { swapError = String(e); }
      }

      const pairByAddress = new Map(valid.map((p) => [p.pair.toLowerCase(), p]));
      const swapsByPair = new Map();
      for (const log of swapLogs) {
        const key = log.address.toLowerCase();
        if (!pairByAddress.has(key)) continue;
        if (!swapsByPair.has(key)) swapsByPair.set(key, []);
        swapsByPair.get(key).push(log);
      }
      const allSwapBlocks = Array.from(new Set(swapLogs.map((l) => asNumber(l.blockNumber))));
      await mapLimit(allSwapBlocks, 3, async (n) => blockTime(n, timeCache, rpcUrl));

      const pools = valid.map((p) => {
        const swaps = (swapsByPair.get(p.pair.toLowerCase()) || []).sort((a, b) => {
          const blockDiff = asNumber(a.blockNumber) - asNumber(b.blockNumber);
          return blockDiff || asNumber(a.logIndex) - asNumber(b.logIndex);
        });
        let volume1hUSD = 0, buys1h = 0, sells1h = 0;
        const prices = [];
        for (const s of swaps) {
          const ts = timeCache.get(asNumber(s.blockNumber)) || 0;
          if (!ts || ts < p.createdAt || latestTime - ts > 3600000) continue;
          const a0i = BigInt("0x" + word(s.data, 0));
          const a1i = BigInt("0x" + word(s.data, 1));
          const a0o = BigInt("0x" + word(s.data, 2));
          const a1o = BigInt("0x" + word(s.data, 3));
          const usdtIn = p.usdtIs0 ? a0i : a1i;
          const usdtOut = p.usdtIs0 ? a0o : a1o;
          const tokenIn = p.usdtIs0 ? a1i : a0i;
          const tokenOut = p.usdtIs0 ? a1o : a0o;
          const usdtAmount = toFloat(usdtIn + usdtOut, 18);
          const tokenAmount = toFloat(tokenIn + tokenOut, p.decimals);
          volume1hUSD += usdtAmount;
          if (usdtIn > 0n && tokenOut > 0n) buys1h++;
          if (usdtOut > 0n && tokenIn > 0n) sells1h++;
          if (usdtAmount > 0 && tokenAmount > 0) prices.push(usdtAmount / tokenAmount);
        }
        const priceChange1h = prices.length > 1 && prices[0] > 0 ? (prices[prices.length - 1] / prices[0] - 1) * 100 : null;
        return {
          chain: "BSC",
          dex: p.dex || "PancakeSwap V2",
          symbol: p.symbol,
          name: p.name,
          tokenAddress: p.tokenAddress,
          pairAddress: p.pair,
          poolUrl: "https://dexscreener.com/bsc/" + p.pair,
          bscScanUrl: "https://bscscan.com/token/" + p.tokenAddress,
          createdAt: new Date(p.createdAt).toISOString(),
          ageMinutes: Math.round((latestTime - p.createdAt) / 6000) / 10,
          usdtReserve: p.usdtReserve,
          liquidityUSDApprox: p.liquidityUSD,
          volume1hUSD: volume1hUSD,
          buys1h: buys1h,
          sells1h: sells1h,
          priceChange1h: priceChange1h,
          swapCount1h: buys1h + sells1h,
          riskNote: "新池风险高；链上新池事件不代表代币安全。请另行核实合约权限、持币集中度、卖出限制及流动性变化。"
        };
      }).sort((a, b) => a.ageMinutes - b.ageMinutes);

      pools.push(...v3Valid.map((p) => ({
        chain: "BSC", dex: p.dex || "PancakeSwap V3",
        symbol: p.symbol, name: p.name, tokenAddress: p.tokenAddress,
        pairAddress: p.pair,
        poolUrl: "https://dexscreener.com/bsc/" + p.pair,
        bscScanUrl: "https://bscscan.com/token/" + p.tokenAddress,
        createdAt: new Date(p.createdAt).toISOString(),
        ageMinutes: Math.round((latestTime - p.createdAt) / 6000) / 10,
        usdtReserve: p.usdtReserve, liquidityUSDApprox: p.liquidityUSD,
        volume1hUSD: null, buys1h: null, sells1h: null,
        priceChange1h: null, swapCount1h: null,
        riskNote: "V3 新池；成交统计尚未接入。新池风险高，请核实合约权限、持币集中度、卖出限制及流动性变化。"
      })));

      const pairs = pools.map((p) => ({
        chainId: "bsc",
        dexId: p.dexId || (p.dex === "PancakeSwap V3" ? "pancakeswap-v3" : "pancakeswap"),
        url: p.poolUrl,
        pairAddress: p.pairAddress,
        pairCreatedAt: Date.parse(p.createdAt),
        baseToken: { address: p.tokenAddress, symbol: p.symbol, name: p.name },
        quoteToken: { address: USDT, symbol: "USDT", name: "Tether USD" },
        liquidity: { usd: p.liquidityUSDApprox },
        volume: { h1: p.volume1hUSD, h24: null },
        txns: { h1: { buys: p.buys1h, sells: p.sells1h } },
        priceChange: { h1: p.priceChange1h }
      }));

      return json({
        ok: true,
        chain: "BSC",
        quote: "USDT",
        minutes: minutes,
        minLiquidityUSDApprox: minLiquidity,
        dataSource: "NodeReal BSC RPC · PancakeSwap / Biswap / ApeSwap / MDEX / BabySwap / Nomiswap / Uniswap",
        factories: {
          v2: V2_FACTORIES.map((x) => ({ dex: x.name, address: x.address })),
          v3: V3_FACTORIES.map((x) => ({ dex: x.name, address: x.address }))
        },
        latestBlock: latest,
        blockWindow: blockWindow,
        factoryEventsFound: {
          v2: Object.fromEntries(v2FactoryResults.map((x) => [x.factory.name, x.allLogs.length])),
          v3: Object.fromEntries(v3FactoryResults.map((x) => [x.factory.name, x.allLogs.length]))
        },
        usdtPoolEventsFound: {
          v2: Object.fromEntries(v2FactoryResults.map((x) => [x.factory.name, x.usdtLogs.length])),
          v3: Object.fromEntries(v3FactoryResults.map((x) => [x.factory.name, x.usdtLogs.length]))
        },
        factoryCodeChecks: factoryCodeChecks,
        factoryDiagnostics: {
          v2: v2FactoryResults.map((x) => ({
            dex: x.factory.name,
            eventCount: x.allLogs.length,
            usdtEventCount: x.usdtLogs.length,
            sampleTokenPairs: x.allLogs.slice(0, 2).map((log) => ({
              token0: fromTopic(log.topics[1]),
              token1: fromTopic(log.topics[2])
            }))
          })),
          v3: v3FactoryResults.map((x) => ({
            dex: x.factory.name,
            eventCount: x.allLogs.length,
            usdtEventCount: x.usdtLogs.length,
            sampleTokenPairs: x.allLogs.slice(0, 2).map((log) => ({
              token0: fromTopic(log.topics[1]),
              token1: fromTopic(log.topics[2])
            }))
          }))
        },
        createdPairsFound: creationLogs.length + v3CreationLogs.length,
        freshPairsFound: fresh.length + v3Fresh.length,
        count: pools.length,
        pairs: pairs,
        pools: pools,
        swapStatsAvailable: !swapError,
        swapStatsError: swapError,
        generatedAt: new Date(latestTime).toISOString(),
        limitations: [
          "当前覆盖配置中的多个 BSC V2/V3 DEX 工厂；未覆盖全部 BSC DEX。",
          "流动性按 USDT 储备 × 2 粗略估算，不等于第三方聚合器的完整 USD 流动性。",
          "当前成交量、买卖次数仅对 V2 新池统计；V3 新池仅显示创建和 USDT 余额估算，成交统计待接入。",
          "NodeReal RPC 可能限流；结果不保证覆盖全部 BSC 新池。"
        ],
        note: "只读观察，不会自动交易。"
      });
    } catch (error) {
      return json({
        ok: false,
        dataSource: "NodeReal BSC RPC · PancakeSwap V2 Factory",
        error: String(error),
        hint: "请检查 NodeReal RPC 配额、端点和 eth_getLogs 权限；不要将错误当成没有新池。"
      }, 502);
    }
  }
};