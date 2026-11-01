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
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === "api.gopluslabs.io") return response({ code: 1, result: { "0x1111111111111111111111111111111111111111": { holders: Array.from({ length: 10 }, () => ({ percent: "0.01" })) } } });
    return response({
      simulationSuccess: true,
      simulationResult: { buyTax: 0, sellTax: 0 },
      honeypotResult: { isHoneypot: false },
      summary: { riskLevel: 10, flags: [] },
      contractCode: { rootOpenSource: true }
    });
  };
  const res = await worker.fetch(request("/security-check?chain=bsc&address=0x1111111111111111111111111111111111111111"), env);
  const data = await res.json();
  assert.equal(data.status, "pass");
});

test("EVM security gate sends missing source verification to review", async () => {
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === "api.gopluslabs.io") return response({ code: 1, result: { "0x1111111111111111111111111111111111111111": { holders: Array.from({ length: 10 }, () => ({ percent: "0.01" })) } } });
    return response({
      simulationSuccess: true,
      simulationResult: { buyTax: 0, sellTax: 0 },
      honeypotResult: { isHoneypot: false },
      summary: { riskLevel: 10, flags: [] }
    });
  };
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


test("EVM GoPlus concentration check still blocks when Honeypot.is is unavailable", async () => {
  const requestedHosts = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requestedHosts.push(url.hostname);
    if (url.hostname === "api.honeypot.is") return new Response("temporarily unavailable", { status: 503 });
    if (url.hostname === "api.gopluslabs.io") {
      return response({ code: 1, result: { "0x1111111111111111111111111111111111111111": {
        holders: Array.from({ length: 10 }, (_, i) => ({ percent: i === 0 ? "0.84" : "0.01" }))
      } } });
    }
    throw new Error("Unexpected provider " + url.hostname);
  };
  const res = await worker.fetch(request("/security-check?chain=bsc&address=0x1111111111111111111111111111111111111111"), env);
  const data = await res.json();
  assert.ok(requestedHosts.includes("api.honeypot.is"));
  assert.ok(requestedHosts.includes("api.gopluslabs.io"));
  assert.equal(data.top10HolderConcentrationPct, 93);
  assert.equal(data.holderConcentrationStatus, "high");
  assert.equal(data.status, "blocked");
  assert.match(data.honeypotError, /HTTP 503/);
});

test("EVM top-ten concentration at or above 80 percent is blocked", async () => {
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === "api.gopluslabs.io") return response({ code: 1, result: { "0x1111111111111111111111111111111111111111": { holders: Array.from({ length: 10 }, (_, i) => ({ percent: i === 0 ? "0.75" : "0.01" })) } } });
    return response({ simulationSuccess: true, simulationResult: { buyTax: 0, sellTax: 0 }, honeypotResult: { isHoneypot: false }, summary: { riskLevel: 10, flags: [] }, contractCode: { rootOpenSource: true } });
  };
  const res = await worker.fetch(request("/security-check?chain=bsc&address=0x1111111111111111111111111111111111111111"), env);
  const data = await res.json();
  assert.equal(data.top10HolderConcentrationPct, 84);
  assert.equal(data.holderConcentrationStatus, "high");
  assert.equal(data.status, "blocked");
});

