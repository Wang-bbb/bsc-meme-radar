const USDT = "0x55d398326f99059ff775485246999027b319795";
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "cache-control": "no-store"
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

async function getJSON(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("DexScreener HTTP " + response.status);
  return response.json();
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: HEADERS });
    if (url.pathname === "/") {
      return json({ ok: true, service: "BSC Meme Radar API", dataSource: "DexScreener Search", route: "/scan?minutes=15|30|60" });
    }
    if (url.pathname === "/health") {
      return json({ ok: true, worker: "running", dataSource: "DexScreener Search" });
    }
    if (url.pathname !== "/scan") return json({ ok: false, error: "not found" }, 404);

    const minutesParam = url.searchParams.get("minutes");
    const hoursParam = url.searchParams.get("hours");
    let minutes = minutesParam !== null
      ? Number(minutesParam)
      : Number(hoursParam || 1) * 60;
    if (![15, 30, 60, 360, 1440].includes(minutes)) minutes = 60;

    const minLiquidity = Math.max(0, Number(url.searchParams.get("minLiquidity") || 5000));
    const queries = ["USDT", "USDT BSC", "BNB USDT", "PancakeSwap USDT"];
    const poolMap = new Map();
    const errors = [];
    let searchResults = 0;

    for (const query of queries) {
      try {
        const data = await getJSON(
          "https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(query)
        );
        const pairs = Array.isArray(data.pairs) ? data.pairs : [];
        searchResults += pairs.length;

        for (const p of pairs) {
          if (String(p.chainId || "").toLowerCase() !== "bsc") continue;
          if (String(p.quoteToken?.address || "").toLowerCase() !== USDT) continue;
          if (!p.pairAddress || !p.pairCreatedAt) continue;

          const ageMinutes = (Date.now() - Number(p.pairCreatedAt)) / 60000;
          if (ageMinutes < 0 || ageMinutes > minutes) continue;
          if (Number(p.liquidity?.usd || 0) < minLiquidity) continue;

          poolMap.set(String(p.pairAddress).toLowerCase(), p);
        }
      } catch (error) {
        errors.push({ query, error: String(error) });
      }
    }

    if (errors.length === queries.length) {
      return json({
        ok: false,
        dataSource: "DexScreener Search",
        error: "All search requests failed",
        details: errors
      }, 502);
    }

    const pairs = Array.from(poolMap.values()).sort((a, b) => {
      const at = a.txns?.h1 || {};
      const bt = b.txns?.h1 || {};
      return (Number(bt.buys || 0) + Number(bt.sells || 0)) -
        (Number(at.buys || 0) + Number(at.sells || 0));
    }).slice(0, 30);

    const pools = pairs.map(p => {
      const tx = p.txns?.h1 || {};
      return {
        chain: "BSC",
        symbol: p.baseToken?.symbol || "Unknown",
        name: p.baseToken?.name || "Unknown",
        tokenAddress: p.baseToken?.address || "",
        poolAddress: p.pairAddress,
        poolUrl: p.url || "",
        createdAt: new Date(Number(p.pairCreatedAt)).toISOString(),
        ageMinutes: Math.round((Date.now() - Number(p.pairCreatedAt)) / 6000) / 10,
        liquidityUSD: Number(p.liquidity?.usd || 0),
        volume1hUSD: Number(p.volume?.h1 || 0),
        buys1h: Number(tx.buys || 0),
        sells1h: Number(tx.sells || 0),
        priceChange1h: Number(p.priceChange?.h1 || 0),
        riskNote: "新池风险高；请核实合约权限、持币集中度、卖出限制及流动性锁定情况"
      };
    });

    return json({
      ok: true,
      chain: "BSC",
      quote: "USDT",
      minutes,
      minLiquidityUSD: minLiquidity,
      dataSource: "DexScreener Search",
      candidatesFound: searchResults,
      count: pairs.length,
      pairs,
      pools,
      failedQueries: errors.length,
      warnings: errors,
      generatedAt: new Date().toISOString(),
      note: "搜索接口只返回相关性较高的部分交易池，不保证覆盖全部新池；仅供只读观察，不会自动交易。"
    });
  }
};
