import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import worker from "../worker.js";

const env = { NODEREAL_RPC_URL: "https://rpc.invalid.test" };
const originalFetch = globalThis.fetch;

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function request(path) {
  return new Request("https://worker.test" + path);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("EVM security gate passes only when simulation and source checks are complete", async () => {
  globalThis.fetch = async () => response({
    simulationSuccess: true,
    simulationResult: { buyTax: 0, sellTax: 0 },
    honeypotResult: { isHoneypot: false },
    summary: { riskLevel: 10, flags: [] },
    contractCode: { rootOpenSource: true }
  });
  const res = await worker.fetch(request("/security-check?chain=bsc&address=0x1111111111111111111111111111111111111111"), env);
  const data = await res.json();
  assert.equal(data.status, "pass");
});

test("EVM security gate sends missing source verification to review", async () => {
  globalThis.fetch = async () => response({
    simulationSuccess: true,
    simulationResult: { buyTax: 0, sellTax: 0 },
    honeypotResult: { isHoneypot: false },
    summary: { riskLevel: 10, flags: [] }
  });
  const res = await worker.fetch(request("/security-check?chain=base&address=0x1111111111111111111111111111111111111111"), env);
  const data = await res.json();
  assert.equal(data.status, "review");
});

test("Solana security gate blocks a RugCheck report marked rugged", async () => {
  globalThis.fetch = async () => response({
    tokenProgram: "spl-token",
    rugged: true,
    risks: [],
    score_normalised: 5,
    lpLockedPct: 100
  });
  const res = await worker.fetch(request("/security-check?chain=solana&address=So11111111111111111111111111111111111111112"), env);
  const data = await res.json();
  assert.equal(data.status, "blocked");
});

test("Solana security gate distinguishes unknown LP lock data from confirmed low lock percentage", async () => {
  globalThis.fetch = async () => response({
    tokenProgram: "spl-token",
    risks: [],
    score_normalised: 1,
    mintAuthority: null,
    freezeAuthority: null
  });
  const res = await worker.fetch(request("/security-check?chain=solana&address=So11111111111111111111111111111111111111112"), env);
  const data = await res.json();
  assert.equal(data.status, "review");
  assert.equal(data.lpLockedPct, null);
  assert.equal(data.liquidityLockStatus, "unknown");
  assert.ok(data.reasons.some(reason => reason.includes("数据缺失，无法确认")));
  assert.ok(!data.reasons.some(reason => reason.includes("低于80%")));
});

test("Solana security gate reports a numeric LP lock percentage below threshold separately", async () => {
  globalThis.fetch = async () => response({
    tokenProgram: "spl-token",
    risks: [],
    score_normalised: 1,
    lpLockedPct: 55,
    mintAuthority: null,
    freezeAuthority: null
  });
  const res = await worker.fetch(request("/security-check?chain=solana&address=So11111111111111111111111111111111111111112"), env);
  const data = await res.json();
  assert.equal(data.status, "review");
  assert.equal(data.liquidityLockStatus, "below_threshold");
  assert.ok(data.reasons.some(reason => reason.includes("已报告的流动性锁定比例低于80%")));
});

test("Solana security gate keeps elevated or incomplete reports in review", async () => {
  globalThis.fetch = async () => response({
    tokenProgram: "spl-token",
    risks: [{ name: "Authority warning", level: "high" }],
    score_normalised: 20,
    lpLockedPct: 95,
    mintAuthority: null,
    freezeAuthority: null
  });
  const res = await worker.fetch(request("/security-check?chain=solana&address=So11111111111111111111111111111111111111112"), env);
  const data = await res.json();
  assert.equal(data.status, "review");
});


test("non-BSC preflight requests do not depend on the NodeReal secret", async () => {
  const req = new Request("https://worker.test/multiscan", { method: "OPTIONS" });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("multiscan stops retrying GeckoTerminal immediately after HTTP 429 and does not report a false empty success", async () => {
  const attempts = new Map();
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.geckoterminal.com") {
      const network = url.pathname.split("/")[4];
      attempts.set(network, (attempts.get(network) || 0) + 1);
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" }
      });
    }
    if (url.pathname === "/token-profiles/latest/v1" || url.pathname === "/token-boosts/latest/v1") {
      return response([]);
    }
    throw new Error("Unexpected URL " + url.href);
  };
  const res = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
  const data = await res.json();
  assert.equal(data.complete, false);
  assert.equal(data.pools.length, 0);
  assert.equal(data.chainErrors.length, 3);
  assert.deepEqual([...attempts.values()], [1, 1, 1]);
});