test("EVM security response exposes Honeypot and GoPlus provider failures", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.honeypot.is") return new Response("not found", { status: 404 });
    if (url.hostname === "api.gopluslabs.io") return new Response(JSON.stringify({ code: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error("Unexpected provider " + url.hostname);
  };
  const res = await worker.fetch(request("/security-check?chain=bsc&address=0x1111111111111111111111111111111111111111"), env);
  const data = await res.json();
  assert.equal(data.status, "review");
  assert.equal(data.honeypotHttpStatus, 404);
  assert.equal(data.holderProviderStatus, "no_token_data");
  assert.match(data.reasons.join(" "), /GoPlus持币数据源状态/);
});

test("EVM missing top-holder data remains in review", async () => {
  globalThis.fetch = async (input) => {
    if (new URL(input).hostname === "api.gopluslabs.io") return response({ code: 1, result: {} });
    return response({ simulationSuccess: true, simulationResult: { buyTax: 0, sellTax: 0 }, honeypotResult: { isHoneypot: false }, summary: { riskLevel: 10, flags: [] }, contractCode: { rootOpenSource: true } });
  };
  const res = await worker.fetch(request("/security-check?chain=bsc&address=0x1111111111111111111111111111111111111111"), env);
  const data = await res.json();
  assert.equal(data.holderConcentrationStatus, "unknown");
  assert.equal(data.status, "review");
});

test("Solana top-ten holder concentration at or above 80 percent is blocked", async () => {
  globalThis.fetch = async () => response({
    tokenProgram: "spl-token", risks: [], score_normalised: 1, lpLockedPct: 95,
    mintAuthority: null, freezeAuthority: null,
    topHolders: Array.from({ length: 10 }, (_, i) => ({ pct: i === 0 ? 75 : 1 }))
  });
  const res = await worker.fetch(request("/security-check?chain=solana&address=So11111111111111111111111111111111111111112"), env);
  const data = await res.json();
  assert.equal(data.top10HolderConcentrationPct, 84);
  assert.equal(data.holderConcentrationStatus, "high");
  assert.equal(data.status, "blocked");
});

test("non-BSC preflight requests do not depend on the NodeReal secret", async () => {
  const req = new Request("https://worker.test/multiscan", { method: "OPTIONS" });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("multiscan supports Solana-only stable scope without querying Ethereum or Base", async () => {
  const requestedChains = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.geckoterminal.com") {
      const chain = url.pathname.split("/")[4];
      requestedChains.push(chain);
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    if (url.hostname === "api.dexscreener.com") return response([]);
    if (url.hostname === "api.dexpaprika.com") return new Response("rate limited", { status: 429 });
    throw new Error("Unexpected URL " + url.href);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {});
  const data = await res.json();
  assert.deepEqual(data.chains, ["Solana"]);
  assert.deepEqual(data.chainErrors.map(item => item.chain), ["Solana"]);
  assert.deepEqual(requestedChains, ["solana"]);
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
    assert.equal(paprikaCalls, 1, "the first HTTP 402 should activate provider-wide quota cooldown immediately");

    const second = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
    const secondData = await second.json();
    assert.equal(secondData.complete, false);
    assert.ok(secondData.chainErrors.every(error => error.error.includes("HTTP 402")));
    assert.equal(paprikaCalls, 1, "cached 402 responses and provider cooldown should suppress repeated provider requests");
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

test("price risk blocks a regular early pump followed by a sharp reversal", () => {
  const priceRisk = loadDashboardPriceRisk();
  const result = priceRisk({
    trendSignals: { pumpThenDump: true, peakToCurrentDrawdownPct: -38, prePeakGainPct: 65, postPeakCandleCount: 2 }
  });
  assert.equal(result.level, "blocked");
  assert.match(result.reason, /拉高砸盘/);
});

test("price risk blocks a sustained gradual decline instead of waiting for one crash candle", () => {
  const priceRisk = loadDashboardPriceRisk();
  const result = priceRisk({
    trendSignals: { gradualDecline: true, trendNetChangePct: -28, downMoveRatio: 0.9, trendCandleCount: 10 }
  });
  assert.equal(result.level, "blocked");
  assert.match(result.reason, /持续阴跌/);
});

test("price risk reviews an emerging pump-and-dump reversal before the hard block threshold", () => {
  const priceRisk = loadDashboardPriceRisk();
  const result = priceRisk({
    trendSignals: { pumpThenDump: true, peakToCurrentDrawdownPct: -24, prePeakGainPct: 50, postPeakCandleCount: 1 }
  });
  assert.equal(result.level, "review");
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


test("wallet-flow counts distinct buyers and flags concentrated early buy volume", async () => {
  globalThis.fetch=async(input)=>{
    const url=new URL(input);
    assert.equal(url.hostname,"api.geckoterminal.com");
    assert.match(url.pathname,/\/networks\/bsc\/pools\/0x2222222222222222222222222222222222222222\/trades$/);
    const token="0x1111111111111111111111111111111111111111";
    const rows=[];
    for(let i=0;i<10;i++)rows.push({attributes:{
      tx_from_address:"0x"+String(i+1).padStart(40,"0"),
      from_token_address:"0x9999999999999999999999999999999999999999",
      to_token_address:token,volume_in_usd:i<3?"30":"1",
      block_timestamp:new Date(Date.now()-i*60000).toISOString()
    }});
    rows.push({attributes:{
      tx_from_address:"0x"+"1".padStart(40,"0"),from_token_address:token,
      to_token_address:"0x9999999999999999999999999999999999999999",
      volume_in_usd:"5",block_timestamp:new Date().toISOString()
    }});
    return response({data:rows});
  };
  const res=await worker.fetch(request("/wallet-flow?chain=bsc&pool=0x2222222222222222222222222222222222222222&token=0x1111111111111111111111111111111111111111"),{});
  const data=await res.json();
  assert.equal(data.walletFlow.status,"checked");
  assert.equal(data.walletFlow.uniqueBuyers,10);
  assert.equal(data.walletFlow.uniqueSellers,1);
  assert.equal(data.walletFlow.walletsBuyingAndSelling,1);
  assert.ok(data.walletFlow.top3BuySharePct>=60);
  assert.ok(data.walletFlow.warnings.some(x=>x.includes("前三大买入钱包")));
});

test("wallet-flow keeps small trade samples insufficient and never calls them healthy", async () => {
  globalThis.fetch=async()=>response({data:[{attributes:{
    tx_from_address:"0x1111111111111111111111111111111111111111",
    from_token_address:"0x9999999999999999999999999999999999999999",
    to_token_address:"0x2222222222222222222222222222222222222222",
    volume_in_usd:"10"
  }}]});
  const res=await worker.fetch(request("/wallet-flow?chain=bsc&pool=0x3333333333333333333333333333333333333333&token=0x2222222222222222222222222222222222222222"),{});
  const data=await res.json();
  assert.equal(data.walletFlow.status,"insufficient");
  assert.equal(data.walletFlow.sampleTrades,1);
  assert.deepEqual(data.walletFlow.warnings,[]);
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

test("pool-risk identifies a strong early rise followed by a sharp dump", async () => {
  globalThis.fetch = async () => {
    const now = Math.floor(Date.now() / 1000);
    const closes = [1, 1.2, 1.4, 1.6, 1.8, 1.9, 1.2, 1.0];
    const rows = closes.map((close, index) => [
      now - (closes.length - index - 1) * 60,
      index ? closes[index - 1] : close,
      index === 5 ? 2.0 : close * 1.03,
      close * 0.97,
      close,
      100
    ]);
    return response({ data: { attributes: { ohlcv_list: rows } } });
  };
  const res = await worker.fetch(request("/pool-risk?chain=bsc&pool=TestPool&token=TestToken"), {});
  const data = await res.json();
  assert.equal(data.status, "checked");
  assert.equal(data.trendSignals.pumpThenDump, true);
  assert.ok(data.trendSignals.peakToCurrentDrawdownPct <= -40);
});

test("pool-risk identifies a persistent gradual decline without a single crash candle", async () => {
  globalThis.fetch = async () => {
    const now = Math.floor(Date.now() / 1000);
    const closes = [1, 0.96, 0.92, 0.88, 0.84, 0.80, 0.76];
    const rows = closes.map((close, index) => [
      now - (closes.length - index - 1) * 60,
      index ? closes[index - 1] : close,
      close * 1.01,
      close * 0.99,
      close,
      100
    ]);
    return response({ data: { attributes: { ohlcv_list: rows } } });
  };
  const res = await worker.fetch(request("/pool-risk?chain=bsc&pool=TestPool&token=TestToken"), {});
  const data = await res.json();
  assert.equal(data.status, "checked");
  assert.equal(data.trendSignals.gradualDecline, true);
  assert.ok(data.trendSignals.trendNetChangePct <= -20);
  assert.equal(data.trendSignals.downMoveRatio, 1);
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


test("multiscan uses configured Ethereum and Base RPC fallback after public indexes fail", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = "0x1111111111111111111111111111111111111111";
  const pair = "0x2222222222222222222222222222222222222222";
  const pad = (value) => value.toString(16).padStart(64, "0");
  const bytes32 = (value) => "0x" + Buffer.from(value, "utf8").toString("hex").padEnd(64, "0");
  const rpcFetch = async (url, body) => {
    const method = body.method;
    if (method === "eth_blockNumber") return response({ jsonrpc: "2.0", id: 1, result: "0x1000" });
    if (method === "eth_getBlockByNumber") {
      const n = body.params[0];
      const timestamp = n === "0x0" ? nowSeconds - 12000 : nowSeconds;
      return response({ jsonrpc: "2.0", id: 1, result: { timestamp: "0x" + timestamp.toString(16) } });
    }
    if (method === "eth_getLogs") {
      const filter = body.params[0];
      const rangeSize = parseInt(filter.toBlock, 16) - parseInt(filter.fromBlock, 16) + 1;
      assert.ok(rangeSize <= 10, "Alchemy Free eth_getLogs range must not exceed 10 blocks");
      const quote = url.includes("eth-rpc") 
        ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
        : "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
      return response({ jsonrpc: "2.0", id: 1, result: [{
        address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
        topics: [ "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
          "0x" + quote.slice(2).padStart(64, "0"),
          "0x" + token.slice(2).padStart(64, "0") ],
        data: "0x" + pair.slice(2).padStart(64, "0"),
        blockNumber: "0x1000"
      }] });
    }
    if (method === "eth_call") {
      const selector = body.params[0].data;
      if (selector === "0x0902f1ac") return response({ jsonrpc: "2.0", id: 1, result: "0x" + pad(10_000_000_000n) + pad(1_000_000_000_000_000_000n) + pad(BigInt(nowSeconds)) });
      if (selector === "0x95d89b41") return response({ jsonrpc: "2.0", id: 1, result: bytes32("TST") });
      if (selector === "0x06fdde03") return response({ jsonrpc: "2.0", id: 1, result: bytes32("Test token") });
      if (selector === "0x313ce567") return response({ jsonrpc: "2.0", id: 1, result: "0x12" });
    }
    throw new Error("Unexpected RPC method " + method);
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] }, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({}, 429);
    if (url.includes("eth-rpc.invalid") || url.includes("base-rpc.invalid")) {
      const body = JSON.parse(init.body);
      return rpcFetch(url, body);
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {
    ETH_RPC_URL: "https://eth-rpc.invalid",
    BASE_RPC_URL: "https://base-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.evmRpcDiagnostics.some(item => item.chain === "Ethereum" && item.status === "ok"), JSON.stringify({ diagnostics: data.evmRpcDiagnostics, errors: data.chainErrors }));
  assert.ok(data.evmRpcDiagnostics.some(item => item.chain === "Base" && item.status === "ok"));
  assert.ok(data.evmRpcDiagnostics.filter(item => ["Ethereum", "Base"].includes(item.chain)).every(item => item.chunkSize === 10 && item.chunksScanned > 0));
  assert.ok(data.pools.some(item => item.chain === "Ethereum" && item.source.includes("Ethereum RPC")));
  assert.ok(data.pools.some(item => item.chain === "Base" && item.source.includes("Base RPC")));
  assert.ok(data.pools.every(item => item.volume1hUSD === null));
});

test("multiscan explicitly reports missing Ethereum and Base RPC secrets", async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({}, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({}, 429);
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?minutes=15"), {});
  const data = await res.json();
  assert.ok(data.evmRpcDiagnostics.some(item => item.chain === "Ethereum" && item.requiredSecret === "ETH_RPC_URL"));
  assert.ok(data.evmRpcDiagnostics.some(item => item.chain === "Base" && item.requiredSecret === "BASE_RPC_URL"));
});


test("BSC scan uses a timestamp-bounded window and recognizes the canonical USDT contract", async () => {
  const latest = 10000;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const meme = "0x1111111111111111111111111111111111111111";
  const padTopic = (address) => "0x" + address.slice(2).toLowerCase().padStart(64, "0");
  const pancakeV2 = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73";
  globalThis.fetch = async (input, init = {}) => {
    const body = JSON.parse(init.body);
    const method = body.method;
    if (method === "eth_blockNumber") {
      return response({ jsonrpc: "2.0", id: 1, result: "0x" + latest.toString(16) });
    }
    if (method === "eth_getBlockByNumber") {
      const n = parseInt(body.params[0], 16);
      const timestamp = Math.floor(nowSeconds - (latest - n) * 0.45);
      return response({ jsonrpc: "2.0", id: 1, result: { timestamp: "0x" + timestamp.toString(16) } });
    }
    if (method === "eth_getLogs") {
      const filter = body.params[0];
      const filterAddresses = Array.isArray(filter.address) ? filter.address.map((x) => x.toLowerCase()) : [String(filter.address).toLowerCase()];
      if (filterAddresses.includes(pancakeV2) && filter.topics[0] === "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9") {
        const pairLog = (quote, token, tx) => ({
          address: pancakeV2,
          topics: [
            "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
            padTopic(quote), padTopic(token)
          ],
          data: "0x" + "0".repeat(64) + "0".repeat(64),
          blockNumber: "0x" + latest.toString(16),
          transactionHash: "0x" + tx.repeat(64),
          logIndex: "0x0"
        });
        const usdt = "0x55d398326f99059ff775485246999027b3197955";
        return response({ jsonrpc: "2.0", id: 1, result: [
          pairLog(wbnb, meme, "1"),
          pairLog(usdt, meme, "2")
        ] });
      }
      return response({ jsonrpc: "2.0", id: 1, result: [] });
    }
    if (method === "eth_call") {
      return response({ jsonrpc: "2.0", id: 1, result: "0x" });
    }
    if (method === "eth_getCode") {
      return response({ jsonrpc: "2.0", id: 1, result: "0x6000" });
    }
    throw new Error("Unexpected BSC RPC method " + method);
  };
  const res = await worker.fetch(request("/scan?minutes=15&minLiquidity=5000"), env);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.minutes, 15);
  assert.equal(data.usdtPoolEventsFound.v2["PancakeSwap V2"], 1,
    "the canonical BSC USDT contract must be recognized in PairCreated topics");
  assert.equal(data.quoteAssetDiagnostics.WBNB.total, 1);
  assert.equal(data.quoteAssetDiagnostics.USDT.total, 1);
  assert.equal(data.count, 0, "zero-liquidity pools must not enter candidates");
  assert.ok(data.actualWindowSeconds >= 900);
  assert.ok(data.actualWindowSeconds < 901);
  assert.equal(data.requestedWindowSeconds, 900);
  assert.ok(data.windowStartBlock < data.latestBlock);
});


test("GoPlus provider-wide rate-limit cooldown prevents requests for other token addresses", async () => {
  const values = new Map();
  const kv = {
    async get(key) {
      const value = values.get(key);
      return value == null ? null : JSON.parse(value);
    },
    async put(key, value) {
      values.set(key, value);
    }
  };
  const envWithKv = { ...env, RADAR_KV: kv };
  let goPlusCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === "api.honeypot.is") return new Response("pair not found", { status: 404 });
    if (url.hostname === "api.gopluslabs.io") {
      goPlusCalls += 1;
      return response({ code: 0, message: "too many requests" });
    }
    throw new Error("Unexpected provider " + url.hostname);
  };

  const first = await worker.fetch(request("/security-check?chain=bsc&address=0x1111111111111111111111111111111111111111"), envWithKv);
  const firstData = await first.json();
  assert.equal(firstData.goPlusCacheStatus, "miss");
  assert.equal(firstData.goPlusCacheScope, "provider");
  assert.equal(firstData.goPlusKvStoreStatus, "provider-cooldown-stored");
  assert.equal(firstData.holderProviderStatus, "api_error");

  const second = await worker.fetch(request("/security-check?chain=bsc&address=0x2222222222222222222222222222222222222222"), envWithKv);
  const secondData = await second.json();
  assert.equal(secondData.goPlusCacheStatus, "rate-limit-cooldown");
  assert.equal(secondData.goPlusCacheScope, "provider");
  assert.equal(secondData.goPlusKvStoreStatus, "read-hit");
  assert.ok(secondData.goPlusCooldownSeconds > 0);
  assert.equal(goPlusCalls, 1);
  assert.equal(secondData.status, "review");
});


const SOLANA_TEST_MINT = "So11111111111111111111111111111111111111112";
const SOLANA_TEST_RPC_ENV = { ...env, SOLANA_RPC_URL: "https://solana-rpc.invalid.test" };
function solanaMintRpc(info, owner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
  return response({ result: { value: {
    owner,
    data: { parsed: { type: "mint", info } }
  } } });
}

test("Solana direct RPC evidence keeps an active mint authority in review even when RugCheck is unavailable", async () => {
  globalThis.fetch = async (input) => {
    const host = new URL(input).hostname;
    if (host === "api.rugcheck.xyz") return new Response("unavailable", { status: 503 });
    if (host === "solana-rpc.invalid.test") {
      return solanaMintRpc({
        mintAuthority: "Authority111111111111111111111111111111111",
        freezeAuthority: null,
        supply: "1000000000",
        decimals: 9
      });
    }
    throw new Error("Unexpected provider " + host);
  };
  const res = await worker.fetch(request("/security-check?chain=solana&address=" + SOLANA_TEST_MINT), SOLANA_TEST_RPC_ENV);
  const data = await res.json();
  assert.equal(data.status, "review");
  assert.equal(data.solanaRpcStatus, "ok");
  assert.equal(data.solanaMintAuthorityActive, true);
  assert.equal(data.solanaFreezeAuthorityActive, false);
  assert.ok(data.reasons.some(reason => reason.includes("Mint / Freeze Authority 仍有效")));
  assert.match(data.rugCheckError, /HTTP 503/);
});

test("Solana direct RPC reports unknown Token-2022 extensions as unassessed", async () => {
  globalThis.fetch = async (input) => {
    const host = new URL(input).hostname;
    if (host === "api.rugcheck.xyz") {
      return response({
        tokenProgram: "token-2022",
        mintAuthority: null,
        freezeAuthority: null,
        risks: [],
        score_normalised: 1,
        lpLockedPct: 100,
        topHolders: Array.from({ length: 10 }, () => ({ pct: 0.01 }))
      });
    }
    if (host === "solana-rpc.invalid.test") {
      return solanaMintRpc({
        mintAuthority: null,
        freezeAuthority: null,
        supply: "1000000000",
        decimals: 9,
        extensions: [{ extension: "FutureUnknownExtension" }]
      }, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    }
    throw new Error("Unexpected provider " + host);
  };
  const res = await worker.fetch(request("/security-check?chain=solana&address=" + SOLANA_TEST_MINT), SOLANA_TEST_RPC_ENV);
  const data = await res.json();
  assert.equal(data.status, "review");
  assert.equal(data.solanaTokenProgram, "token-2022");
  assert.deepEqual(data.solanaUnassessedExtensions, ["FutureUnknownExtension"]);
  assert.ok(data.reasons.some(reason => reason.includes("尚未评估的 Token-2022 扩展")));
});

test("Solana complete legacy mint evidence can complement a complete RugCheck report", async () => {
  globalThis.fetch = async (input) => {
    const host = new URL(input).hostname;
    if (host === "api.rugcheck.xyz") {
      return response({
        tokenProgram: "spl-token",
        mintAuthority: null,
        freezeAuthority: null,
        risks: [],
        score_normalised: 1,
        lpLockedPct: 100,
        topHolders: Array.from({ length: 10 }, () => ({ pct: 0.01 }))
      });
    }
    if (host === "solana-rpc.invalid.test") {
      return solanaMintRpc({
        mintAuthority: null,
        freezeAuthority: null,
        supply: "1000000000",
        decimals: 9
      });
    }
    throw new Error("Unexpected provider " + host);
  };
  const res = await worker.fetch(request("/security-check?chain=solana&address=" + SOLANA_TEST_MINT), SOLANA_TEST_RPC_ENV);
  const data = await res.json();
  assert.equal(data.status, "pass");
  assert.equal(data.solanaRpcStatus, "ok");
  assert.equal(data.solanaMintAuthorityActive, false);
  assert.equal(data.solanaFreezeAuthorityActive, false);
});


function makeOhlcvRows(options = {}) {
  // End at the final minute of a completed 5-minute bucket so all four
  // comparison buckets have enough observations regardless of wall-clock minute.
  const latest = Math.floor(Date.now() / 300000) * 300 - 60;
  return Array.from({ length: 60 }, (_, index) => {
    const timestamp = latest - (59 - index) * 60;
    const basePrice = 1 + index * 0.0005 + index * index * 0.000002;
    const price = options.declining && index >= 50
      ? (1 + 49 * 0.0005 + 49 * 49 * 0.000002) * (1 - (index - 49) * 0.02)
      : basePrice;
    const volume = index >= 55 ? 30 : 10;
    return [timestamp, price, price * 1.002, price * 0.998, price, volume];
  }).reverse();
}

test("early trend score uses volume surge, buy pressure, acceleration and age with explicit confidence", async () => {
  const values = new Map();
  const kv = {
    async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; },
    async put(key, value) { values.set(key, value); }
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.hostname, "api.geckoterminal.com");
    return response({ data: { attributes: { ohlcv_list: makeOhlcvRows() } } });
  };
  const path = "/pool-risk?chain=bsc&pool=0x2222222222222222222222222222222222222222" +
    "&token=0x1111111111111111111111111111111111111111&liquidity=50000&buys=40&sells=10&age=12";
  const res = await worker.fetch(request(path), { ...env, RADAR_KV: kv });
  const data = await res.json();
  assert.equal(data.status, "checked");
  assert.equal(data.volumeMetrics.baselineBucketsComplete, true);
  assert.equal(data.volumeMetrics.volumeSurge5m, 3);
  assert.equal(data.trendScore.status, "checked");
  assert.equal(data.trendScore.confidence, 85);
  assert.ok(data.trendScore.score >= 0 && data.trendScore.score <= 100);
  assert.ok(data.trendScore.components.some(item => item.key === "buyPressure1h"));
  assert.ok(data.trendScore.components.some(item => item.key === "volumeSurge5m"));
  assert.equal(data.liquiditySnapshot.status, "collecting");
});

test("early trend score leaves missing buy/sell and age inputs unknown instead of assuming zero", async () => {
  globalThis.fetch = async () => response({
    data: { attributes: { ohlcv_list: makeOhlcvRows() } }
  });
  const path = "/pool-risk?chain=bsc&pool=0x2222222222222222222222222222222222222222" +
    "&token=0x1111111111111111111111111111111111111111";
  const res = await worker.fetch(request(path), env);
  const data = await res.json();
  assert.equal(data.trendScore.status, "insufficient");
  assert.equal(data.trendScore.score, null);
  assert.equal(data.trendScore.confidence, 55);
  assert.ok(!data.trendScore.components.some(item => item.key === "poolAge"));
  assert.ok(!data.trendScore.components.some(item => item.key === "buyPressure1h"));
});

test("early trend score penalizes persistent red-candle structure", async () => {
  const values = new Map();
  const kv = {
    async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; },
    async put(key, value) { values.set(key, value); }
  };
  globalThis.fetch = async () => response({
    data: { attributes: { ohlcv_list: makeOhlcvRows({ declining: true }) } }
  });
  const path = "/pool-risk?chain=bsc&pool=0x2222222222222222222222222222222222222222" +
    "&token=0x1111111111111111111111111111111111111111&liquidity=50000&buys=40&sells=10&age=12";
  const res = await worker.fetch(request(path), { ...env, RADAR_KV: kv });
  const data = await res.json();
  assert.equal(data.trendScore.status, "checked");
  const structure = data.trendScore.components.find(item => item.key === "trendStructure10m");
  assert.ok(structure);
  assert.ok(structure.score <= 35);
  assert.ok(data.trendScore.warnings.some(item => item.includes("短线连续收跌")));
  assert.equal(data.trendScore.confidence, 85);
});


test("multiscan cross-checks Solana program activity over RPC without promoting unverified mint hints to pools", async () => {
  const now = Math.floor(Date.now() / 1000);
  const mint = "So11111111111111111111111111111111111111112";
  let rpcCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] }, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({ error: "quota" }, 402);
    if (url.includes("solana-rpc.invalid")) {
      rpcCalls++;
      const body = JSON.parse(init.body);
      if (body.method === "getSignaturesForAddress") {
        return response({ jsonrpc: "2.0", id: 1, result: [{
          signature: "5".repeat(80),
          blockTime: now - 30,
          err: null
        }] });
      }
      if (body.method === "getTransaction") {
        return response({ jsonrpc: "2.0", id: 1, result: {
          transaction: { message: { instructions: [{
            program: "spl-token",
            parsed: { type: "initializeMint", info: { mint } }
          }] } },
          meta: {
            innerInstructions: [],
            logMessages: ["Program log: Instruction: InitializePool"]
          }
        } });
      }
      throw new Error("Unexpected Solana RPC method " + body.method);
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {
    SOLANA_RPC_URL: "https://solana-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.pools.length, 0, "RPC transaction hints must not become verified pool candidates");
  assert.equal(data.solanaRpcDiagnostics.length, 1);
  const diagnostics = data.solanaRpcDiagnostics[0];
  assert.equal(diagnostics.status, "ok");
  assert.equal(diagnostics.coverage, "pumpswap-create-pool-and-raydium-cpmm-initialize");
  assert.equal(diagnostics.candidatePoolsAdded, 0);
  assert.ok(diagnostics.programsChecked > 0);
  assert.ok(diagnostics.recentTransactions > 0);
  assert.ok(diagnostics.mintHints.includes(mint));
  assert.equal(rpcCalls, 12, "six program signature scans plus at most six transaction samples");
});

test("Solana RPC discovery stops immediately on HTTP 429 and reports unavailable evidence", async () => {
  let rpcCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] }, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({ error: "quota" }, 402);
    if (url.includes("solana-rpc.invalid")) {
      rpcCalls++;
      return response({ error: "rate limited" }, 429);
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {
    SOLANA_RPC_URL: "https://solana-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.pools.length, 0);
  assert.equal(data.solanaRpcDiagnostics[0].status, "error");
  assert.match(data.solanaRpcDiagnostics[0].error, /HTTP 429/);
  assert.equal(rpcCalls, 1, "do not hammer the RPC after its first 429");
});


test("Solana RPC applies cooldown when a 5xx retry is followed by HTTP 429", async () => {
  let rpcCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] }, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({ error: "quota" }, 402);
    if (url.includes("solana-rpc.invalid")) {
      rpcCalls++;
      return response({ error: "upstream unavailable" }, rpcCalls === 1 ? 503 : 429);
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {
    SOLANA_RPC_URL: "https://solana-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.solanaRpcDiagnostics[0].status, "error");
  assert.match(data.solanaRpcDiagnostics[0].error, /HTTP 429/);
  assert.equal(rpcCalls, 2, "retry only once, then stop on rate limit");
});


test("Solana RPC adds a Raydium CPMM pool only after instruction, pool owner, vault owner, and mint checks", async () => {
  const now = Math.floor(Date.now() / 1000);
  const pool = "B".repeat(32);
  const tokenMint = "C".repeat(32);
  const vault0 = "D".repeat(32);
  const vault1 = "E".repeat(32);
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const cpmm = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const keys = Array.from({ length: 20 }, () => "11111111111111111111111111111111");
  keys[3] = pool;
  keys[4] = tokenMint;
  keys[5] = usdc;
  keys[10] = vault0;
  keys[11] = vault1;
  keys[19] = cpmm;
  let rpcCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] }, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({ error: "quota" }, 402);
    if (url.includes("solana-rpc.invalid")) {
      rpcCalls++;
      const body = JSON.parse(init.body);
      if (body.method === "getSignaturesForAddress") {
        const program = body.params[0];
        return response({ jsonrpc: "2.0", id: 1, result: program === cpmm
          ? [{ signature: "5".repeat(80), blockTime: now - 30, err: null }]
          : [] });
      }
      if (body.method === "getTransaction") {
        return response({ jsonrpc: "2.0", id: 1, result: {
          transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })), instructions: [{
            programIdIndex: 19,
            accounts: Array.from({ length: 19 }, (_, index) => index),
            data: "CpoVi745fTaBD2WpXmJtRHQYhGB7LtkDRKkDg9YGfdPu"
          }] } },
          meta: { err: null, innerInstructions: [], logMessages: ["Program log: Instruction: Initialize"] }
        } });
      }
      if (body.method === "getMultipleAccounts") {
        assert.deepEqual(body.params[0], [pool, vault0, vault1]);
        return response({ jsonrpc: "2.0", id: 1, result: { value: [
          { owner: cpmm, data: ["", "base64"] },
          { owner: tokenProgram, data: { program: "spl-token", parsed: { type: "account", info: {
            mint: tokenMint, tokenAmount: { amount: "1000000000", decimals: 6, uiAmount: 1000, uiAmountString: "1000" }
          } } } },
          { owner: tokenProgram, data: { program: "spl-token", parsed: { type: "account", info: {
            mint: usdc, tokenAmount: { amount: "3000000000", decimals: 6, uiAmount: 3000, uiAmountString: "3000" }
          } } } }
        ] } });
      }
      throw new Error("Unexpected Solana RPC method " + body.method);
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {
    SOLANA_RPC_URL: "https://solana-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.pools.length, 1);
  const candidate = data.pools[0];
  assert.equal(candidate.chainId, "solana");
  assert.equal(candidate.dex, "Raydium CPMM");
  assert.equal(candidate.pairAddress, pool);
  assert.equal(candidate.tokenAddress, tokenMint);
  assert.equal(candidate.quoteSymbol, "USDC");
  assert.equal(candidate.liquidityUSDApprox, 6000);
  assert.equal(candidate.tokenSelectionVerified, true);
  assert.equal(candidate.marketHistoryStatus, "unavailable");
  assert.equal(data.solanaRpcDiagnostics[0].candidatePoolsAdded, 1);
  assert.equal(data.solanaRpcDiagnostics[0].protocolDecoders.raydiumCpmm.accountChecks, 1);
  assert.equal(rpcCalls, 8, "six program signature scans, one transaction lookup, and one pool/vault account lookup");
});

