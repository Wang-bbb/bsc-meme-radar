import test from "node:test";
import assert from "node:assert/strict";
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

test("multiscan retries GeckoTerminal rate limits without reporting a false empty success", async () => {
  const attempts = new Map();
  globalThis.fetch = async (input) => {
    const network = new URL(input).pathname.split("/")[4];
    const count = (attempts.get(network) || 0) + 1;
    attempts.set(network, count);
    if (count === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" }
      });
    }
    return response({ data: [], included: [] });
  };
  const res = await worker.fetch(request("/multiscan?minutes=15&minLiquidity=5000"), {});
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.complete, true);
  assert.equal(data.pools.length, 0);
  assert.deepEqual([...attempts.values()], [2, 2, 2]);
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
          price_change_percentage: { h1: "4.2" }
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