test("multiscan combines indexed pools and applies the age and liquidity filters", async () => {
  const networks = ["solana", "eth", "base"];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    const network = url.pathname.split("/")[4];
    assert.ok(networks.includes(network));
    const tokenId = network + "_token";
    const quoteId = network + "_quote";
    const verifiedQuote = network === "solana"
      ? "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
      : {
          eth: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        }[network];
    const dexId = network + "_dex";
    const poolAddress = "PoolAddress" + network;
    return response({
      data: [{
        id: network + "_" + poolAddress,
        attributes: {
          address: poolAddress,
          pool_created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          reserve_in_usd: "12000",
          transactions: { h1: { buys: 7, sells: 3 } },
          volume_usd: { h1: "2500" },
          price_change_percentage: { m5: "-2.1", m15: "-3.4", h1: "4.2" }
        },
        relationships: {
          base_token: { data: { id: tokenId } },
          quote_token: { data: { id: quoteId } },
          dex: { data: { id: dexId } }
        }
      }],
      included: [
        { id: tokenId, attributes: { address: "Token" + network, symbol: "MEME", name: "Meme Token" } },
        { id: quoteId, attributes: { address: verifiedQuote, symbol: network === "solana" ? "USDT" : "USDC", name: network === "solana" ? "Tether USD" : "USD Coin" } },
        { id: dexId, attributes: { name: "Test DEX" } }
      ]
    });
  };
  const res = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.complete, true);
  assert.equal(data.pools.length, 3);
  assert.ok(data.pools.every(pool => pool.liquidityUSDApprox >= 5000));
  assert.ok(data.pools.every(pool => pool.ageMinutes <= 15));
  assert.ok(data.pools.every(pool => pool.usdtRouteStatus === "not_verified"));
  assert.ok(data.pools.every(pool => pool.tokenSelectionVerified === true));
  assert.ok(data.pools.every(pool => pool.tokenAddress !== pool.quoteAddress));
  assert.ok(data.pools.every(pool => pool.priceChange5m === -2.1));
  assert.ok(data.pools.every(pool => pool.priceChange15m === -3.4));
});

test("Solana security gate keeps active mint or freeze authorities in review", async () => {
  globalThis.fetch = async () => response({
    tokenProgram: "spl-token",
    risks: [],
    score_normalised: 5,
    lpLockedPct: 100,
    token: { mintAuthority: "CreatorAuthority", freezeAuthority: null }
  });
  const res = await worker.fetch(request("/security-check?chain=solana&address=So11111111111111111111111111111111111111112"), env);
  const data = await res.json();
  assert.equal(data.status, "review");
  assert.ok(data.reasons.some(reason => reason.includes("Authority")));
});

test("Solana security gate keeps missing authority fields in review", async () => {
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/report$/);
    return response({
      tokenProgram: "spl-token",
      risks: [],
      score_normalised: 5,
      lpLockedPct: 100,
      token: { supply: "1000000", decimals: 6 }
    });
  };
  const res = await worker.fetch(request("/security-check?chain=solana&address=So11111111111111111111111111111111111111112"), env);
  const data = await res.json();
  assert.equal(data.status, "review");
  assert.ok(data.reasons.some(reason => reason.includes("状态缺失")));
});