test("Solana RPC protocol decoder runs when the index returns HTTP 200 with no qualifying pools", async () => {
  let signatureScans = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] });
    if (url.includes("dexscreener.com")) return response([]);
    if (url.includes("dexpaprika.com")) return response({ pools: [] });
    if (url.includes("solana-rpc.invalid")) {
      const body = JSON.parse(init.body);
      if (body.method === "getSignaturesForAddress") {
        signatureScans++;
        return response({ jsonrpc: "2.0", id: 1, result: [] });
      }
      throw new Error("No transaction should be requested when there are no recent signatures");
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {
    SOLANA_RPC_URL: "https://solana-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.pools.length, 0);
  assert.equal(data.solanaRpcDiagnostics.length, 1);
  assert.equal(data.solanaRpcDiagnostics[0].status, "ok");
  assert.equal(signatureScans, 6, "empty successful index pages must still trigger the independent protocol cross-check");
});

test("Raydium CPMM pool decoder rejects mismatched vault mint associations", async () => {
  const now = Math.floor(Date.now() / 1000);
  const pool = "B".repeat(32);
  const tokenMint = "C".repeat(32);
  const wrongMint = "F".repeat(32);
  const vault0 = "D".repeat(32);
  const vault1 = "E".repeat(32);
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const cpmm = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const keys = Array.from({ length: 20 }, () => "11111111111111111111111111111111");
  keys[3] = pool; keys[4] = tokenMint; keys[5] = usdc; keys[10] = vault0; keys[11] = vault1; keys[19] = cpmm;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] }, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({ error: "quota" }, 402);
    if (url.includes("solana-rpc.invalid")) {
      const body = JSON.parse(init.body);
      if (body.method === "getSignaturesForAddress") return response({ jsonrpc: "2.0", id: 1, result:
        body.params[0] === cpmm ? [{ signature: "6".repeat(80), blockTime: now - 20, err: null }] : [] });
      if (body.method === "getTransaction") return response({ jsonrpc: "2.0", id: 1, result: {
        transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })), instructions: [{
          programIdIndex: 19, accounts: Array.from({ length: 19 }, (_, index) => index),
          data: "CpoVi745fTaBD2WpXmJtRHQYhGB7LtkDRKkDg9YGfdPu"
        }] } }, meta: { err: null, innerInstructions: [], logMessages: [] }
      } });
      if (body.method === "getMultipleAccounts") return response({ jsonrpc: "2.0", id: 1, result: { value: [
        { owner: cpmm, data: ["", "base64"] },
        { owner: tokenProgram, data: { parsed: { type: "account", info: {
          mint: wrongMint, tokenAmount: { amount: "1000000000", decimals: 6, uiAmountString: "1000" }
        } } } },
        { owner: tokenProgram, data: { parsed: { type: "account", info: {
          mint: usdc, tokenAmount: { amount: "3000000000", decimals: 6, uiAmountString: "3000" }
        } } } }
      ] } });
      throw new Error("Unexpected RPC method " + body.method);
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {
    SOLANA_RPC_URL: "https://solana-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.pools.length, 0, "mismatched vault mint must never be promoted to a candidate");
  assert.equal(data.solanaRpcDiagnostics[0].candidatePoolsAdded, 0);
  assert.equal(data.solanaRpcDiagnostics[0].protocolDecoders.raydiumCpmm.skipped, 1);
});

