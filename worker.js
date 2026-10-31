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
    if (!rpcUrl) return json({ ok: false, error: "Missing NODEREAL_RPC_URL secret" }, 500);
    if (request.method === "OPTIONS") return new Response(null, { headers: HEADERS });
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "BSC Meme Radar API", worker: "running", chain: "BSC", dataSource: "NodeReal BSC RPC + multiple BSC DEX factories", supportedMinutes: [15, 30, 60], note: "只读监控；扫描已接入的 BSC DEX USDT 池" });
    }
    if (url.pathname === "/history") {
      const hours = Number(url.searchParams.get("hours") || 24);
      if (![6, 12, 24].includes(hours)) return json({ ok: false, error: "hours must be 6, 12, or 24" }, 400);
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
        const chunkSize = 4000;
        const chunks = [];
        for (let start = fromBlock; start <= latest; start += chunkSize) {
          chunks.push({ fromBlock: start, toBlock: Math.min(latest, start + chunkSize - 1) });
        }
        const allFactories = [
          ...V2_FACTORIES.map((factory) => ({ ...factory, version: "v2", topic: PAIR_CREATED })),
          ...V3_FACTORIES.map((factory) => ({ ...factory, version: "v3", topic: V3_POOL_CREATED }))
        ];
        const tasks = allFactories.flatMap((factory) => chunks.map((chunk) => ({ factory, chunk })));
        const results = await mapLimit(tasks, 3, async ({ factory, chunk }) => {
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
          return { factory, logs, usdtLogs };
        });
        const summary = allFactories.map((factory) => {
          const matching = results.filter((x) => x.factory.address === factory.address);
          const logs = matching.flatMap((x) => x.logs);
          const usdtLogs = matching.flatMap((x) => x.usdtLogs);
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
          return {
            dex: factory.name,
            version: factory.version,
            factoryAddress: factory.address,
            eventCount: logs.length,
            usdtPoolEventCount: uniqueUsdt.size,
            sampleUsdtPools: Array.from(uniqueUsdt.values()).slice(0, 5)
          };
        });
        const errors = results.filter((x) => x && x._error).map((x) => x._error);
        return json({
          ok: true,
          mode: "historical-usdt-pool-validation",
          chain: "BSC",
          quoteToken: { symbol: "USDT", address: USDT },
          hours,
          fromBlock,
          latestBlock: latest,
          estimatedSecondsPerBlock: secondsPerBlock,
          chunkSize,
          chunksScanned: chunks.length,
          factoriesScanned: summary.length,
          totalFactoryEvents: summary.reduce((n, x) => n + x.eventCount, 0),
          totalUsdtPoolEvents: summary.reduce((n, x) => n + x.usdtPoolEventCount, 0),
          results: summary,
          limitations: [
            "按已配置工厂地址和对应 V2/V3 创建池事件扫描，不代表覆盖 BSC 全部 DEX。",
            "历史建池事件数量不等于当前仍有流动性或可正常卖出。",
            "USDT 配对通过精确合约地址识别，不依赖代币名称或 symbol。"
          ]
        });
      } catch (error) {
        return json({
          ok: false,
          mode: "historical-usdt-pool-validation",
          error: String(error),
          hint: "历史验证失败不代表没有 USDT 池；请检查 RPC 限流或日志查询范围。"
        }, 502);
      }
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