test("multiscan falls back to DexScreener profiles when GeckoTerminal is rate limited", async () => {
  const networks = {
    solana: { token: "MemeSol", quote: "So11111111111111111111111111111111111111112", symbol: "SOL" },
    ethereum: { token: "0x1111111111111111111111111111111111111111", quote: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC" },
    base: { token: "0x2222222222222222222222222222222222222222", quote: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" }
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.geckoterminal.com") {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    if (url.pathname === "/token-profiles/latest/v1") {
      return response(Object.entries(networks).map(([chainId, item]) => ({
        chainId, tokenAddress: item.token
      })));
    }
    if (url.pathname === "/token-boosts/latest/v1") {
      return response([]);
    }
    if (url.pathname.startsWith("/tokens/v1/")) {
      const chainId = url.pathname.split("/")[3];
      const item = networks[chainId];
      assert.ok(item, "fallback should request a supported chain");
      return response([{
        chainId,
        dexId: "test-dex",
        pairAddress: "Pair" + chainId,
        url: "https://dexscreener.com/" + chainId + "/Pair" + chainId,
        baseToken: { address: item.token, name: "Test Meme", symbol: "MEME" },
        quoteToken: { address: item.quote, name: item.symbol, symbol: item.symbol },
        pairCreatedAt: Date.now() - 5 * 60_000,
        liquidity: { usd: 15000 },
        volume: { h1: 3200 },
        txns: { h1: { buys: 8, sells: 3 } },
        priceChange: { m5: -1.2, m15: -2.4, h1: 2.5 }
      }]);
    }
    throw new Error("Unexpected URL " + url.href);
  };

  const res = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
  const data = await res.json();
  assert.equal(data.complete, true);
  assert.deepEqual(data.fallbackChains.sort(), ["Base", "Ethereum", "Solana"]);
  assert.equal(data.chainErrors.length, 0);
  assert.equal(data.pools.length, 3);
  assert.ok(data.pools.every(pool => pool.source === "DexScreener profiles + boosts fallback"));
  assert.ok(data.pools.every(pool => pool.tokenSelectionVerified === true));
  assert.ok(data.chainSources.every(source => source.status === "fallback" && source.coverage === "partial"));
});


test("multiscan uses the latest boost feed when token profiles omit a chain", async () => {
  const token = "0x3333333333333333333333333333333333333333";
  const quote = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.geckoterminal.com") {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    if (url.pathname === "/token-profiles/latest/v1") return response([]);
    if (url.pathname === "/token-boosts/latest/v1") {
      return response([{ chainId: "base", tokenAddress: token }]);
    }
    if (url.pathname === "/tokens/v1/base/" + token) {
      return response([{
        chainId: "base",
        dexId: "test-dex",
        pairAddress: "PairBaseBoost",
        url: "https://dexscreener.com/base/PairBaseBoost",
        baseToken: { address: token, name: "Boost Meme", symbol: "BOOST" },
        quoteToken: { address: quote, name: "USD Coin", symbol: "USDC" },
        pairCreatedAt: Date.now() - 4 * 60_000,
        liquidity: { usd: 18000 },
        volume: { h1: 4100 },
        txns: { h1: { buys: 9, sells: 2 } },
        priceChange: { h1: 3.1 }
      }]);
    }
    if (url.pathname.startsWith("/tokens/v1/")) return response([]);
    throw new Error("Unexpected URL " + url.href);
  };
  const res = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
  const data = await res.json();
  assert.equal(data.chainErrors.some(error => error.chain === "Base"), false);
  const basePool = data.pools.find(pool => pool.chain === "Base");
  assert.ok(basePool, "Base pool should be found from the boost feed");
  assert.equal(basePool.source, "DexScreener profiles + boosts fallback");
  assert.equal(basePool.tokenSelectionVerified, true);
  assert.equal(data.chainSources.find(source => source.chain === "Base").coverage, "partial");
});


test("multiscan uses DexPaprika as an independent fallback when GeckoTerminal and DexScreener are rate limited", async () => {
  const quotes = {
    solana: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Wrapped SOL" },
    ethereum: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", name: "USD Coin" },
    base: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin" }
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.geckoterminal.com") {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    if (url.hostname === "api.dexscreener.com") {
      return new Response("rate limited", { status: 429 });
    }
    if (url.hostname === "api.dexpaprika.com" && url.pathname.endsWith("/pools/search")) {
      const network = url.pathname.split("/")[2];
      return response({ results: [{
        id: "Pool" + network,
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        liquidity_usd: 15000,
        dex_name: "Test DEX"
      }] });
    }
    if (url.hostname === "api.dexpaprika.com" && /\/pools\//.test(url.pathname)) {
      const network = url.pathname.split("/")[2];
      const quote = quotes[network];
      return response({
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        liquidity_usd: 15000,
        dex_name: "Test DEX",
        base_token_id: "Meme" + network,
        quote_token_id: quote.address,
        tokens: [
          { id: "Meme" + network, symbol: "MEME", name: "Test Meme" },
          { id: quote.address, symbol: quote.symbol, name: quote.name }
        ],
        "1h": { volume_usd: 3200, buys: 8, sells: 3, last_price_usd_change: 2.5 }
      });
    }
    throw new Error("Unexpected URL " + url.href);
  };

  const res = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
  const data = await res.json();
  assert.equal(data.complete, true);
  assert.equal(data.chainErrors.length, 0);
  assert.equal(data.pools.length, 3);
  assert.ok(data.pools.every(pool => pool.source === "DexPaprika independent fallback"));
  assert.ok(data.chainSources.every(source => source.provider === "DexPaprika" && source.coverage === "partial"));
  assert.ok(data.pools.every(pool => pool.tokenSelectionVerified === true));
});