test("Solana RPC adds a PumpSwap pool only after create_pool, pool owner, vault owner, and mint checks", async () => {
  const now = Math.floor(Date.now() / 1000);
  const pool = "B".repeat(32);
  const tokenMint = "C".repeat(32);
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const baseVault = "D".repeat(32);
  const quoteVault = "E".repeat(32);
  const pumpSwap = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const keys = Array.from({ length: 19 }, () => "11111111111111111111111111111111");
  keys[0] = pool; keys[3] = tokenMint; keys[4] = usdc;
  keys[9] = baseVault; keys[10] = quoteVault; keys[18] = pumpSwap;
  let rpcCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] }, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({ error: "quota" }, 402);
    if (url.includes("solana-rpc.invalid")) {
      rpcCalls++;
      const body = JSON.parse(init.body);
      if (body.method === "getSignaturesForAddress") {
        return response({ jsonrpc: "2.0", id: 1, result: body.params[0] === pumpSwap
          ? [{ signature: "7".repeat(80), blockTime: now - 30, err: null }] : [] });
      }
      if (body.method === "getTransaction") return response({ jsonrpc: "2.0", id: 1, result: {
        transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })), instructions: [{
          programIdIndex: 18, accounts: Array.from({ length: 18 }, (_, index) => index),
          data: "g4xRkfehbgF"
        }] } }, meta: { err: null, innerInstructions: [], logMessages: ["Program log: Instruction: CreatePool"] }
      } });
      if (body.method === "getMultipleAccounts") {
        assert.deepEqual(body.params[0], [pool, baseVault, quoteVault]);
        return response({ jsonrpc: "2.0", id: 1, result: { value: [
          { owner: pumpSwap, data: ["", "base64"] },
          { owner: tokenProgram, data: { program: "spl-token", parsed: { type: "account", info: {
            mint: tokenMint, tokenAmount: { amount: "1000000000", decimals: 6, uiAmountString: "1000" }
          } } } },
          { owner: tokenProgram, data: { program: "spl-token", parsed: { type: "account", info: {
            mint: usdc, tokenAmount: { amount: "3000000000", decimals: 6, uiAmountString: "3000" }
          } } } }
        ] } });
      }
      throw new Error("Unexpected Solana RPC method " + body.method);
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {
    SOLANA_RPC_URL: "https://solana-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.pools.length, 1);
  const candidate = data.pools[0];
  assert.equal(candidate.dex, "PumpSwap");
  assert.equal(candidate.pairAddress, pool);
  assert.equal(candidate.tokenAddress, tokenMint);
  assert.equal(candidate.quoteSymbol, "USDC");
  assert.equal(candidate.liquidityUSDApprox, 6000);
  assert.equal(candidate.tokenSelectionVerified, true);
  assert.equal(candidate.marketHistoryStatus, "unavailable");
  assert.equal(data.solanaRpcDiagnostics[0].protocolDecoders.pumpSwap.accountChecks, 1);
  assert.equal(data.solanaRpcDiagnostics[0].candidatePoolsAdded, 1);
  assert.equal(rpcCalls, 8, "six program signature scans, one transaction lookup, and one pool/vault account lookup");
});

