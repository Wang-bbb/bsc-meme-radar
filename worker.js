const USDT = "0x55d398326f99059ff775485246999027b319795";
const USDT_TOPIC = "0x" + USDT.slice(2).toLowerCase().padStart(64, "0");
const FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
const V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865";
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
      return json({ ok: true, service: "BSC Meme Radar API", worker: "running", chain: "BSC", dataSource: "NodeReal BSC RPC + PancakeSwap V2/V3 PoolCreated", supportedMinutes: [15, 30, 60], note: "只读监控；扫描 PancakeSwap V2/V3 USDT 池" });
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
      const filterBase = { address: FACTORY, fromBlock: hexNum(fromBlock), toBlock: latestHex };
      const [logs0, logs1] = await Promise.all([
        rpc("eth_getLogs", [{ ...filterBase, topics: [PAIR_CREATED, USDT_TOPIC, null] }], rpcUrl),
        rpc("eth_getLogs", [{ ...filterBase, topics: [PAIR_CREATED, null, USDT_TOPIC] }], rpcUrl)
      ]);
      const logMap = new Map();
      for (const log of [...logs0, ...logs1]) {
        const pair = "0x" + word(log.data, 0).slice(-40).toLowerCase();
        logMap.set(pair, log);
      }

      const timeCache = new Map();
      const v3FilterBase = { address: V3_FACTORY, fromBlock: hexNum(fromBlock), toBlock: latestHex };
      const [v3Logs0, v3Logs1] = await Promise.all([
        rpc("eth_getLogs", [{ ...v3FilterBase, topics: [V3_POOL_CREATED, USDT_TOPIC, null] }], rpcUrl),
        rpc("eth_getLogs", [{ ...v3FilterBase, topics: [V3_POOL_CREATED, null, USDT_TOPIC] }], rpcUrl)
      ]);
      const v3LogMap = new Map();
      for (const log of [...v3Logs0, ...v3Logs1]) {
        const pool = "0x" + word(log.data, 1).slice(-40).toLowerCase();
        v3LogMap.set(pool, log);
      }
      const v3CreationLogs = Array.from(v3LogMap.values()).sort((a, b) => asNumber(b.blockNumber) - asNumber(a.blockNumber));
      const v3WithTimes = await mapLimit(v3CreationLogs, 3, async (log) => ({
        log, createdAt: await blockTime(asNumber(log.blockNumber), timeCache, rpcUrl)
      }));
      const v3Fresh = v3WithTimes.filter((x) => x.createdAt > 0 && latestTime - x.createdAt >= 0 && latestTime - x.createdAt <= minutes * 60000);
      const v3Read = await mapLimit(v3Fresh.slice(0, 40), 3, async (x) => readV3Pool(x.log, x.createdAt, rpcUrl));
      const v3Valid = v3Read.filter((p) => !p._error && p.liquidityUSD >= minLiquidity);

      const creationLogs = Array.from(logMap.values()).sort((a, b) => asNumber(b.blockNumber) - asNumber(a.blockNumber));
      const withTimes = await mapLimit(creationLogs, 3, async (log) => ({
        log: log,
        createdAt: await blockTime(asNumber(log.blockNumber), timeCache, rpcUrl)
      }));
      const fresh = withTimes.filter((x) => x.createdAt > 0 && latestTime - x.createdAt >= 0 && latestTime - x.createdAt <= minutes * 60000);
      const pairData = await mapLimit(fresh.slice(0, 40), 3, async (x) => {
        const p = await readPair(x.log, rpcUrl);
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
        chain: "BSC", dex: "PancakeSwap V3",
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
        dexId: p.dex === "PancakeSwap V3" ? "pancakeswap-v3" : "pancakeswap",
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
        dataSource: "NodeReal BSC RPC · PancakeSwap V2 + V3",
        factory: FACTORY,
        latestBlock: latest,
        blockWindow: blockWindow,
        createdPairsFound: creationLogs.length + v3CreationLogs.length,
        freshPairsFound: fresh.length + v3Fresh.length,
        count: pools.length,
        pairs: pairs,
        pools: pools,
        swapStatsAvailable: !swapError,
        swapStatsError: swapError,
        generatedAt: new Date(latestTime).toISOString(),
        limitations: [
          "当前扫描 PancakeSwap V2/V3 Factory，不包括其他 DEX。",
          "流动性按 USDT 储备 × 2 粗略估算，不等于第三方聚合器的完整 USD 流动性。",
          "V2 买卖次数和成交量来自本次扫描到的新池 Swap 事件；V3 当前仅显示池创建和 USDT 余额估算，成交统计待接入。",
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