test("multiscan marks DexPaprika fallback incomplete when pool detail requests are rate limited", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.geckoterminal.com") {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    if (url.hostname === "api.dexscreener.com") {
      return new Response("rate limited", { status: 429 });
    }
    if (url.hostname === "api.dexpaprika.com" && url.pathname.endsWith("/pools/search")) {
      const network = url.pathname.split("/")[2];
      return response({ results: [{
        id: "Pool" + network,
        created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        liquidity_usd: 15000,
        dex_name: "Test DEX"
      }] });
    }
    if (url.hostname === "api.dexpaprika.com" && /\/pools\//.test(url.pathname)) {
      return new Response("rate limited", { status: 429 });
    }
    throw new Error("Unexpected URL " + url.href);
  };

  const res = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
  const data = await res.json();
  assert.equal(data.complete, false);
  assert.equal(data.pools.length, 0);
  assert.equal(data.chainErrors.length, 3);
  assert.ok(data.chainSources.every(source => source.status === "error"));
  assert.ok(data.chainErrors.every(error => error.error.includes("DexPaprika pool detail HTTP 429")));
});


test("DexPaprika caches HTTP 402 quota responses and restores the original status during cooldown", async () => {
  const originalCaches = globalThis.caches;
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        const hit = store.get(key.url);
        return hit ? hit.clone() : undefined;
      },
      async put(key, value) {
        store.set(key.url, value.clone());
      }
    }
  };
  let paprikaCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.geckoterminal.com") {
      return new Response("rate limited", { status: 429 });
    }
    if (url.hostname === "api.dexscreener.com") {
      return new Response("rate limited", { status: 429 });
    }
    if (url.hostname === "api.dexpaprika.com") {
      paprikaCalls++;
      return new Response("quota exceeded", { status: 402 });
    }
    throw new Error("Unexpected URL " + url.href);
  };

  try {
    const first = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
    const firstData = await first.json();
    assert.equal(firstData.complete, false);
    assert.equal(firstData.chainErrors.length, 3);
    assert.ok(firstData.chainErrors.every(error => error.error.includes("HTTP 402")));
    assert.ok(firstData.chainErrors.every(error => error.error.includes("额度/套餐限制")));
    assert.equal(paprikaCalls, 3);

    const second = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
    const secondData = await second.json();
    assert.equal(secondData.complete, false);
    assert.ok(secondData.chainErrors.every(error => error.error.includes("HTTP 402")));
    assert.equal(paprikaCalls, 3, "cached 402 responses should suppress repeated provider requests");
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});


test("multiscan applies provider-wide 429 cooldown across chains and refreshes", async () => {
  const originalCaches = globalThis.caches;
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        const hit = store.get(key.url);
        return hit ? hit.clone() : undefined;
      },
      async put(key, value) {
        store.set(key.url, value.clone());
      }
    }
  };
  const calls = { gecko: 0, dex: 0, paprika: 0 };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.geckoterminal.com") {
      calls.gecko++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    if (url.hostname === "api.dexscreener.com") {
      calls.dex++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    if (url.hostname === "api.dexpaprika.com") {
      calls.paprika++;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    throw new Error("Unexpected URL " + url.href);
  };

  try {
    const first = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
    const firstData = await first.json();
    assert.equal(firstData.complete, false);
    assert.equal(firstData.chainErrors.length, 3);
    assert.ok(firstData.chainErrors.every(error => error.error.includes("HTTP 429")));
    assert.deepEqual(calls, { gecko: 1, dex: 2, paprika: 1 },
      "DexScreener profiles and boosts are parallel feed requests on the first scan");

    const second = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
    const secondData = await second.json();
    assert.equal(secondData.complete, false);
    assert.equal(secondData.chainErrors.length, 3);
    assert.deepEqual(calls, { gecko: 1, dex: 2, paprika: 1 },
      "provider-wide cooldown should suppress repeat calls across all chains and immediate refreshes");
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});


const REGRESSION_SAMPLE_MINTS = [
  "fu7JWsUtgQyJ84VaStM5yypTk6rtLPitpJrQKxvpump",
  "Atra2xApQEEoLaEZ188Cqcywo9XGtNnnGgGQDveZpump",
  "8DKHFW32ApiG6xLYrTDTxkWMGxdDyASfNnSaWwCbpump",
  "4R9jUfYAifDyiLz9Tx6bHpPqkvh3GRom71YEapkUpump"
];