test("PumpSwap decoder rejects vaults whose parsed mint does not match create_pool", async () => {
  const now = Math.floor(Date.now() / 1000);
  const pool = "B".repeat(32);
  const tokenMint = "C".repeat(32);
  const wrongMint = "F".repeat(32);
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const baseVault = "D".repeat(32);
  const quoteVault = "E".repeat(32);
  const pumpSwap = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const keys = Array.from({ length: 19 }, () => "11111111111111111111111111111111");
  keys[0] = pool; keys[3] = tokenMint; keys[4] = usdc;
  keys[9] = baseVault; keys[10] = quoteVault; keys[18] = pumpSwap;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("geckoterminal.com")) return response({ data: [], included: [] }, 429);
    if (url.includes("dexscreener.com")) return response([], 200);
    if (url.includes("dexpaprika.com")) return response({ error: "quota" }, 402);
    if (url.includes("solana-rpc.invalid")) {
      const body = JSON.parse(init.body);
      if (body.method === "getSignaturesForAddress") return response({ jsonrpc: "2.0", id: 1, result:
        body.params[0] === pumpSwap ? [{ signature: "8".repeat(80), blockTime: now - 20, err: null }] : [] });
      if (body.method === "getTransaction") return response({ jsonrpc: "2.0", id: 1, result: {
        transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })), instructions: [{
          programIdIndex: 18, accounts: Array.from({ length: 18 }, (_, index) => index),
          data: "g4xRkfehbgF"
        }] } }, meta: { err: null, innerInstructions: [], logMessages: [] }
      } });
      if (body.method === "getMultipleAccounts") return response({ jsonrpc: "2.0", id: 1, result: { value: [
        { owner: pumpSwap, data: ["", "base64"] },
        { owner: tokenProgram, data: { parsed: { type: "account", info: {
          mint: wrongMint, tokenAmount: { amount: "1000000000", decimals: 6, uiAmountString: "1000" }
        } } } },
        { owner: tokenProgram, data: { parsed: { type: "account", info: {
          mint: usdc, tokenAmount: { amount: "3000000000", decimals: 6, uiAmountString: "3000" }
        } } } }
      ] } });
      throw new Error("Unexpected Solana RPC method " + body.method);
    }
    throw new Error("Unexpected URL " + url);
  };
  const res = await worker.fetch(request("/multiscan?chains=solana&minutes=15&minLiquidity=5000"), {
    SOLANA_RPC_URL: "https://solana-rpc.invalid"
  });
  const data = await res.json();
  assert.equal(data.pools.length, 0, "mismatched vault mint must never become a candidate");
  assert.equal(data.solanaRpcDiagnostics[0].protocolDecoders.pumpSwap.candidatesAdded, 0);
  assert.equal(data.solanaRpcDiagnostics[0].protocolDecoders.pumpSwap.skipped, 1);
});



test("BSC swap metrics avoid per-block RPC fanout and stay unknown on query failure", () => {
  const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  assert.ok(!source.includes("await mapLimit(allSwapBlocks"),
    "swap history must not trigger one block-time RPC request per distinct swap block");
  assert.ok(source.includes("volume1hUSD: swapError ? null : volume1hUSD"));
  assert.ok(source.includes("buys1h: swapError ? null : buys1h"));
  assert.ok(source.includes("sells1h: swapError ? null : sells1h"));
  assert.ok(source.includes("buyVolume1hUSD: swapError ? null : buyVolume1hUSD"));
  assert.ok(source.includes("sellVolume1hUSD: swapError ? null : sellVolume1hUSD"));
  assert.ok(source.includes("buySellVolumeRatio: swapError ? null : buySellVolumeRatio"));
  assert.ok(source.includes('swapStatsPeriod: "since_pool_creation"'));
  assert.ok(source.includes("swapStatsWindowMinutes"));
  assert.ok(source.includes("buy_only_no_sell_confirmation"));
  assert.ok(source.includes("strong_buy_sell_imbalance"));
  assert.ok(source.includes("swapStatsStatus: swapError ? \"unavailable\" : \"available\""));
});


test("BSC scan exposes candidate filter rejection counts and respects the per-scan inspection cap", () => {
  const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  assert.ok(source.includes("candidateFilterDiagnostics: candidateFilterDiagnostics"));
  assert.ok(source.includes("notInspectedWithinPerScanCap: Math.max(0, freshRows.length - inspected.length)"));
  assert.ok(source.includes("readErrors: inspected.filter((p) => p && p._error).length"));
  assert.ok(source.includes("eligibleAfterLiquidityFilter: eligible.length"));
  assert.ok(source.includes("Number.isFinite(p.liquidityUSD)"));
  assert.ok(source.includes("inspectedPools: inspected.slice(0, 20).map"));
  assert.ok(source.includes('status: p && p._error ? "read_error"'));
  assert.ok(source.includes("missingLiquidity: inspected.filter"));
  assert.ok(source.includes("const pairDataRaw = await mapLimit"));
  assert.ok(source.includes("const v3ReadRaw = await mapLimit"));
  assert.ok(source.includes("async function enrichTokenMetadata(pool, rpcUrl)"));
  assert.ok(source.includes("const validByLiquidity = pairData.filter"));
  assert.ok(source.includes("const v3ValidByLiquidity = v3Read.filter"));
  assert.ok(source.includes("Token metadata is deferred until after the liquidity"));
});