function loadDashboardPriceRisk() {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/function priceRisk\(p\)\{[\s\S]*?\n\}/);
  assert.ok(match, "dashboard priceRisk function should exist");
  return vm.runInNewContext("(" + match[0] + ")");
}

test("price risk does not reject large positive moves solely because of their gain", () => {
  const priceRisk = loadDashboardPriceRisk();
  const result = priceRisk({
    priceChange1h: 180,
    priceChange5m: 12,
    priceChange15m: 42,
    buys1h: 40,
    sells1h: 15,
    marketHistoryStatus: "checked",
    drawdownFromHighPct: -2,
    liquiditySnapshotStatus: "checked"
  });
  assert.equal(result.level, "watch");
  assert.match(result.reason, /不因涨幅拦截/);
});

test("price risk sends sustained sell pressure to review even before hourly price turns negative", () => {
  const priceRisk = loadDashboardPriceRisk();
  const result = priceRisk({
    priceChange1h: 35,
    priceChange5m: 2,
    priceChange15m: 8,
    buys1h: 10,
    sells1h: 18
  });
  assert.equal(result.level, "review");
  assert.match(result.reason, /卖出次数/);
});

test("price risk still blocks a severe short-window dump", () => {
  const priceRisk = loadDashboardPriceRisk();
  const result = priceRisk({
    priceChange1h: 45,
    priceChange5m: -14,
    priceChange15m: 8,
    buys1h: 20,
    sells1h: 8
  });
  assert.equal(result.level, "blocked");
});

test("four user-reported Solana dump cases are retained as regression sample identifiers", () => {
  assert.equal(REGRESSION_SAMPLE_MINTS.length, 4);
  assert.equal(new Set(REGRESSION_SAMPLE_MINTS).size, 4);
  for (const mint of REGRESSION_SAMPLE_MINTS) {
    assert.match(mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  }
});


test("pool-risk computes high-water drawdown and short-window changes from GeckoTerminal minute candles", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.geckoterminal.com");
    assert.match(url.pathname, /\/networks\/solana\/pools\/TestPool\/ohlcv\/minute$/);
    assert.equal(url.searchParams.get("aggregate"), "1");
    assert.equal(url.searchParams.get("currency"), "usd");
    assert.equal(url.searchParams.get("token"), "TestMint");
    const now = Math.floor(Date.now() / 1000);
    const rows = [];
    for (let minutesAgo = 0; minutesAgo < 60; minutesAgo++) {
      let close = 50;
      if (minutesAgo === 15) close = 90;
      else if (minutesAgo === 5) close = 80;
      else if (minutesAgo === 0) close = 70;
      else if (minutesAgo < 20) close = 75;
      const high = minutesAgo === 8 ? 100 : close + 2;
      rows.push([now - minutesAgo * 60, close, high, close - 1, close, 1000]);
    }
    return response({ data: { attributes: { ohlcv_list: rows } } });
  };
  const res = await worker.fetch(request(
    "/pool-risk?chain=solana&pool=TestPool&token=TestMint"
  ), {});
  const data = await res.json();
  assert.equal(data.status, "checked");
  assert.equal(data.candleCount, 60);
  assert.equal(data.drawdownFromHighPct, -30);
  assert.equal(data.priceChange5m, -12.5);
  assert.equal(Number(data.priceChange15m.toFixed(2)), -22.22);
  assert.ok(Math.abs(data.priceChange1h - 40) < 0.01);
});

test("pool-risk marks insufficient candle history as unverified instead of clear", async () => {
  globalThis.fetch = async () => response({
    data: { attributes: { ohlcv_list: [
      [Math.floor(Date.now() / 1000), 1, 1.1, 0.9, 1, 10],
      [Math.floor(Date.now() / 1000) - 60, 0.9, 1, 0.8, 0.9, 10]
    ] } }
  });
  const res = await worker.fetch(request(
    "/pool-risk?chain=base&pool=TestPool&token=TestMint"
  ), {});
  const data = await res.json();
  assert.equal(data.status, "insufficient");
  assert.equal(data.candleCount, 2);
  assert.match(data.error, /不足5根/);
});

test("pool-risk validates supported networks and required pool/token identifiers", async () => {
  const badNetwork = await worker.fetch(request(
    "/pool-risk?chain=unknown&pool=TestPool&token=TestMint"
  ), {});
  assert.equal(badNetwork.status, 400);
  const missingPool = await worker.fetch(request(
    "/pool-risk?chain=bsc&token=TestMint"
  ), {});
  assert.equal(missingPool.status, 400);
});


test("price risk reviews and blocks drawdowns from observed candle highs", () => {
  const priceRisk = loadDashboardPriceRisk();
  const review = priceRisk({
    priceChange1h: 120,
    priceChange5m: 1,
    priceChange15m: 4,
    drawdownFromHighPct: -25,
    marketHistoryStatus: "checked",
    liquiditySnapshotStatus: "checked",
    buys1h: 30,
    sells1h: 10
  });
  assert.equal(review.level, "review");
  assert.match(review.reason, /高点回撤复核/);

  const blocked = priceRisk({
    priceChange1h: 120,
    priceChange5m: 1,
    priceChange15m: 4,
    drawdownFromHighPct: -36,
    marketHistoryStatus: "checked",
    buys1h: 30,
    sells1h: 10
  });
  assert.equal(blocked.level, "blocked");
  assert.match(blocked.reason, /高点回撤拦截/);
});


test("pool-risk records per-pool liquidity snapshots and detects a 30 percent five-minute drain", async () => {
  const originalNow = Date.now;
  const store = new Map();
  const kv = {
    async get(key, type) {
      assert.equal(type, "json");
      return store.has(key) ? JSON.parse(store.get(key)) : null;
    },
    async put(key, value, options) {
      assert.equal(options.expirationTtl, 86400);
      store.set(key, value);
    }
  };
  const baseTime = 1_800_000_000_000;
  Date.now = () => baseTime;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.geckoterminal.com");
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 60 }, (_, index) => {
      const close = 1;
      return [now - index * 60, close, 1.1, 0.9, close, 100];
    });
    return response({ data: { attributes: { ohlcv_list: rows } } });
  };
  try {
    const first = await worker.fetch(request(
      "/pool-risk?chain=solana&pool=TestPool&token=TestMint&liquidity=10000"
    ), { RADAR_KV: kv });
    const firstData = await first.json();
    assert.equal(firstData.liquiditySnapshot.status, "collecting");
    assert.equal(firstData.liquiditySnapshot.snapshotCount, 1);

    Date.now = () => baseTime + 5 * 60 * 1000;
    const second = await worker.fetch(request(
      "/pool-risk?chain=solana&pool=TestPool&token=TestMint&liquidity=7000"
    ), { RADAR_KV: kv });
    const secondData = await second.json();
    assert.equal(secondData.liquiditySnapshot.status, "checked");
    assert.equal(secondData.liquiditySnapshot.snapshotCount, 2);
    assert.equal(secondData.liquiditySnapshot.liquidityChange5mPct, -30);
  } finally {
    Date.now = originalNow;
  }
});

test("pool-risk explicitly reports KV binding as unconfigured instead of treating liquidity as checked", async () => {
  globalThis.fetch = async () => response({
    data: { attributes: { ohlcv_list: [] } }
  });
  const res = await worker.fetch(request(
    "/pool-risk?chain=bsc&pool=TestPool&token=TestMint&liquidity=5000"
  ), {});
  const data = await res.json();
  assert.equal(data.liquiditySnapshot.status, "not_configured");
  assert.match(data.liquiditySnapshot.error, /RADAR_KV/);
});

test("price risk reviews and blocks rapid liquidity drains without capping positive price gains", () => {
  const priceRisk = loadDashboardPriceRisk();
  const review = priceRisk({
    priceChange1h: 150,
    priceChange5m: 2,
    priceChange15m: 5,
    buys1h: 30,
    sells1h: 10,
    marketHistoryStatus: "checked",
    drawdownFromHighPct: -3,
    liquiditySnapshotStatus: "checked",
    liquidityChange5mPct: -25
  });
  assert.equal(review.level, "review");
  assert.match(review.reason, /流动性减少/);

  const blocked = priceRisk({
    priceChange1h: 150,
    priceChange5m: 2,
    priceChange15m: 5,
    buys1h: 30,
    sells1h: 10,
    marketHistoryStatus: "checked",
    drawdownFromHighPct: -3,
    liquiditySnapshotStatus: "checked",
    liquidityChange5mPct: -45
  });
  assert.equal(blocked.level, "blocked");
  assert.match(blocked.reason, /LP快速流失拦截/);
});
