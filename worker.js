const USDT = "0x55d398326f99059ff775485246999027b3197955";
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
// GoPlus responses are cached per chain/token to reduce public API rate limits.
// Successful security records live for 5 minutes; rate-limit responses cool down for 2 minutes.
async function fetchGoPlusCached(env, endpoint, cacheKey) {
  const kv = env && env.RADAR_KV;
  const providerCooldownKey = "security:goplus:provider-cooldown:v1";
  let kvStoreStatus = kv && typeof kv.get === "function" ? "read-ok" : "not-configured";

  // GoPlus rate limits can apply across different token addresses. Check a
  // provider-wide cooldown before making another request for any token.
  if (kv && typeof kv.get === "function") {
    try {
      const providerCooldown = await kv.get(providerCooldownKey, "json");
      if (providerCooldown && providerCooldown.expiresAt > Date.now()) {
        const remainingSeconds = Math.max(1, Math.ceil((providerCooldown.expiresAt - Date.now()) / 1000));
        return new Response(JSON.stringify({ code: 0, message: "too many requests (cached provider cooldown)" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-radar-goplus-cache": "rate-limit-cooldown",
            "x-radar-goplus-cache-scope": "provider",
            "x-radar-goplus-kv-store": "read-hit",
            "x-radar-goplus-cooldown-seconds": String(remainingSeconds)
          }
        });
      }
    } catch (_) {
      kvStoreStatus = "read-failed";
    }

    try {
      const cached = await kv.get(cacheKey, "json");
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.rateLimited) {
          return new Response(JSON.stringify({ code: 0, message: "too many requests (cached token cooldown)" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-radar-goplus-cache": "rate-limit-cooldown",
              "x-radar-goplus-cache-scope": "token",
              "x-radar-goplus-kv-store": "read-hit",
              "x-radar-goplus-cooldown-seconds": String(Math.max(1, Math.ceil((cached.expiresAt - Date.now()) / 1000)))
            }
          });
        }
        if (cached.body) {
          return new Response(JSON.stringify(cached.body), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-radar-goplus-cache": "hit",
              "x-radar-goplus-cache-scope": "token",
              "x-radar-goplus-kv-store": "read-hit"
            }
          });
        }
      }
    } catch (_) {
      kvStoreStatus = "read-failed";
    }
  }

  const response = await fetch(endpoint, { headers: { "accept": "application/json" } });
  let cacheStatus = "miss";
  let cacheScope = "none";
  if (response.ok && kv && typeof kv.put === "function") {
    try {
      const body = await response.clone().json();
      const message = String(body && (body.message || body.msg) || "").toLowerCase();
      const isRateLimited = body && body.code != null && String(body.code) !== "1" &&
        (message.includes("too many requests") || message.includes("rate limit") || message.includes("频率"));
      if (isRateLimited) {
        const expiresAt = Date.now() + 300000;
        await kv.put(providerCooldownKey, JSON.stringify({
          rateLimited: true,
          expiresAt,
          message: "GoPlus provider-wide rate limit"
        }), { expirationTtl: 300 });
        cacheScope = "provider";
        kvStoreStatus = "provider-cooldown-stored";
      } else if (body && (body.code == null || String(body.code) === "1") && body.result) {
        await kv.put(cacheKey, JSON.stringify({ body, expiresAt: Date.now() + 300000 }), { expirationTtl: 300 });
        cacheScope = "token";
        kvStoreStatus = "token-result-stored";
      } else {
        kvStoreStatus = "not-cacheable";
      }
    } catch (_) {
      kvStoreStatus = "write-failed";
    }
  } else if (!kv || typeof kv.put !== "function") {
    kvStoreStatus = "not-configured";
  }

  const headers = new Headers(response.headers);
  headers.set("x-radar-goplus-cache", cacheStatus);
  headers.set("x-radar-goplus-cache-scope", cacheScope);
  headers.set("x-radar-goplus-kv-store", kvStoreStatus);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// Cache API may reject caching upstream 429 responses. Store them as synthetic
// 200 responses with the original status in a header, then restore 429 on read.
function restoreCachedResponse(cached) {
  const originalStatus = Number(cached.headers.get("x-radar-original-status") || cached.status);
  if (originalStatus === cached.status) return cached;
  const headers = new Headers(cached.headers);
  headers.delete("x-radar-original-status");
  headers.delete("cache-control");
  const statusText = originalStatus === 402 ? "Payment Required"
    : originalStatus === 429 ? "Too Many Requests"
    : originalStatus === 403 ? "Forbidden"
    : originalStatus === 401 ? "Unauthorized" : cached.statusText;
  return new Response(cached.body, { status: originalStatus, statusText, headers });
}

const PROVIDER_COOLDOWN_SECONDS = 300;
function providerCooldownKey(provider) {
  return new Request("https://radar-cache.invalid/provider-cooldown/" + provider);
}
async function readProviderCooldown(provider) {
  if (typeof caches === "undefined" || !caches.default) return null;
  try {
    const cached = await caches.default.match(providerCooldownKey(provider));
    if (!cached) return null;
    const restored = restoreCachedResponse(cached);
    const headers = new Headers(restored.headers);
    headers.set("x-radar-provider-state", "shared-cooldown");
    headers.set("x-radar-provider", provider);
    return new Response(restored.body, { status: restored.status, statusText: restored.statusText, headers });
  } catch (_) { return null; }
}
async function writeProviderCooldown(provider, response) {
  if (typeof caches === "undefined" || !caches.default) return;
  const status = Number(response.status || 429);
  const retryAfter = Number(response.headers.get("retry-after") || 0);
  const baseTtl = status === 402 ? 600 : status >= 500 ? 60 : PROVIDER_COOLDOWN_SECONDS;
  const ttl = Math.min(900, Math.max(baseTtl, retryAfter || 0));
  const headers = new Headers({
    "x-radar-original-status": String(status),
    "cache-control": "public, max-age=" + ttl
  });
  try {
    await caches.default.put(providerCooldownKey(provider), new Response("Provider cooldown", { status: 200, headers }));
  } catch (_) {}
}

async function fetchGeckoTerminal(endpoint) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(endpoint, { method: "GET" });
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return restoreCachedResponse(cached);
    } catch (_) {}
  }
  const providerCooldown = await readProviderCooldown("geckoterminal");
  if (providerCooldown) {
    const headers = new Headers(providerCooldown.headers);
    headers.set("x-radar-provider-state", "shared-cooldown");
    headers.set("x-radar-provider", "GeckoTerminal");
    return new Response(providerCooldown.body, {
      status: providerCooldown.status,
      statusText: providerCooldown.statusText,
      headers
    });
  }

  let lastResponse;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(endpoint, {
      headers: { "accept": "application/json;version=20230203" }
    });
    // Do not immediately retry rate-limited public APIs: cache the 429 briefly
    // so repeated mobile refreshes do not amplify provider throttling.
    if (response.status === 429) {
      await writeProviderCooldown("geckoterminal", response);
      const stateHeaders = new Headers(response.headers);
      stateHeaders.set("x-radar-provider-state", "upstream-rate-limit");
      stateHeaders.set("x-radar-provider", "GeckoTerminal");
      const taggedResponse = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers: stateHeaders
      });
      if (cache) {
        const headers = new Headers(stateHeaders);
        headers.set("x-radar-original-status", "429");
        headers.set("cache-control", "public, max-age=15");
        try {
          await cache.put(cacheKey, new Response(response.clone().body, {
            status: 200, statusText: "OK", headers
          }));
        } catch (_) {}
      }
      return taggedResponse;
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
  if (lastResponse && lastResponse.status >= 500) await writeProviderCooldown("geckoterminal", lastResponse);
  return lastResponse || new Response("GeckoTerminal request failed", { status: 502 });
}

async function fetchDexPaprikaJson(endpoint) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(endpoint, { method: "GET" });
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const restored = restoreCachedResponse(cached);
        if (restored.status >= 400) {
          const headers = new Headers(restored.headers);
          headers.set("x-radar-provider-state", "cached-provider-error");
          headers.set("x-radar-provider", "DexPaprika");
          return new Response(restored.body, { status: restored.status, statusText: restored.statusText, headers });
        }
        return restored;
      }
    } catch (_) {}
  }
  const providerCooldown = await readProviderCooldown("dexpaprika");
  if (providerCooldown) return providerCooldown;
  const response = await fetch(endpoint, { headers: { "accept": "application/json" } });
  // Cache provider-side quota/auth failures too: retrying HTTP 402 on every
  // refresh cannot restore access and only adds noise to an already partial scan.
  if ([402, 429].includes(response.status) || response.status >= 500) await writeProviderCooldown("dexpaprika", response);
  if (cache && (response.ok || [401, 402, 403, 429].includes(response.status))) {
    const headers = new Headers(response.headers);
    const shouldCacheError = !response.ok;
    if (shouldCacheError) headers.set("x-radar-original-status", String(response.status));
    const ttl = response.status === 429 ? 30
      : [401, 402, 403].includes(response.status) ? 600 : 60;
    headers.set("cache-control", "public, max-age=" + ttl);
    try {
      await cache.put(cacheKey, new Response(response.clone().body, {
        status: shouldCacheError ? 200 : response.status,
        statusText: shouldCacheError ? "OK" : response.statusText,
        headers
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
      if (cached) {
        const restored = restoreCachedResponse(cached);
        if (restored.status >= 400) {
          const headers = new Headers(restored.headers);
          headers.set("x-radar-provider-state", "cached-provider-error");
          headers.set("x-radar-provider", "DexScreener");
          return new Response(restored.body, { status: restored.status, statusText: restored.statusText, headers });
        }
        return restored;
      }
    } catch (_) {}
  }
  const providerCooldown = await readProviderCooldown("dexscreener");
  if (providerCooldown) return providerCooldown;
  const response = await fetch(endpoint, { headers: { "accept": "application/json" } });
  if (response.status === 429 || response.status >= 500) await writeProviderCooldown("dexscreener", response);
  if (response.status === 429 && cache) {
    // Briefly cache rate-limit responses to prevent each chain fallback from
    // hammering the same shared profile/boost feeds on every refresh.
    const headers = new Headers(response.headers);
    headers.set("x-radar-original-status", "429");
    headers.set("cache-control", "public, max-age=15");
    try {
      await cache.put(cacheKey, new Response(response.clone().body, {
        status: 200, statusText: "OK", headers
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


const SOLANA_LEGACY_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLANA_KNOWN_EXTENSIONS = new Set([
  "transferfeeconfig", "transferhook", "permanentdelegate", "defaultaccountstate",
  "nontransferable", "confidentialtransfermint", "confidentialtransferfeeconfig",
  "pausableconfig", "mintcloseauthority", "metadatapointer", "tokenmetadata",
  "grouppointer", "tokengroup", "interestbearingconfig", "scaleduiamount"
]);
const SOLANA_RISKY_EXTENSIONS = new Set([
  "transferfeeconfig", "transferhook", "permanentdelegate", "defaultaccountstate",
  "nontransferable", "confidentialtransfermint", "confidentialtransferfeeconfig",
  "pausableconfig", "mintcloseauthority", "scaleduiamount"
]);

// Independent, read-only Solana mint evidence. A provider failure is returned
// as unknown evidence; it never becomes a clean/safe result.
async function fetchSolanaMintEvidence(env, address) {
  const unknown = { status: "unavailable", authorityFieldsPresent: false,
    mintAuthorityActive: null, freezeAuthorityActive: null, tokenProgram: null,
    extensionNames: [], riskyExtensions: [], unassessedExtensions: [],
    httpStatus: null, error: null };
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(address || ""))) {
    return { ...unknown, error: "Solana mint address format is invalid" };
  }
  const rpcUrl = String(env && env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
  if (!/^https:\/\//i.test(rpcUrl) || /\s/.test(rpcUrl)) {
    return { ...unknown, error: "Solana RPC endpoint configuration is invalid" };
  }
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [address, { encoding: "jsonParsed", commitment: "confirmed" }]
      })
    });
    if (!response.ok) {
      return { ...unknown, httpStatus: response.status, error: "Solana RPC HTTP " + response.status };
    }
    let body;
    try { body = await response.json(); }
    catch (_) { return { ...unknown, httpStatus: response.status, error: "Solana RPC returned invalid JSON" }; }
    if (body && body.error) {
      const code = body.error.code != null ? String(body.error.code).slice(0, 24) : "";
      return { ...unknown, httpStatus: response.status, error: "Solana RPC JSON-RPC error" + (code ? " (" + code + ")" : "") };
    }
    const value = body && body.result && body.result.value;
    if (!value) return { ...unknown, httpStatus: response.status, error: "Solana mint account not found" };
    const parsed = value.data && value.data.parsed;
    const info = parsed && parsed.info;
    if (!info || parsed.type !== "mint") {
      return { ...unknown, httpStatus: response.status, error: "Solana RPC did not return parsed mint data" };
    }
    const tokenProgram = value.owner === SOLANA_LEGACY_TOKEN_PROGRAM ? "spl-token"
      : value.owner === SOLANA_TOKEN_2022_PROGRAM ? "token-2022" : "unknown";
    const authorityFieldsPresent = Object.prototype.hasOwnProperty.call(info, "mintAuthority") &&
      Object.prototype.hasOwnProperty.call(info, "freezeAuthority");
    const extensionRows = Array.isArray(info.extensions) ? info.extensions : null;
    const extensionNames = [];
    const riskyExtensions = [];
    const unassessedExtensions = [];
    if (extensionRows) {
      for (const row of extensionRows) {
        const raw = row && (row.extension || row.type || row.kind);
        if (typeof raw !== "string" || !raw.trim()) {
          unassessedExtensions.push("unnamed-extension");
          continue;
        }
        const normalized = raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
        extensionNames.push(raw.slice(0, 48));
        if (SOLANA_RISKY_EXTENSIONS.has(normalized)) riskyExtensions.push(raw.slice(0, 48));
        if (!SOLANA_KNOWN_EXTENSIONS.has(normalized)) unassessedExtensions.push(raw.slice(0, 48));
      }
    }
    const extensionsComplete = tokenProgram !== "token-2022" || extensionRows !== null;
    const status = authorityFieldsPresent && tokenProgram !== "unknown" && extensionsComplete &&
      unassessedExtensions.length === 0 ? "ok" : "incomplete";
    return {
      status, httpStatus: response.status, error: null, tokenProgram,
      authorityFieldsPresent,
      mintAuthorityActive: authorityFieldsPresent ? info.mintAuthority != null : null,
      freezeAuthorityActive: authorityFieldsPresent ? info.freezeAuthority != null : null,
      extensionNames: [...new Set(extensionNames)],
      riskyExtensions: [...new Set(riskyExtensions)],
      unassessedExtensions: [...new Set(unassessedExtensions)]
    };
  } catch (_) {
    return { ...unknown, error: "Solana RPC request failed" };
  }
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

async function rpc(method, params, rpcUrl, networkLabel = "BSC") {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(networkLabel + " RPC HTTP " + response.status);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 700 * Math.pow(2, attempt)));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        // Read provider diagnostics without ever echoing the RPC URL or API key.
        const rawError = await response.text().catch(() => "");
        let providerError = null;
        try {
          const parsed = JSON.parse(rawError);
          providerError = parsed && parsed.error ? parsed.error : parsed;
        } catch (_) {}
        const safeMessage = providerError && typeof providerError.message === "string"
          ? providerError.message
          : "";
        const safeCode = providerError && (typeof providerError.code === "number" || typeof providerError.code === "string")
          ? String(providerError.code)
          : "";
        const sanitizedMessage = safeMessage
          .replace(/https?:\/\/[^\s"'<>]+/gi, "[endpoint]")
          .replace(/(api[_-]?key|apikey|token)=([^&\s]+)/gi, "$1=[redacted]")
          .replace(/\b(alch[a-z0-9_-]{8,})\b/gi, "[redacted]")
          .slice(0, 240);
        const detail = [safeCode, sanitizedMessage].filter(Boolean).join(": ");
        throw new Error(networkLabel + " RPC HTTP " + response.status + (detail ? " (" + detail + ")" : ""));
      }
      const body = await response.json();
      if (body.error) {
        const message = String(body.error.message || "JSON-RPC error")
          .replace(/https?:\/\/[^\s"'<>]+/gi, "[endpoint]")
          .replace(/(api[_-]?key|apikey|token)=([^&\s]+)/gi, "$1=[redacted]")
          .replace(/\b(alch[a-z0-9_-]{8,})\b/gi, "[redacted]")
          .slice(0, 240);
        throw new Error(networkLabel + " RPC " + String(body.error.code ?? "error") + ": " + message);
      }
      return body.result;
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !/429|fetch failed|network|timeout/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700 * Math.pow(2, attempt)));
    }
  }
  throw lastError || new Error(networkLabel + " RPC request failed");
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

async function blockTime(blockNumber, cache, rpcUrl, networkLabel = "BSC") {
  if (cache.has(blockNumber)) return cache.get(blockNumber);
  const block = await rpc("eth_getBlockByNumber", [hexNum(blockNumber), false], rpcUrl, networkLabel);
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


function summarizePoolWalletFlow(body, tokenAddress) {
  const rows=Array.isArray(body&&body.data)?body.data:[];
  const token=String(tokenAddress||"").toLowerCase();
  const wallets=new Map();
  let parsedTrades=0,totalBuyUsd=0,totalSellUsd=0,oldestTimestamp=null,newestTimestamp=null;
  for(const row of rows){
    const a=row&&row.attributes||{};
    const wallet=String(a.tx_from_address||a.tx_from||a.from_address||"").toLowerCase();
    if(!/^0x[a-f0-9]{40}$/.test(wallet)&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet))continue;
    const fromToken=String(a.from_token_address||"").toLowerCase();
    const toToken=String(a.to_token_address||"").toLowerCase();
    const kind=String(a.kind||"").toLowerCase();
    let side=null;
    if(toToken===token&&fromToken!==token)side="buy";
    else if(fromToken===token&&toToken!==token)side="sell";
    else if(kind==="buy"||kind==="sell")side=kind;
    if(!side)continue;
    const rawVolume=Number(a.volume_in_usd);
    const volume=Number.isFinite(rawVolume)&&rawVolume>0?rawVolume:0;
    const timestamp=Date.parse(a.block_timestamp||a.timestamp||"");
    if(Number.isFinite(timestamp)){
      oldestTimestamp=oldestTimestamp==null?timestamp:Math.min(oldestTimestamp,timestamp);
      newestTimestamp=newestTimestamp==null?timestamp:Math.max(newestTimestamp,timestamp);
    }
    const item=wallets.get(wallet)||{buys:0,sells:0,buyUsd:0,sellUsd:0};
    if(side==="buy"){item.buys++;item.buyUsd+=volume;totalBuyUsd+=volume;}
    else{item.sells++;item.sellUsd+=volume;totalSellUsd+=volume;}
    wallets.set(wallet,item);parsedTrades++;
  }
  const entries=Array.from(wallets.entries()).map(([address,value])=>({address,...value}));
  const buyers=entries.filter(x=>x.buys>0),sellers=entries.filter(x=>x.sells>0);
  const repeatBuyers=buyers.filter(x=>x.buys>=2);
  const topBuyers=buyers.slice().sort((a,b)=>b.buyUsd-a.buyUsd).slice(0,3);
  const top3BuySharePct=totalBuyUsd>0?Math.round(topBuyers.reduce((sum,x)=>sum+x.buyUsd,0)/totalBuyUsd*10000)/100:null;
  const overlapWallets=entries.filter(x=>x.buys>0&&x.sells>0).length;
  const coverageMinutes=oldestTimestamp!=null&&newestTimestamp!=null?Math.max(0,Math.round((newestTimestamp-oldestTimestamp)/60000)):null;
  const status=parsedTrades>=8?"checked":"insufficient";
  const warnings=[];
  if(status==="checked"&&top3BuySharePct!=null&&top3BuySharePct>=60)warnings.push("前三大买入钱包贡献了至少60%的样本买入额，买盘集中度偏高");
  if(status==="checked"&&buyers.length>=5&&sellers.length===0)warnings.push("样本中未观察到卖出钱包，退出流动性尚未得到验证");
  if(status==="checked"&&buyers.length>=4&&repeatBuyers.length/buyers.length>=0.6)warnings.push("买入活动集中在少数重复交易钱包，需排查重复刷量或关联行为");
  return {
    status,source:"GeckoTerminal pool trades",sampleTrades:parsedTrades,
    uniqueBuyers:buyers.length,uniqueSellers:sellers.length,repeatBuyerWallets:repeatBuyers.length,
    walletsBuyingAndSelling:overlapWallets,totalBuyVolumeUSD:Math.round(totalBuyUsd*100)/100,
    totalSellVolumeUSD:Math.round(totalSellUsd*100)/100,top3BuySharePct,coverageMinutes,warnings,
    limitations:[
      "仅统计索引源返回的有限交易样本，不代表完整链上钱包全集。",
      "钱包地址相同不等于同一控制人；本结果不推断钱包关联、开发者身份或内幕身份。",
      "样本不足、方向字段缺失或索引源限流时，不输出健康结论。"
    ]
  };
}
async function getPoolWalletFlow(network,poolAddress,tokenAddress){
  const endpoint="https://api.geckoterminal.com/api/v2/networks/"+encodeURIComponent(network)+
    "/pools/"+encodeURIComponent(poolAddress)+"/trades";
  const response=await fetchGeckoTerminal(endpoint);
  if(!response.ok)return{status:"unavailable",source:"GeckoTerminal pool trades",
    error:"GeckoTerminal trades HTTP "+response.status,sampleTrades:0,
    warnings:["钱包交易样本暂不可用；不能据此判断买盘质量"]};
  let body;
  try{body=await response.json();}
  catch(_){return{status:"unavailable",source:"GeckoTerminal pool trades",
    error:"交易样本响应不是有效JSON",sampleTrades:0,warnings:["钱包样本无法解析"]};}
  return summarizePoolWalletFlow(body,tokenAddress);
}

async function getPoolMarketHistory(network, poolAddress, tokenAddress) {
  const params = new URLSearchParams({
    aggregate: "1",
    limit: "60",
    currency: "usd",
    token: tokenAddress
  });
  const endpoint = "https://api.geckoterminal.com/api/v2/networks/" +
    encodeURIComponent(network) + "/pools/" + encodeURIComponent(poolAddress) +
    "/ohlcv/minute?" + params.toString();
  const response = await fetchGeckoTerminal(endpoint);
  if (!response.ok) {
    return { status: "unavailable", error: "GeckoTerminal OHLCV HTTP " + response.status };
  }
  const body = await response.json();
  const rows = body && body.data && body.data.attributes && body.data.attributes.ohlcv_list;
  if (!Array.isArray(rows)) {
    return { status: "unavailable", error: "OHLCV response missing data.attributes.ohlcv_list" };
  }
  const now = Math.floor(Date.now() / 1000);
  const candles = rows.map((row) => ({
    timestamp: Number(row && row[0]),
    open: Number(row && row[1]),
    high: Number(row && row[2]),
    low: Number(row && row[3]),
    close: Number(row && row[4]),
    volume: Number(row && row[5])
  })).filter((row) =>
    Number.isFinite(row.timestamp) &&
    Number.isFinite(row.open) && row.open > 0 &&
    Number.isFinite(row.high) && row.high > 0 &&
    Number.isFinite(row.low) && row.low > 0 &&
    Number.isFinite(row.close) && row.close > 0 &&
    row.timestamp <= now + 60 && row.timestamp >= now - 60 * 65
  ).sort((a, b) => a.timestamp - b.timestamp);
  const historyMinutes = candles.length > 1 ? Math.round((candles[candles.length - 1].timestamp - candles[0].timestamp) / 60) : 0;
  if (candles.length < 5 || historyMinutes < 4) {
    return {
      status: "insufficient",
      candleCount: candles.length,
      historyMinutes,
      error: "有效1分钟K线不足5根或覆盖不足4分钟，无法可靠计算高点回撤"
    };
  }
  const latest = candles[candles.length - 1];
  const oldest = candles[0];
  const maxHigh = Math.max(...candles.map((row) => row.high));
  const drawdownPct = (latest.close / maxHigh - 1) * 100;
  const peakIndex = candles.findIndex((row) => row.high === maxHigh);
  const peakBase = candles[0].close;
  const prePeakGainPct = peakBase > 0 ? (maxHigh / peakBase - 1) * 100 : null;
  const peakToCurrentDrawdownPct = drawdownPct;
  const postPeakCandleCount = peakIndex >= 0 ? candles.length - peakIndex - 1 : 0;
  const pumpThenDump = peakIndex >= 1 && postPeakCandleCount >= 1 &&
    prePeakGainPct >= 35 && peakToCurrentDrawdownPct <= -20;
  const trendCandles = candles.slice(-Math.min(10, candles.length));
  let downMoves = 0;
  for (let index = 1; index < trendCandles.length; index += 1) {
    if (trendCandles[index].close < trendCandles[index - 1].close) downMoves += 1;
  }
  const trendMoveCount = Math.max(0, trendCandles.length - 1);
  const downMoveRatio = trendMoveCount ? downMoves / trendMoveCount : null;
  const trendNetChangePct = trendCandles.length >= 2 && trendCandles[0].close > 0
    ? (trendCandles[trendCandles.length - 1].close / trendCandles[0].close - 1) * 100 : null;
  const gradualDecline = trendCandles.length >= 6 && downMoveRatio >= 0.7 && trendNetChangePct <= -15;
  const changeFromMinutes = (minutes) => {
    const target = latest.timestamp - minutes * 60;
    const reference = candles.reduce((best, row) =>
      !best || Math.abs(row.timestamp - target) < Math.abs(best.timestamp - target) ? row : best
    , null);
    if (!reference) return null;
    const elapsed = latest.timestamp - reference.timestamp;
    const minElapsed = minutes === 5 ? 4 * 60 : minutes === 15 ? 12 * 60 : 45 * 60;
    const maxElapsed = minutes === 5 ? 7 * 60 : minutes === 15 ? 18 * 60 : 70 * 60;
    if (elapsed < minElapsed || elapsed > maxElapsed) return null;
    return (latest.close / reference.close - 1) * 100;
  };
  return {
    status: "checked",
    candleCount: candles.length,
    historyMinutes,
    drawdownFromHighPct: Math.round(drawdownPct * 100) / 100,
    trendSignals: {
      pumpThenDump,
      prePeakGainPct: Math.round(prePeakGainPct * 100) / 100,
      peakToCurrentDrawdownPct: Math.round(peakToCurrentDrawdownPct * 100) / 100,
      postPeakCandleCount,
      gradualDecline,
      trendNetChangePct: trendNetChangePct === null ? null : Math.round(trendNetChangePct * 100) / 100,
      downMoveRatio: downMoveRatio === null ? null : Math.round(downMoveRatio * 100) / 100,
      trendCandleCount: trendCandles.length
    },
    priceChange5m: changeFromMinutes(5),
    priceChange15m: changeFromMinutes(15),
    priceChange1h: changeFromMinutes(60),
    volumeMetrics: (() => {
      const recentCandles = candles.filter(row => latest.timestamp - row.timestamp < 5 * 60);
      const priorCandles = candles.filter(row => {
        const age = latest.timestamp - row.timestamp;
        return age >= 5 * 60 && age < 20 * 60;
      });
      const completeBuckets = recentCandles.length >= 3 && priorCandles.length >= 9;
      const recentVolume = recentCandles.reduce((sum, row) => sum + row.volume, 0);
      const priorVolume = priorCandles.reduce((sum, row) => sum + row.volume, 0);
      const volumeSurge5m = completeBuckets && priorVolume > 0
        ? (recentVolume / (priorVolume / 3)) : null;
      const reference5m = candles.reduce((best, row) =>
        !best || Math.abs(row.timestamp - (latest.timestamp - 5 * 60)) < Math.abs(best.timestamp - (latest.timestamp - 5 * 60)) ? row : best
      , null);
      const reference10m = candles.reduce((best, row) =>
        !best || Math.abs(row.timestamp - (latest.timestamp - 10 * 60)) < Math.abs(best.timestamp - (latest.timestamp - 10 * 60)) ? row : best
      , null);
      const validReference5m = reference5m && latest.timestamp - reference5m.timestamp >= 4 * 60 &&
        latest.timestamp - reference5m.timestamp <= 7 * 60 ? reference5m : null;
      const validReference10m = reference10m && latest.timestamp - reference10m.timestamp >= 9 * 60 &&
        latest.timestamp - reference10m.timestamp <= 12 * 60 ? reference10m : null;
      const previous5mChange = validReference5m && validReference10m && validReference10m.close > 0
        ? (validReference5m.close / validReference10m.close - 1) * 100 : null;
      const current5mChange = changeFromMinutes(5);
      const priceAcceleration5mPct = current5mChange !== null && previous5mChange !== null
        ? current5mChange - previous5mChange : null;
      return {
        volumeSurge5m: volumeSurge5m === null || !Number.isFinite(volumeSurge5m)
          ? null : Math.round(volumeSurge5m * 100) / 100,
        recent5mVolumeUSD: completeBuckets ? Math.round(recentVolume * 100) / 100 : null,
        baselinePrevious15mAvg5mVolumeUSD: completeBuckets
          ? Math.round((priorVolume / 3) * 100) / 100 : null,
        priceAcceleration5mPct: priceAcceleration5mPct === null
          ? null : Math.round(priceAcceleration5mPct * 100) / 100,
        baselineBucketsComplete: completeBuckets
      };
    })(),
    latestCloseUsd: latest.close,
    highestHighUsd: maxHigh,
    latestCandleAt: new Date(latest.timestamp * 1000).toISOString(),
    source: "GeckoTerminal 1m OHLCV"
  };
}


function calculateEarlyTrendScore(history, context, liquiditySnapshot) {
  const volumeSurge = history && history.volumeMetrics ? history.volumeMetrics.volumeSurge5m : null;
  const priceAcceleration = history && history.volumeMetrics ? history.volumeMetrics.priceAcceleration5mPct : null;
  const buys = Number(context && context.buys);
  const sells = Number(context && context.sells);
  const trades = buys + sells;
  const ageRaw = context && context.ageMinutes;
  const age = ageRaw == null || ageRaw === "" ? null : Number(ageRaw);
  const liquidityChange = liquiditySnapshot && liquiditySnapshot.liquidityChange5mPct;
  const components = [];
  const warnings = [];

  if (Number.isFinite(volumeSurge) && volumeSurge >= 0) {
    let score = volumeSurge < 0.5 ? 20
      : volumeSurge < 1 ? 40
      : volumeSurge < 1.5 ? 58
      : volumeSurge < 2.5 ? 76
      : volumeSurge < 5 ? 90
      : volumeSurge <= 8 ? 78 : 52;
    if (volumeSurge > 8) warnings.push("近5分钟成交量相对前15分钟均值异常放大，需排查刷量或短时集中交易");
    components.push({ key: "volumeSurge5m", label: "5分钟成交量突增", score, weight: 25, value: volumeSurge });
  }

  if (Number.isFinite(buys) && Number.isFinite(sells) && trades >= 5) {
    const buyShare = buys / trades;
    let score = buyShare < 0.2 ? 10
      : buyShare < 0.4 ? 30
      : buyShare < 0.5 ? 48
      : buyShare < 0.65 ? 68
      : buyShare < 0.85 ? 86
      : buyShare <= 0.95 ? 72 : 55;
    if (buyShare > 0.95 && sells === 0) warnings.push("观察窗口内几乎只有买入、缺少卖出样本，买盘质量尚未验证");
    components.push({ key: "buyPressure1h", label: "近1小时买卖平衡", score, weight: 20, value: Math.round(buyShare * 10000) / 100 });
  }

  if (Number.isFinite(priceAcceleration)) {
    const score = priceAcceleration <= -10 ? 10
      : priceAcceleration <= -4 ? 25
      : priceAcceleration < 0 ? 42
      : priceAcceleration < 2 ? 58
      : priceAcceleration < 6 ? 74
      : priceAcceleration < 12 ? 86
      : priceAcceleration <= 20 ? 68 : 48;
    if (priceAcceleration > 20) warnings.push("短周期价格加速度过高，存在追高及急速反转风险");
    components.push({ key: "priceAcceleration5m", label: "5分钟价格加速度", score, weight: 15, value: priceAcceleration });
  }

  if (liquidityChange != null && Number.isFinite(Number(liquidityChange))) {
    const change = Number(liquidityChange);
    const score = change <= -30 ? 0
      : change <= -15 ? 15
      : change < 0 ? 35
      : change < 5 ? 58
      : change < 15 ? 76
      : change <= 30 ? 86 : 58;
    if (change > 30) warnings.push("近5分钟流动性增长过快，需确认是否为短时注入而非持续资金流入");
    components.push({ key: "liquidityGrowth5m", label: "5分钟流动性变化", score, weight: 15, value: change });
  }

  if (Number.isFinite(age) && age >= 0) {
    const score = age < 3 ? 35 : age <= 10 ? 82 : age <= 30 ? 95 : age <= 60 ? 78 : 50;
    components.push({ key: "poolAge", label: "池龄阶段", score, weight: 10, value: age });
  }

  const structure = history && history.trendSignals;
  if (structure && Number.isFinite(structure.trendNetChangePct) &&
      Number.isFinite(structure.downMoveRatio) && Number(structure.trendCandleCount) >= 6) {
    const net = Number(structure.trendNetChangePct);
    const downRatio = Number(structure.downMoveRatio);
    let score = net <= -10 ? 10 : net < -3 ? 25 : net < 0 ? 40
      : net < 3 ? 58 : net < 8 ? 76 : net < 20 ? 88 : 68;
    if (downRatio >= 0.7) score = Math.min(score, 35);
    if (net < -5 && downRatio >= 0.7) warnings.push("短线连续收跌，走势结构转弱，即使成交量放大也不视为健康启动");
    components.push({ key: "trendStructure10m", label: "近10根K线结构", score, weight: 15,
      value: net, downMoveRatio: Math.round(downRatio * 100) / 100 });
  }

  const availableWeight = components.reduce((sum, item) => sum + item.weight, 0);
  const confidence = availableWeight;
  if (availableWeight < 60) {
    return {
      status: "insufficient", score: null, confidence,
      label: "数据不足，暂不评分", components, warnings,
      reason: "有效走势指标权重不足60%，不以缺失数据填充分数"
    };
  }
  const rawScore = components.reduce((sum, item) => sum + item.score * item.weight, 0) / availableWeight;
  const drawdown = Number(history && history.drawdownFromHighPct);
  const drawdownPenalty = Number.isFinite(drawdown)
    ? drawdown <= -25 ? 25 : drawdown <= -15 ? 15 : drawdown <= -8 ? 8 : 0 : 0;
  const score = Math.max(0, Math.min(100, Math.round(rawScore - drawdownPenalty)));
  return {
    status: "checked", score, confidence,
    label: score >= 80 ? "走势较强" : score >= 65 ? "走势观察" : "走势偏弱",
    rawScore: Math.round(rawScore),
    drawdownPenalty,
    components, warnings,
    note: "仅为早期走势质量排序，不是安全评分或买入信号；买卖笔数为索引源近1小时统计，数据缺失不按零分处理。结构信号用于识别持续推进，不奖励单根暴涨"
  };
}

async function recordLiquiditySnapshot(env, network, poolAddress, liquidityUSD) {
  const kv = env && env.RADAR_KV;
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") {
    return {
      status: "not_configured",
      error: "Cloudflare KV 尚未绑定（RADAR_KV），流动性历史快照暂不可用"
    };
  }
  const currentLiquidity = Number(liquidityUSD);
  if (!Number.isFinite(currentLiquidity) || currentLiquidity <= 0) {
    return { status: "insufficient", error: "缺少有效的当前流动性数值，无法记录快照" };
  }
  const key = "liquidity:v1:" + network + ":" + poolAddress;
  const now = Math.floor(Date.now() / 1000);
  try {
    const stored = await kv.get(key, "json");
    const history = Array.isArray(stored && stored.snapshots) ? stored.snapshots : [];
    const latest = history[history.length - 1];
    if (!latest || now - Number(latest.timestamp) >= 55) {
      history.push({ timestamp: now, liquidityUSD: currentLiquidity });
    }
    const recent = history.filter((item) =>
      Number.isFinite(Number(item.timestamp)) &&
      Number.isFinite(Number(item.liquidityUSD)) &&
      Number(item.liquidityUSD) > 0 &&
      Number(item.timestamp) >= now - 2 * 60 * 60
    ).slice(-120);
    await kv.put(key, JSON.stringify({ snapshots: recent }), { expirationTtl: 86400 });
    const newest = recent[recent.length - 1];
    const changeSince = (minutes) => {
      const target = Number(newest.timestamp) - minutes * 60;
      const reference = recent.reduce((best, item) =>
        !best || Math.abs(Number(item.timestamp) - target) < Math.abs(Number(best.timestamp) - target) ? item : best
      , null);
      if (!reference || reference === newest) return null;
      const elapsed = Number(newest.timestamp) - Number(reference.timestamp);
      const minElapsed = minutes === 5 ? 240 : 720;
      const maxElapsed = minutes === 5 ? 480 : 1080;
      if (elapsed < minElapsed || elapsed > maxElapsed) return null;
      return Math.round((Number(newest.liquidityUSD) / Number(reference.liquidityUSD) - 1) * 10000) / 100;
    };
    const change5m = changeSince(5);
    const change15m = changeSince(15);
    const checked = change5m !== null || change15m !== null;
    return {
      status: checked ? "checked" : "collecting",
      snapshotCount: recent.length,
      liquidityUSD: currentLiquidity,
      liquidityChange5mPct: change5m,
      liquidityChange15mPct: change15m,
      latestSnapshotAt: new Date(Number(newest.timestamp) * 1000).toISOString(),
      source: "Cloudflare KV liquidity snapshots"
    };
  } catch (error) {
    return { status: "unavailable", error: "KV 快照读写失败：" + String(error) };
  }
}



const SOLANA_DISCOVERY_PROGRAMS = [
  { name: "Pump.fun", address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
  { name: "PumpSwap", address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" },
  { name: "Raydium AMM v4", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" },
  { name: "Raydium CPMM", address: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" },
  { name: "Meteora DLMM", address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo" },
  { name: "Orca Whirlpool", address: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" }
];

// Read-only RPC cross-check. This samples recent transactions touching known
// launch/DEX programs and extracts explicit SPL mint-initialization evidence.
// It deliberately does NOT manufacture pool candidates: pool address, token
// side, liquidity and tradeability require a protocol-specific decoder.
async function solanaRpcCall(rpcUrl, method, params) {
  const cooldown = await readProviderCooldown("solana-rpc");
  if (cooldown) throw new Error("Solana RPC shared cooldown HTTP " + cooldown.status);
  const requestBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: requestBody
  });
  if (response.status === 429 || response.status === 402) {
    await writeProviderCooldown("solana-rpc", response);
    throw new Error("Solana RPC HTTP " + response.status + " (provider cooldown)");
  }
  if (response.status >= 500) {
    await new Promise(resolve => setTimeout(resolve, 500));
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: requestBody
    });
    if (response.status >= 500) await writeProviderCooldown("solana-rpc", response);
  }
  if (response.status === 429 || response.status === 402) {
    await writeProviderCooldown("solana-rpc", response);
    throw new Error("Solana RPC HTTP " + response.status + " (provider cooldown)");
  }
  if (!response.ok) throw new Error("Solana RPC HTTP " + response.status);
  let body;
  try { body = await response.json(); }
  catch (_) { throw new Error("Solana RPC returned invalid JSON"); }
  if (body && body.error) {
    const code = body.error.code == null ? "" : " (" + String(body.error.code).slice(0, 24) + ")";
    throw new Error("Solana RPC JSON-RPC error" + code);
  }
  return body && body.result;
}


const SOLANA_PUMPSWAP_CREATE_POOL_DISCRIMINATOR = [233, 146, 209, 142, 207, 104, 64, 188];
const SOLANA_PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SOLANA_RAYDIUM_CPMM_INITIALIZE_DISCRIMINATOR = [175, 175, 109, 31, 13, 152, 155, 237];
const SOLANA_RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const SOLANA_STABLE_QUOTES = [
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
  { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT" }
];
const SOLANA_TOKEN_PROGRAMS = new Set([
  SOLANA_LEGACY_TOKEN_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM
]);

function decodeSolanaBase58(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const input = String(value || "");
  let number = 0n;
  for (const char of input) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < input.length && input[leadingZeroes] === "1") leadingZeroes++;
  return [...Array(leadingZeroes).fill(0), ...bytes];
}

function solanaTransactionAccountKeys(transaction) {
  const message = transaction && transaction.transaction && transaction.transaction.message;
  const meta = transaction && transaction.meta;
  const raw = Array.isArray(message && message.accountKeys) ? message.accountKeys
    : Array.isArray(message && message.staticAccountKeys) ? message.staticAccountKeys : [];
  const keys = raw.map(row => typeof row === "string" ? row : row && (row.pubkey || row.key) || "");
  const loaded = meta && meta.loadedAddresses;
  if (loaded) {
    for (const key of Array.isArray(loaded.writable) ? loaded.writable : []) keys.push(key);
    for (const key of Array.isArray(loaded.readonly) ? loaded.readonly : []) keys.push(key);
  }
  return keys;
}

function solanaInstructionProgramId(instruction, keys) {
  if (instruction && typeof instruction.programId === "string") return instruction.programId;
  const index = Number(instruction && instruction.programIdIndex);
  return Number.isInteger(index) && index >= 0 ? keys[index] || "" : "";
}

function solanaInstructionAccountKeys(instruction, keys) {
  if (!instruction || !Array.isArray(instruction.accounts)) return [];
  return instruction.accounts.map(value => {
    if (typeof value === "string") return value;
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 ? keys[index] || "" : "";
  });
}

function findRaydiumCpmmInitializeInstructions(transaction) {
  if (!transaction || !transaction.meta || transaction.meta.err) return [];
  const message = transaction.transaction && transaction.transaction.message;
  const keys = solanaTransactionAccountKeys(transaction);
  const instructions = [
    ...(Array.isArray(message && message.instructions) ? message.instructions : []),
    ...(Array.isArray(transaction.meta.innerInstructions)
      ? transaction.meta.innerInstructions.flatMap(row => row.instructions || []) : [])
  ];
  return instructions.filter(instruction => {
    if (solanaInstructionProgramId(instruction, keys) !== SOLANA_RAYDIUM_CPMM_PROGRAM) return false;
    const data = decodeSolanaBase58(instruction && instruction.data);
    return Array.isArray(data) && data.length >= 32 &&
      SOLANA_RAYDIUM_CPMM_INITIALIZE_DISCRIMINATOR.every((byte, index) => data[index] === byte);
  }).map(instruction => ({
    programId: SOLANA_RAYDIUM_CPMM_PROGRAM,
    accounts: solanaInstructionAccountKeys(instruction, keys)
  }));
}


function findPumpSwapCreatePoolInstructions(transaction) {
  if (!transaction || !transaction.meta || transaction.meta.err) return [];
  const message = transaction.transaction && transaction.transaction.message;
  const keys = solanaTransactionAccountKeys(transaction);
  const instructions = [
    ...(Array.isArray(message && message.instructions) ? message.instructions : []),
    ...(Array.isArray(transaction.meta.innerInstructions)
      ? transaction.meta.innerInstructions.flatMap(row => row.instructions || []) : [])
  ];
  return instructions.filter(instruction => {
    if (solanaInstructionProgramId(instruction, keys) !== SOLANA_PUMPSWAP_PROGRAM) return false;
    const data = decodeSolanaBase58(instruction && instruction.data);
    return Array.isArray(data) && data.length >= 8 &&
      SOLANA_PUMPSWAP_CREATE_POOL_DISCRIMINATOR.every((byte, index) => data[index] === byte);
  }).map(instruction => ({
    programId: SOLANA_PUMPSWAP_PROGRAM,
    accounts: solanaInstructionAccountKeys(instruction, keys)
  }));
}

async function decodePumpSwapPool(rpcUrl, instruction, blockTime, nowSeconds, minutes, minLiquidity) {
  // Official PumpSwap create_pool account order: pool=0, base_mint=3,
  // quote_mint=4, pool_base_token_account=9, pool_quote_token_account=10.
  const accounts = instruction && instruction.accounts;
  if (!Array.isArray(accounts) || accounts.length < 18) return { status: "skipped", reason: "create_pool account list is incomplete" };
  const [poolAddress, baseMint, quoteMint, baseVaultAddress, quoteVaultAddress] =
    [accounts[0], accounts[3], accounts[4], accounts[9], accounts[10]];
  if (![poolAddress, baseMint, quoteMint, baseVaultAddress, quoteVaultAddress].every(value =>
    typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))) {
    return { status: "skipped", reason: "create_pool account keys are invalid" };
  }
  const ageMinutes = (nowSeconds - Number(blockTime)) / 60;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0 || ageMinutes > minutes) {
    return { status: "skipped", reason: "pool creation timestamp is outside the requested window" };
  }
  const rows = await solanaRpcCall(rpcUrl, "getMultipleAccounts", [
    [poolAddress, baseVaultAddress, quoteVaultAddress],
    { encoding: "jsonParsed", commitment: "confirmed" }
  ]);
  const values = rows && rows.value;
  if (!Array.isArray(values) || values.length !== 3 || values.some(value => !value)) {
    return { status: "skipped", reason: "pool or vault account data is unavailable" };
  }
  const [poolAccount, baseVaultAccount, quoteVaultAccount] = values;
  if (poolAccount.owner !== SOLANA_PUMPSWAP_PROGRAM) {
    return { status: "skipped", reason: "pool account owner does not match PumpSwap" };
  }
  const baseVault = parseSolanaTokenVault(baseVaultAccount, baseMint);
  const quoteVault = parseSolanaTokenVault(quoteVaultAccount, quoteMint);
  if (!baseVault || !quoteVault) {
    return { status: "skipped", reason: "vault owner, parsed token data, or mint association could not be verified" };
  }
  const baseQuote = SOLANA_STABLE_QUOTES.find(asset => asset.address === baseMint);
  const quoteQuote = SOLANA_STABLE_QUOTES.find(asset => asset.address === quoteMint);
  if (Boolean(baseQuote) === Boolean(quoteQuote)) {
    return { status: "skipped", reason: "pool does not contain exactly one supported stablecoin quote mint" };
  }
  const quote = baseQuote || quoteQuote;
  const quoteReserve = baseQuote ? baseVault.amount : quoteVault.amount;
  const liquidityUSDApprox = quoteReserve * 2;
  if (!Number.isFinite(liquidityUSDApprox) || liquidityUSDApprox < minLiquidity) {
    return { status: "skipped", reason: "verified stablecoin-side reserve is below the liquidity threshold" };
  }
  const tokenAddress = baseQuote ? quoteMint : baseMint;
  return {
    status: "candidate",
    pool: {
      chain: "Solana", chainId: "solana", dex: "PumpSwap",
      symbol: tokenAddress.slice(0, 5) + "…" + tokenAddress.slice(-4),
      name: "Unknown token", tokenAddress, tokenSelectionVerified: true, tokenSelectionNote: "",
      quoteSymbol: quote.symbol, quoteAddress: quote.address,
      pairAddress: poolAddress,
      poolUrl: "https://dexscreener.com/solana/" + poolAddress,
      dexScreenerUrl: "https://dexscreener.com/solana/" + poolAddress,
      createdAt: new Date(Number(blockTime) * 1000).toISOString(),
      ageMinutes: Math.round(ageMinutes * 10) / 10,
      liquidityUSDApprox, volume1hUSD: null, buys1h: null, sells1h: null,
      priceChange1h: null, priceChange5m: null, priceChange15m: null,
      usdtRouteStatus: quote.symbol === "USDT" ? "direct_pool_only" : "not_verified",
      source: "Solana RPC · PumpSwap create_pool + pool/vault account verification",
      marketHistoryStatus: "unavailable",
      riskNote: "已核对 PumpSwap create_pool 指令、池账户程序归属、双侧 Vault Token 程序及 Mint 关联；流动性按稳定币侧储备×2估算，成交/K线/钱包路由/卖出能力尚未验证，必须待复核。"
    }
  };
}

function extractSolanaTransactionHints(transaction, programName, signature, blockTime) {
  const message = transaction && transaction.transaction && transaction.transaction.message;
  const meta = transaction && transaction.meta;
  const instructions = [
    ...(Array.isArray(message && message.instructions) ? message.instructions : []),
    ...(Array.isArray(meta && meta.innerInstructions) ? meta.innerInstructions.flatMap(row => row.instructions || []) : [])
  ];
  const mintHints = new Set();
  for (const instruction of instructions) {
    const program = String(instruction && (instruction.program || instruction.programId) || "").toLowerCase();
    const parsed = instruction && instruction.parsed;
    const type = String(parsed && parsed.type || "").toLowerCase();
    const info = parsed && parsed.info || {};
    if ((program === "spl-token" || program === "spl-token-2022" ||
      program === SOLANA_LEGACY_TOKEN_PROGRAM.toLowerCase() ||
      program === SOLANA_TOKEN_2022_PROGRAM.toLowerCase()) &&
      (type === "initializemint" || type === "initializemint2") &&
      typeof info.mint === "string") mintHints.add(info.mint);
  }
  const logs = Array.isArray(meta && meta.logMessages) ? meta.logMessages : [];
  const poolInitLogHints = [...new Set(logs
    .filter(line => /Program log: Instruction: (initialize|initialize2|initialize_pool|initialize_lb_pair|create_pool|migrate)/i.test(line))
    .map(line => String(line).slice(0, 160)))].slice(0, 4);
  return {
    signature,
    program: programName,
    blockTime: Number.isFinite(Number(blockTime)) ? Number(blockTime) : null,
    mintHints: [...mintHints].slice(0, 4),
    poolInitLogHints
  };
}

function parseSolanaTokenVault(account, expectedMint) {
  if (!account || !SOLANA_TOKEN_PROGRAMS.has(account.owner)) return null;
  const parsed = account.data && account.data.parsed;
  const info = parsed && parsed.info;
  const tokenAmount = info && info.tokenAmount;
  if (!info || parsed.type !== "account" || info.mint !== expectedMint || !tokenAmount) return null;
  const amount = Number(tokenAmount.uiAmountString != null ? tokenAmount.uiAmountString : tokenAmount.uiAmount);
  const decimals = Number(tokenAmount.decimals);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  return { mint: info.mint, amount, decimals };
}

async function decodeRaydiumCpmmPool(rpcUrl, instruction, blockTime, nowSeconds, minutes, minLiquidity) {
  // Raydium CPMM initialize account order is pinned to the official IDL:
  // creator, amm_config, authority, pool_state, token_0_mint, token_1_mint,
  // lp_mint, creator_token_0, creator_token_1, creator_lp_token,
  // token_0_vault, token_1_vault, ...
  const accounts = instruction && instruction.accounts;
  if (!Array.isArray(accounts) || accounts.length < 19) return { status: "skipped", reason: "initialize account list is incomplete" };
  const [poolAddress, token0Mint, token1Mint, vault0Address, vault1Address] =
    [accounts[3], accounts[4], accounts[5], accounts[10], accounts[11]];
  if (![poolAddress, token0Mint, token1Mint, vault0Address, vault1Address].every(value =>
    typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))) {
    return { status: "skipped", reason: "initialize account keys are invalid" };
  }
  const ageMinutes = (nowSeconds - Number(blockTime)) / 60;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0 || ageMinutes > minutes) {
    return { status: "skipped", reason: "pool creation timestamp is outside the requested window" };
  }
  const rows = await solanaRpcCall(rpcUrl, "getMultipleAccounts", [
    [poolAddress, vault0Address, vault1Address],
    { encoding: "jsonParsed", commitment: "confirmed" }
  ]);
  const values = rows && rows.value;
  if (!Array.isArray(values) || values.length !== 3 || values.some(value => !value)) {
    return { status: "skipped", reason: "pool or vault account data is unavailable" };
  }
  const [poolAccount, vault0Account, vault1Account] = values;
  if (poolAccount.owner !== SOLANA_RAYDIUM_CPMM_PROGRAM) {
    return { status: "skipped", reason: "pool account owner does not match Raydium CPMM" };
  }
  const vault0 = parseSolanaTokenVault(vault0Account, token0Mint);
  const vault1 = parseSolanaTokenVault(vault1Account, token1Mint);
  if (!vault0 || !vault1) return { status: "skipped", reason: "vault owner, parsed token data, or mint association could not be verified" };
  const quote0 = SOLANA_STABLE_QUOTES.find(asset => asset.address === token0Mint);
  const quote1 = SOLANA_STABLE_QUOTES.find(asset => asset.address === token1Mint);
  if (Boolean(quote0) === Boolean(quote1)) {
    return { status: "skipped", reason: "pool does not contain exactly one supported stablecoin quote mint" };
  }
  const quote = quote0 || quote1;
  const quoteReserve = quote0 ? vault0.amount : vault1.amount;
  const liquidityUSDApprox = quoteReserve * 2;
  if (!Number.isFinite(liquidityUSDApprox) || liquidityUSDApprox < minLiquidity) {
    return { status: "skipped", reason: "verified stablecoin-side reserve is below the liquidity threshold" };
  }
  const tokenAddress = quote0 ? token1Mint : token0Mint;
  return {
    status: "candidate",
    pool: {
      chain: "Solana",
      chainId: "solana",
      dex: "Raydium CPMM",
      symbol: tokenAddress.slice(0, 5) + "…" + tokenAddress.slice(-4),
      name: "Unknown token",
      tokenAddress,
      tokenSelectionVerified: true,
      tokenSelectionNote: "",
      quoteSymbol: quote.symbol,
      quoteAddress: quote.address,
      pairAddress: poolAddress,
      poolUrl: "https://dexscreener.com/solana/" + poolAddress,
      dexScreenerUrl: "https://dexscreener.com/solana/" + poolAddress,
      createdAt: new Date(Number(blockTime) * 1000).toISOString(),
      ageMinutes: Math.round(ageMinutes * 10) / 10,
      liquidityUSDApprox,
      volume1hUSD: null,
      buys1h: null,
      sells1h: null,
      priceChange1h: null,
      priceChange5m: null,
      priceChange15m: null,
      usdtRouteStatus: quote.symbol === "USDT" ? "direct_pool_only" : "not_verified",
      source: "Solana RPC · Raydium CPMM initialize + pool/vault account verification",
      marketHistoryStatus: "unavailable",
      riskNote: "已核对 Raydium CPMM 初始化指令、池账户归属、Vault 所属 Token 程序及 Mint 对应关系；流动性按稳定币侧储备×2估算，成交/K线/钱包路由/卖出能力尚未验证，必须待复核。"
    }
  };
}

async function scanSolanaRpcActivity(rpcUrl, minutes, minLiquidity) {
  const diagnostics = {
    chain: "Solana",
    provider: "Solana JSON-RPC · Pump.fun / PumpSwap / Raydium / Meteora / Orca",
    status: "partial",
    coverage: "pumpswap-create-pool-and-raydium-cpmm-initialize",
    programsChecked: 0,
    recentTransactions: 0,
    sampledTransactions: 0,
    mintHints: [],
    poolInitLogHints: [],
    samples: [],
    candidatePoolsAdded: 0,
    protocolDecoders: {
      pumpSwap: {
        status: "limited",
        createPoolInstructions: 0,
        accountChecks: 0,
        candidatesAdded: 0,
        skipped: 0
      },
      raydiumCpmm: {
        status: "limited",
        initializeInstructions: 0,
        accountChecks: 0,
        candidatesAdded: 0,
        skipped: 0
      }
    },
    note: "仅将通过 PumpSwap create_pool 或 Raydium CPMM initialize 指令、池账户归属和双侧 Vault/Mint 关联核验的新池加入待复核候选；其他协议目前仍只做活动线索诊断。"
  };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - minutes * 60;
  const mintHints = new Set();
  const poolInitLogHints = new Set();
  const candidates = [];
  const seenPools = new Set();
  try {
    for (const program of SOLANA_DISCOVERY_PROGRAMS) {
      const signatures = await solanaRpcCall(rpcUrl, "getSignaturesForAddress", [
        program.address, { limit: 20, commitment: "confirmed" }
      ]);
      if (!Array.isArray(signatures)) throw new Error("getSignaturesForAddress returned an unexpected response");
      diagnostics.programsChecked++;
      const recent = signatures.filter(row => Number(row && row.blockTime) >= cutoff &&
        Number(row && row.blockTime) <= nowSeconds);
      diagnostics.recentTransactions += recent.length;
      // PumpSwap is sampled up to three transactions and Raydium CPMM up to
      // four; other programs remain one sample each. Pool/vault checks stay
      // globally capped at three to protect Worker subrequest budgets.
      const sampleRows = program.address === SOLANA_RAYDIUM_CPMM_PROGRAM ? recent.slice(0, 4)
        : program.address === SOLANA_PUMPSWAP_PROGRAM ? recent.slice(0, 3) : recent.slice(0, 1);
      for (const row of sampleRows) {
        if (diagnostics.sampledTransactions >= 12) break;
        const transaction = await solanaRpcCall(rpcUrl, "getTransaction", [
          row.signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
        ]);
        if (!transaction) continue;
        diagnostics.sampledTransactions++;
        const hints = extractSolanaTransactionHints(transaction, program.name, row.signature, row.blockTime);
        hints.mintHints.forEach(value => mintHints.add(value));
        hints.poolInitLogHints.forEach(value => poolInitLogHints.add(program.name + ": " + value));
        if (diagnostics.samples.length < 8) diagnostics.samples.push(hints);
        if (program.address === SOLANA_PUMPSWAP_PROGRAM) {
          const createPoolInstructions = findPumpSwapCreatePoolInstructions(transaction);
          for (const instruction of createPoolInstructions) {
            diagnostics.protocolDecoders.pumpSwap.createPoolInstructions++;
            const poolAddress = instruction.accounts[0];
            if (poolAddress && seenPools.has(poolAddress)) continue;
            if (poolAddress) seenPools.add(poolAddress);
            if (diagnostics.protocolDecoders.pumpSwap.accountChecks +
              diagnostics.protocolDecoders.raydiumCpmm.accountChecks >= 3) {
              diagnostics.protocolDecoders.pumpSwap.skipped++;
              continue;
            }
            diagnostics.protocolDecoders.pumpSwap.accountChecks++;
            const decoded = await decodePumpSwapPool(
              rpcUrl, instruction, row.blockTime, nowSeconds, minutes, minLiquidity
            );
            if (decoded.status === "candidate") {
              candidates.push(decoded.pool);
              diagnostics.protocolDecoders.pumpSwap.candidatesAdded++;
            } else {
              diagnostics.protocolDecoders.pumpSwap.skipped++;
            }
          }
        }
        if (program.address === SOLANA_RAYDIUM_CPMM_PROGRAM) {
          const initializeInstructions = findRaydiumCpmmInitializeInstructions(transaction);
          for (const instruction of initializeInstructions) {
            diagnostics.protocolDecoders.raydiumCpmm.initializeInstructions++;
            const poolAddress = instruction.accounts[3];
            if (poolAddress && seenPools.has(poolAddress)) continue;
            if (poolAddress) seenPools.add(poolAddress);
            if (diagnostics.protocolDecoders.raydiumCpmm.accountChecks >= 3) {
              diagnostics.protocolDecoders.raydiumCpmm.skipped++;
              continue;
            }
            diagnostics.protocolDecoders.raydiumCpmm.accountChecks++;
            const decoded = await decodeRaydiumCpmmPool(
              rpcUrl, instruction, row.blockTime, nowSeconds, minutes, minLiquidity
            );
            if (decoded.status === "candidate") {
              candidates.push(decoded.pool);
              diagnostics.protocolDecoders.raydiumCpmm.candidatesAdded++;
            } else {
              diagnostics.protocolDecoders.raydiumCpmm.skipped++;
            }
          }
        }
      }
    }
    diagnostics.mintHints = [...mintHints].slice(0, 20);
    diagnostics.poolInitLogHints = [...poolInitLogHints].slice(0, 20);
    diagnostics.status = "ok";
    diagnostics.candidatePoolsAdded = candidates.length;
    diagnostics.note = "PumpSwap 候选仅在 create_pool 指令、池账户程序归属、双侧 Vault Token 程序及 Mint 关联均通过链上核验后生成；Raydium CPMM 使用对应 initialize 指令核验；其他协议线索不会进入候选。成交量、价格历史和钱包可交易路径仍未验证，候选继续进入待复核。";
  } catch (error) {
    diagnostics.status = diagnostics.programsChecked > 0 ? "partial" : "error";
    diagnostics.error = String(error);
    diagnostics.mintHints = [...mintHints].slice(0, 20);
    diagnostics.poolInitLogHints = [...poolInitLogHints].slice(0, 20);
    diagnostics.candidatePoolsAdded = candidates.length;
  }
  return { ...diagnostics, pools: candidates };
}

const EVM_RPC_SCAN_CONFIG = {
  eth: {
    chain: "Ethereum",
    envKey: "ETH_RPC_URL",
    networkLabel: "Ethereum",
    factory: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
    dex: "Uniswap V2",
    dexId: "uniswap",
    quoteAssets: [
      { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
      { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
      { address: "0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", decimals: 18 }
    ]
  },
  base: {
    chain: "Base",
    envKey: "BASE_RPC_URL",
    networkLabel: "Base",
    factory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
    dex: "Uniswap V2",
    dexId: "uniswap",
    quoteAssets: [
      { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 },
      { address: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", symbol: "USDbC", decimals: 6 },
      { address: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", symbol: "USDT", decimals: 6 }
    ]
  }
};

async function scanEvmRpcRecentPools(config, rpcUrl, minutes, minLiquidity) {
  const label = config.networkLabel;
  const latestHex = await rpc("eth_blockNumber", [], rpcUrl, label);
  const latest = asNumber(latestHex);
  const latestBlock = await rpc("eth_getBlockByNumber", [latestHex, false], rpcUrl, label);
  if (!latestBlock || !latestBlock.timestamp) throw new Error(label + " RPC latest block timestamp unavailable");
  const latestTime = asNumber(latestBlock.timestamp) * 1000;
  let secondsPerBlock = 12;
  try {
    const sampleNumber = Math.max(0, latest - 1000);
    const sample = await rpc("eth_getBlockByNumber", [hexNum(sampleNumber), false], rpcUrl, label);
    const elapsed = latestTime - asNumber(sample && sample.timestamp || "0x0") * 1000;
    if (elapsed > 0) secondsPerBlock = elapsed / 1000;
  } catch (_) {}
  const requestedBlockWindow = Math.min(10000, Math.max(20, Math.ceil(minutes * 60 / secondsPerBlock * 1.2) + 10));
  const requestedFromBlock = Math.max(0, latest - requestedBlockWindow);
  // Alchemy Free allows at most 10 blocks per eth_getLogs request.
  // Bound the number of chunks to protect Cloudflare Worker subrequest limits;
  // when the requested lookback is larger, scan the newest blocks and report partial coverage.
  const chunkSize = 10;
  const maxChunks = 28;
  const chunks = [];
  for (let end = latest; end >= requestedFromBlock && chunks.length < maxChunks; end -= chunkSize) {
    chunks.push({ fromBlock: Math.max(requestedFromBlock, end - chunkSize + 1), toBlock: end });
  }
  chunks.reverse();
  const scannedFromBlock = chunks.length ? chunks[0].fromBlock : latest;
  const truncated = scannedFromBlock > requestedFromBlock;
  const quoteMap = new Map(config.quoteAssets.map((asset) => [asset.address.toLowerCase(), asset]));
  const logBatches = await mapLimit(chunks, 3, async (chunk) => rpc("eth_getLogs", [{
    fromBlock: hexNum(chunk.fromBlock),
    toBlock: hexNum(chunk.toBlock),
    address: config.factory,
    topics: [PAIR_CREATED]
  }], rpcUrl, label));
  const logs = logBatches.flat();
  const candidates = [];
  const seen = new Set();
  const relevant = logs.filter((log) => {
    const token0 = fromTopic(log.topics && log.topics[1] || "");
    const token1 = fromTopic(log.topics && log.topics[2] || "");
    return quoteMap.has(token0) !== quoteMap.has(token1);
  }).sort((a, b) => asNumber(b.blockNumber) - asNumber(a.blockNumber)).slice(0, 3);
  const timeCache = new Map();
  const enriched = await mapLimit(relevant, 4, async (log) => {
    const pair = "0x" + word(log.data, 0).slice(-40).toLowerCase();
    if (seen.has(pair)) return null;
    seen.add(pair);
    const token0 = fromTopic(log.topics[1]);
    const token1 = fromTopic(log.topics[2]);
    const quoteIs0 = quoteMap.has(token0);
    const quoteAddress = quoteIs0 ? token0 : token1;
    const tokenAddress = quoteIs0 ? token1 : token0;
    const quote = quoteMap.get(quoteAddress);
    const createdBlock = asNumber(log.blockNumber);
    const createdAt = await blockTime(createdBlock, timeCache, rpcUrl, label);
    const ageMinutes = (latestTime - createdAt) / 60000;
    if (!createdAt || ageMinutes < 0 || ageMinutes > minutes) return null;
    const [reserveData, symbolHex, nameHex, decimalsHex] = await Promise.all([
      rpc("eth_call", [{ to: pair, data: "0x0902f1ac" }, "latest"], rpcUrl, label),
      rpc("eth_call", [{ to: tokenAddress, data: "0x95d89b41" }, "latest"], rpcUrl, label).catch(() => "0x"),
      rpc("eth_call", [{ to: tokenAddress, data: "0x06fdde03" }, "latest"], rpcUrl, label).catch(() => "0x"),
      rpc("eth_call", [{ to: tokenAddress, data: "0x313ce567" }, "latest"], rpcUrl, label).catch(() => "0x")
    ]);
    const reserve0 = BigInt("0x" + word(reserveData, 0));
    const reserve1 = BigInt("0x" + word(reserveData, 1));
    const quoteReserve = toFloat(quoteIs0 ? reserve0 : reserve1, quote.decimals);
    const liquidityUSD = quoteReserve * 2;
    if (!Number.isFinite(liquidityUSD) || liquidityUSD < minLiquidity) return null;
    const tokenDecimals = decimalsHex && decimalsHex !== "0x"
      ? Math.min(36, Math.max(0, asNumber(decimalsHex))) : 18;
    return {
      chain: config.chain,
      chainId: config.dexId === "uniswap" && label === "Ethereum" ? "ethereum" : "base",
      dex: config.dex,
      symbol: decodeAbiString(symbolHex) || tokenAddress.slice(0, 6) + "…" + tokenAddress.slice(-4),
      name: decodeAbiString(nameHex) || "Unknown token",
      tokenAddress,
      tokenSelectionVerified: true,
      tokenSelectionNote: "",
      quoteSymbol: quote.symbol,
      quoteAddress,
      pairAddress: pair,
      poolUrl: "https://dexscreener.com/" + (label === "Ethereum" ? "ethereum" : "base") + "/" + pair,
      dexScreenerUrl: "https://dexscreener.com/" + (label === "Ethereum" ? "ethereum" : "base") + "/" + pair,
      createdAt: new Date(createdAt).toISOString(),
      ageMinutes: Math.round(ageMinutes * 10) / 10,
      liquidityUSDApprox: liquidityUSD,
      volume1hUSD: null,
      buys1h: null,
      sells1h: null,
      priceChange1h: null,
      priceChange5m: null,
      priceChange15m: null,
      usdtRouteStatus: quote.symbol === "USDT" ? "direct_pool_only" : "not_verified",
      source: label + " RPC · " + config.dex + " PairCreated",
      marketHistoryStatus: "unavailable",
      riskNote: "RPC 链上发现的新池；当前只覆盖配置的 V2 工厂和稳定币直连池。成交、价格历史及钱包路由未验证，必须待复核。"
    };
  });
  for (const item of enriched) if (item && !item._error) candidates.push(item);
  return {
    pools: candidates,
    diagnostics: {
      chain: config.chain,
      provider: label + " RPC",
      status: "ok",
      coverage: truncated ? "partial" : "full",
      requestedFromBlock,
      scannedFromBlock,
      toBlock: latest,
      requestedBlockWindow,
      chunkSize,
      chunksScanned: chunks.length,
      chunksTotal: Math.ceil((latest - requestedFromBlock + 1) / chunkSize),
      truncated,
      factory: config.factory,
      factoryEvents: logs.length,
      quotePoolEvents: relevant.length,
      qualifyingPools: candidates.length,
      fromBlock: scannedFromBlock,
      blockWindow: latest - scannedFromBlock,
      dex: config.dex
    }
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
    if (url.pathname === "/wallet-flow") {
      const network=url.searchParams.get("chain")||"";
      const poolAddress=url.searchParams.get("pool")||"";
      const tokenAddress=url.searchParams.get("token")||"";
      if(!["bsc","solana","eth","base"].includes(network))
        return json({ok:false,status:"unavailable",error:"Unsupported GeckoTerminal network"},400);
      if(!poolAddress||!tokenAddress||poolAddress.length>160||tokenAddress.length>160)
        return json({ok:false,status:"unavailable",error:"pool and token are required"},400);
      const walletFlow=await getPoolWalletFlow(network,poolAddress,tokenAddress);
      return json({ok:true,chain:network,poolAddress,tokenAddress,walletFlow});
    }
    if (url.pathname === "/pool-risk") {
      const network = url.searchParams.get("chain") || "";
      const poolAddress = url.searchParams.get("pool") || "";
      const tokenAddress = url.searchParams.get("token") || "";
      const liquidityUSD = url.searchParams.get("liquidity");
      if (!["bsc", "solana", "eth", "base"].includes(network)) {
        return json({ ok: false, status: "unavailable", error: "Unsupported GeckoTerminal network" }, 400);
      }
      if (!poolAddress || !tokenAddress || poolAddress.length > 160 || tokenAddress.length > 160) {
        return json({ ok: false, status: "unavailable", error: "pool and token are required" }, 400);
      }
      const liquiditySnapshot = await recordLiquiditySnapshot(env, network, poolAddress, liquidityUSD);
      try {
        const history = await getPoolMarketHistory(network, poolAddress, tokenAddress);
        const parseMetric = (key) => {
          const raw = url.searchParams.get(key);
          if (raw == null || raw.trim() === "") return null;
          const value = Number(raw);
          return Number.isFinite(value) && value >= 0 ? value : null;
        };
        const trendScore = history.status === "checked" ? calculateEarlyTrendScore(history, {
          buys: parseMetric("buys"), sells: parseMetric("sells"),
          ageMinutes: parseMetric("age")
        }, liquiditySnapshot) : {
          status: "insufficient", score: null, confidence: 0,
          label: "行情数据不足，暂不评分", components: [], warnings: [],
          reason: history.error || "未取得足够的1分钟K线"
        };
        return json({ ok: true, chain: network, poolAddress, tokenAddress, ...history, liquiditySnapshot, trendScore });
      } catch (error) {
        return json({ ok: true, chain: network, poolAddress, tokenAddress,
          status: "unavailable", error: String(error), liquiditySnapshot });
      }
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
          const [rugCheckResult, mintEvidence] = await Promise.all([
            (async () => {
              try {
                const response = await fetch("https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(address) + "/report", { headers: { "accept": "application/json" } });
                if (!response.ok) return { report: {}, httpStatus: response.status, error: "RugCheck HTTP " + response.status };
                return { report: await response.json(), httpStatus: response.status, error: null };
              } catch (_) {
                return { report: {}, httpStatus: null, error: "RugCheck request failed" };
              }
            })(),
            fetchSolanaMintEvidence(env, address)
          ]);
          const report = rugCheckResult.report || {};
          const risks = Array.isArray(report.risks) ? report.risks : [];
          const critical = risks.filter((risk) => ["danger", "critical"].includes(String(risk.level || "").toLowerCase()));
          const warnings = risks.filter((risk) => ["high", "medium", "caution", "warn", "warning", "info"].includes(String(risk.level || "").toLowerCase()));
          const hasUsableReport = !!report.tokenProgram || risks.length > 0 || report.score_normalised != null || report.lpLockedPct != null;
          const hasAnyEvidence = hasUsableReport || mintEvidence.status === "ok" || mintEvidence.status === "incomplete";
          const lpLockedPct = report.lpLockedPct == null || !Number.isFinite(Number(report.lpLockedPct))
            ? null : Number(report.lpLockedPct);
          const weakLiquidityLock = lpLockedPct !== null && lpLockedPct < 80;
          const unknownLiquidityLock = lpLockedPct === null;
          const rugged = report.rugged === true;
          const mintAuthority = report.mintAuthority ?? report.token?.mintAuthority ?? null;
          const freezeAuthority = report.freezeAuthority ?? report.token?.freezeAuthority ?? null;
          const rugMintField = Object.prototype.hasOwnProperty.call(report, "mintAuthority") ||
            Object.prototype.hasOwnProperty.call(report.token || {}, "mintAuthority");
          const rugFreezeField = Object.prototype.hasOwnProperty.call(report, "freezeAuthority") ||
            Object.prototype.hasOwnProperty.call(report.token || {}, "freezeAuthority");
          const rugAuthorityFieldsPresent = rugMintField && rugFreezeField;
          const activeAuthorities = mintAuthority != null || freezeAuthority != null ||
            mintEvidence.mintAuthorityActive === true || mintEvidence.freezeAuthorityActive === true;
          const authorityEvidencePresent = rugAuthorityFieldsPresent || mintEvidence.authorityFieldsPresent === true;
          const unknownAuthorities = !authorityEvidencePresent;
          const holderRows = Array.isArray(report.topHolders) ? report.topHolders.slice(0, 10) : [];
          const holderValues = holderRows.map(holder => {
            const value = holder && (holder.pct ?? holder.percent ?? holder.percentage);
            return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
          });
          const holderConcentrationPct = holderRows.length >= 10 && holderValues.every(value => value !== null)
            ? holderValues.reduce((sum, value) => sum + value, 0) : null;
          const holderConcentrationStatus = holderConcentrationPct === null ? "unknown"
            : holderConcentrationPct >= 80 ? "high" : holderConcentrationPct >= 50 ? "elevated" : "observed";
          const holderConcentrationReason = holderConcentrationPct === null
            ? "前十大持币集中度数据缺失或不足10个有效持币记录，需复核"
            : holderConcentrationPct >= 80
              ? "前十大持币地址合计占比达到" + holderConcentrationPct.toFixed(2) + "%，集中度过高"
              : holderConcentrationPct >= 50
                ? "前十大持币地址合计占比达到" + holderConcentrationPct.toFixed(2) + "%，集中度偏高" : "";
          const holderHardRisk = holderConcentrationPct !== null && holderConcentrationPct >= 80;
          const holderReviewRisk = holderConcentrationPct === null || holderConcentrationPct >= 50;
          const riskyExtensions = mintEvidence.riskyExtensions || [];
          const unassessedExtensions = mintEvidence.unassessedExtensions || [];
          const extensionReviewRisk = riskyExtensions.length > 0 || unassessedExtensions.length > 0 || mintEvidence.status === "incomplete";
          const status = rugged || critical.length || holderHardRisk ? "blocked" :
            (!hasAnyEvidence || warnings.length || weakLiquidityLock || unknownLiquidityLock ||
             activeAuthorities || unknownAuthorities || holderReviewRisk || extensionReviewRisk) ? "review" : "pass";
          return json({
            ok: true, chain, tokenAddress: address, provider: "RugCheck + Solana RPC",
            status, riskScore: report.score_normalised ?? null, lpLockedPct,
            top10HolderConcentrationPct: holderConcentrationPct,
            holderConcentrationStatus, holderCountChecked: holderRows.length,
            liquidityLockStatus: unknownLiquidityLock ? "unknown" : weakLiquidityLock ? "below_threshold" : "meets_threshold",
            solanaRpcStatus: mintEvidence.status,
            solanaRpcHttpStatus: mintEvidence.httpStatus,
            solanaRpcError: mintEvidence.error,
            solanaTokenProgram: mintEvidence.tokenProgram,
            solanaMintAuthorityActive: mintEvidence.mintAuthorityActive,
            solanaFreezeAuthorityActive: mintEvidence.freezeAuthorityActive,
            solanaExtensions: mintEvidence.extensionNames,
            solanaRiskyExtensions: riskyExtensions,
            solanaUnassessedExtensions: unassessedExtensions,
            rugCheckHttpStatus: rugCheckResult.httpStatus,
            rugCheckError: rugCheckResult.error,
            risks: risks.map((risk) => ({ name: risk.name, level: risk.level, value: risk.value, description: risk.description })),
            reasons: [
              ...(rugged ? ["RugCheck 标记该代币已发生 Rug"] : []),
              ...critical.map((x) => x.name),
              ...warnings.map((x) => x.name),
              ...(!hasAnyEvidence ? ["RugCheck 与 Solana RPC 均未返回可用安全证据"] : []),
              ...(rugCheckResult.error ? ["RugCheck 数据源不可用：" + rugCheckResult.error] : []),
              ...(mintEvidence.error ? ["Solana 链上权限数据不可用：" + mintEvidence.error] : []),
              ...(weakLiquidityLock ? ["已报告的流动性锁定比例低于80%"] : []),
              ...(unknownLiquidityLock ? ["流动性锁定数据缺失，无法确认；不代表已确认未锁定"] : []),
              ...(activeAuthorities ? ["链上或 RugCheck 证据显示 Mint / Freeze Authority 仍有效"] : []),
              ...(unknownAuthorities ? ["Mint / Freeze Authority 状态缺失，无法确认"] : []),
              ...(riskyExtensions.length ? ["检测到需要人工复核的 Token-2022 扩展：" + riskyExtensions.join(", ")] : []),
              ...(unassessedExtensions.length ? ["存在尚未评估的 Token-2022 扩展：" + unassessedExtensions.join(", ")] : []),
              ...(mintEvidence.tokenProgram === "token-2022" && mintEvidence.status === "incomplete" && !unassessedExtensions.length
                ? ["Token-2022 扩展数据不完整，无法确认全部转账控制"] : []),
              ...(holderConcentrationReason ? [holderConcentrationReason] : [])
            ],
            note: "新增 Solana RPC 独立读取 Mint / Freeze Authority 和 Token-2022 扩展；RugCheck 仍负责风险摘要、持币与 LP 锁定信号。池子/项目地址可能影响持币集中度。任一数据源失败或字段不完整均不会被当作安全通过。"
          });
        }
        const chainIds = { ethereum: 1, eth: 1, bsc: 56, base: 8453 };
        const chainID = chainIds[chain];
        if (!chainID) return json({ ok: false, status: "unverified", error: "unsupported chain" }, 400);
        const params = new URLSearchParams({ address, chainID: String(chainID) });
        if (pair) params.set("pair", pair);
        // Honeypot simulation and GoPlus holder concentration are independent
        // providers. A Honeypot outage must not skip the GoPlus risk check.
        let report = {};
        let honeypotError = null;
        let honeypotResponseStatus = null;
        let honeypotResponseBody = null;
        try {
          const honeypotResponse = await fetch("https://api.honeypot.is/v2/IsHoneypot?" + params.toString(), { headers: { "accept": "application/json" } });
          honeypotResponseStatus = honeypotResponse.status;
          const honeypotText = await honeypotResponse.text();
          if (!honeypotResponse.ok) {
            honeypotResponseBody = honeypotText.slice(0, 1200);
            throw new Error("Honeypot.is HTTP " + honeypotResponse.status + (honeypotResponseBody ? ": " + honeypotResponseBody : ""));
          }
          try { report = JSON.parse(honeypotText); }
          catch (_) { honeypotResponseBody = honeypotText.slice(0, 1200); throw new Error("Honeypot.is returned invalid JSON"); }
        } catch (error) {
          honeypotError = String(error);
        }
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
        let holderConcentrationPct = null;
        let holderConcentrationStatus = "unknown";
        let holderCountChecked = 0;
        let holderConcentrationReason = "前十大持币集中度数据暂不可用，需复核";
        let holderProviderStatus = "not_checked";
        let holderProviderHttpStatus = null;
        let holderProviderCode = null;
        let holderProviderMessage = null;
        let goPlusCacheStatus = "miss";
        let goPlusCacheScope = "none";
        let goPlusKvStoreStatus = "unknown";
        let goPlusCooldownSeconds = null;
        let goPlusOpenSource = null;
        try {
          const holderCacheKey = "security:goplus:v1:" + chainID + ":" + address.toLowerCase();
          const holderResponse = await fetchGoPlusCached(env,
            "https://api.gopluslabs.io/api/v1/token_security/" + chainID + "?contract_addresses=" + encodeURIComponent(address),
            holderCacheKey);
          goPlusCacheStatus = holderResponse.headers.get("x-radar-goplus-cache") || "miss";
          goPlusCacheScope = holderResponse.headers.get("x-radar-goplus-cache-scope") || "none";
          goPlusKvStoreStatus = holderResponse.headers.get("x-radar-goplus-kv-store") || "unknown";
          const cooldownHeader = holderResponse.headers.get("x-radar-goplus-cooldown-seconds");
          goPlusCooldownSeconds = cooldownHeader ? Number(cooldownHeader) : null;
          holderProviderHttpStatus = holderResponse.status;
          if (!holderResponse.ok) {
            holderProviderStatus = "http_error";
            holderProviderMessage = "GoPlus HTTP " + holderResponse.status;
          } else {
            const holderBody = await holderResponse.json();
            holderProviderCode = holderBody && holderBody.code != null ? String(holderBody.code) : null;
            holderProviderMessage = holderBody && (holderBody.message || holderBody.msg) || null;
            if (holderBody && holderBody.code != null && String(holderBody.code) !== "1") {
              holderProviderStatus = "api_error";
            } else {
              const holderRecord = holderBody && holderBody.result && (holderBody.result[address.toLowerCase()] || holderBody.result[address] || Object.values(holderBody.result)[0]);
              if (holderRecord) {
                holderProviderStatus = "ok";
                if (holderRecord.is_open_source === "1" || holderRecord.is_open_source === 1) goPlusOpenSource = true;
                else if (holderRecord.is_open_source === "0" || holderRecord.is_open_source === 0) goPlusOpenSource = false;
              } else {
                holderProviderStatus = "no_token_data";
              }
              const holderRows = holderRecord && Array.isArray(holderRecord.holders) ? holderRecord.holders.slice(0, 10) : [];
              const holderValues = holderRows.map(holder => {
                const value = holder && holder.percent;
                return value == null || !Number.isFinite(Number(value)) ? null : Number(value) * 100;
              });
              holderCountChecked = holderRows.length;
              if (holderRows.length >= 10 && holderValues.every(value => value !== null)) {
                holderConcentrationPct = holderValues.reduce((sum, value) => sum + value, 0);
                holderConcentrationStatus = holderConcentrationPct >= 80 ? "high" : holderConcentrationPct >= 50 ? "elevated" : "observed";
                holderConcentrationReason = holderConcentrationPct >= 80
                  ? "前十大持币地址合计占比达到" + holderConcentrationPct.toFixed(2) + "%，集中度过高"
                  : holderConcentrationPct >= 50
                    ? "前十大持币地址合计占比达到" + holderConcentrationPct.toFixed(2) + "%，集中度偏高" : "";
              }
            }
          }
        } catch (error) {
          holderProviderStatus = "request_error";
          holderProviderMessage = String(error);
        }
        const holderHardRisk = holderConcentrationPct !== null && holderConcentrationPct >= 80;
        const holderReviewRisk = holderConcentrationPct === null || holderConcentrationPct >= 50;
        const reviewRisk = !simOK || riskLevel === null || riskLevel >= 60 ||
          buyTax === null || sellTax === null || buyTax > 10 || sellTax > 10 ||
          highFlags.length > 0 || report.contractCode?.rootOpenSource !== true || holderReviewRisk;
        const status = hardRisk || holderHardRisk ? "blocked" : reviewRisk ? "review" : "pass";
        return json({
          ok: true, chain, tokenAddress: address, provider: "Honeypot.is + GoPlus",
          status, top10HolderConcentrationPct: holderConcentrationPct,
          holderConcentrationStatus, holderCountChecked,
          holderProviderStatus, holderProviderHttpStatus, holderProviderCode, holderProviderMessage, goPlusOpenSource,
          goPlusCacheStatus,
          goPlusCacheScope,
          goPlusKvStoreStatus,
          goPlusCooldownSeconds,
          honeypotHttpStatus: honeypotResponseStatus,
          honeypotResponseBody,
          simulationSuccess: report.simulationSuccess === true,
          isHoneypot: report.honeypotResult?.isHoneypot ?? null,
          risk: report.summary?.risk || "unknown", riskLevel,
          buyTax, sellTax, openSource: report.contractCode?.rootOpenSource ?? null,
          pairAddress: report.pairAddress || report.pair?.pair?.address || null,
          honeypotError,
          reasons: [
            ...(honeypotError ? ["Honeypot.is 买卖模拟服务暂不可用："+honeypotError] : []),
            ...(isHoneypot ? ["检测到貔貅/无法正常卖出"] : []),
            ...(riskLevel !== null && riskLevel >= 60 ? ["Honeypot 风险等级偏高"] : []),
            ...(sellTax !== null && sellTax > 10 ? ["卖出税超过10%"] : []),
            ...(!simOK ? ["买卖模拟未成功或结果不完整"] : []),
            ...(!report.contractCode?.rootOpenSource ? ["合约源码未确认开源"] : []),
            ...criticalFlags.map((x) => x.description || x.flag),
            ...highFlags.map((x) => x.description || x.flag),
            ...(holderConcentrationReason ? [holderConcentrationReason] : []),
            ...(holderProviderStatus !== "ok" ? ["GoPlus持币数据源状态："+holderProviderStatus+(holderProviderHttpStatus ? "（HTTP "+holderProviderHttpStatus+"）" : "")+(holderProviderMessage ? "："+holderProviderMessage : "")] : []),
            ...(goPlusOpenSource === false ? ["GoPlus显示合约源码未开源"] : [])
          ],
          note: "GoPlus前十大持币比例基于其返回的持币列表，可能包含池子或项目地址；缺失数据按待复核处理。模拟结果只代表本次检测时点和检测路径；代币权限或流动性变化后风险可能改变。"
        });
      } catch (error) {
        return json({ ok: true, chain, tokenAddress: address, provider: chain === "solana" ? "RugCheck" : "Honeypot.is", status: "unverified", error: String(error), note: "安全数据不可用，按未验证处理，不进入通过安全检查的观察名单。" });
      }
    }
    if (url.pathname === "/multiscan") {
      const minutes = Number(url.searchParams.get("minutes") || 15);
      const minLiquidity = Math.max(0, Number(url.searchParams.get("minLiquidity") || 5000));
      if (![15, 30, 60].includes(minutes)) return json({ ok: false, error: "minutes must be 15, 30, or 60" }, 400);
      const requestedChains = String(url.searchParams.get("chains") || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
      // Brief KV cache avoids multiplying public-provider calls on repeated refreshes.
      const scanKv = env && env.RADAR_KV;
      const scanCacheKey = "multiscan:scope-v1:" + (requestedChains.length ? requestedChains.join(",") : "all") + ":" + minutes + ":" + minLiquidity;
      if (scanKv && typeof scanKv.get === "function") {
        try {
          const cachedScan = await scanKv.get(scanCacheKey, "json");
          const cachedAt = cachedScan && Number(cachedScan._cachedAt);
          const ageSeconds = cachedAt > 0 ? Math.floor(Date.now() / 1000 - cachedAt) : Infinity;
          if (cachedScan && cachedScan.payload && ageSeconds >= 0 && ageSeconds < 45) {
            return json({ ...cachedScan.payload, cache: { status: "hit", ageSeconds, ttlSeconds: 45 } });
          }
        } catch (_) {}
      }
      // Keep every chain available for future restoration, while allowing the
      // client to request a reduced stable scan scope (for example chains=solana).
      const availableNetworks = [
        { id: "solana", name: "Solana", dexChain: "solana" },
        { id: "eth", name: "Ethereum", dexChain: "ethereum" },
        { id: "base", name: "Base", dexChain: "base" }
      ];
      const networks = requestedChains.length
        ? availableNetworks.filter(network => requestedChains.includes(network.id))
        : availableNetworks;
      if (requestedChains.length && networks.length === 0) {
        return json({ ok: false, error: "chains must include a supported chain: solana, eth, base" }, 400);
      }
      const results = [];
      const errors = [];
      const chainSources = [];
      const failedNetworks = [];
      // Once DexPaprika returns HTTP 429 for one chain, stop retrying the same
      // provider for the remaining chains in this invocation. The provider
      // cooldown is shared, so repeating the same fallback only repeats errors.
      let dexPaprikaRateLimited = false;
      let dexPaprikaRateLimitError = "";
      for (const network of networks) {
        try {
          const endpoint = "https://api.geckoterminal.com/api/v2/networks/" + network.id + "/new_pools?include=base_token,quote_token,dex";
          const response = await fetchGeckoTerminal(endpoint);
          if (!response.ok) {
            const providerState = response.headers.get("x-radar-provider-state");
            const detail = providerState === "shared-cooldown"
              ? "GeckoTerminal shared cooldown (previous upstream HTTP 429)"
              : providerState === "upstream-rate-limit"
                ? "GeckoTerminal upstream HTTP 429 (provider rate limit)"
                : "GeckoTerminal HTTP " + response.status;
            throw new Error(detail);
          }
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
            const priceChange5m = a.price_change_percentage && a.price_change_percentage.m5 != null
              ? Number(a.price_change_percentage.m5) : null;
            const priceChange15m = a.price_change_percentage && a.price_change_percentage.m15 != null
              ? Number(a.price_change_percentage.m15) : null;
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
              priceChange1h, priceChange5m, priceChange15m,
              usdtRouteStatus: "not_verified", source: "GeckoTerminal",
              riskNote: "第三方新池索引数据；USDT 路由尚未实时报价验证。新池风险高，请独立核实合约、流动性和卖出能力。"
            });
            chainPoolCount++;
          }
          if (chainPoolCount === 0) {
            // A successful HTTP response with zero qualifying pools is not proof
            // that the index covered this chain. Try the independent fallback.
            failedNetworks.push({ network, error: "GeckoTerminal returned no pools meeting age/liquidity/token filters" });
          } else {
            chainSources.push({ chain: network.name, provider: "GeckoTerminal", status: "ok", pools: chainPoolCount });
          }
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
              if (!response.ok) {
                const state = response.headers.get("x-radar-provider-state");
                throw new Error("HTTP " + response.status + (state === "shared-cooldown" ? "（数据源冷却中）" : state === "cached-provider-error" ? "（缓存的限流错误）" : ""));
              }
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
              if (!pairResponse.ok) {
                const state = pairResponse.headers.get("x-radar-provider-state");
                throw new Error("DexScreener token pairs HTTP " + pairResponse.status + (state === "shared-cooldown" ? "（数据源冷却中）" : state === "cached-provider-error" ? "（缓存的限流错误）" : ""));
              }
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
                  priceChange5m: pair.priceChange && pair.priceChange.m5 != null ? Number(pair.priceChange.m5) : null,
                  priceChange15m: pair.priceChange && pair.priceChange.m15 != null ? Number(pair.priceChange.m15) : null,
                  usdtRouteStatus: "not_verified",
                  source: "DexScreener profiles + boosts fallback",
                  riskNote: "备用索引合并 DexScreener 最新 Token Profile 与 Boost 名单反查交易池，覆盖范围小于完整新池索引；不代表捕获该链全部新池。"
                });
                chainPoolCount++;
              }
              if (chainPoolCount === 0) {
                throw new Error("DexScreener returned no pools meeting age/liquidity/token filters");
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
              // If it has already rate-limited this invocation, do not call it again.
              if (dexPaprikaRateLimited) {
                errors.push({ chain: network.name, error: failed.error + "; DexScreener fallback: " + String(fallbackError) + "; DexPaprika fallback skipped after shared provider rate limit (" + dexPaprikaRateLimitError + ")" });
                chainSources.push({ chain: network.name, provider: "GeckoTerminal + DexScreener + DexPaprika", status: "error", note: "DexPaprika fallback skipped after provider rate limit" });
                continue;
              }
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
                if (!searchResponse.ok) {
                  const cooldownLabel = searchResponse.headers.get("x-radar-provider-state") === "shared-cooldown"
                    ? "（数据源冷却中）"
                    : searchResponse.headers.get("x-radar-provider-state") === "cached-provider-error" ? "（缓存的额度/限流错误）" : "";
                  throw new Error("DexPaprika pool search HTTP " + searchResponse.status + cooldownLabel + (searchResponse.status === 402 ? "（额度/套餐限制，备用源暂不可用）" : ""));
                }
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
                    throw new Error("DexPaprika pool detail HTTP " + detailResponse.status + (detailResponse.status === 402 ? "（额度/套餐限制，备用源暂不可用）" : ""));
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
                    priceChange5m: summary.price_change_percentage_5m != null ? Number(summary.price_change_percentage_5m) : null,
                    priceChange15m: null,
                    usdtRouteStatus: "not_verified", source: "DexPaprika independent fallback",
                    riskNote: "第三方独立备用索引；只返回首批有限池并逐池补充代币信息，覆盖范围不完整；USDT 路由未验证。"
                  });
                  chainPoolCount++;
                }
                if (chainPoolCount === 0) {
                  throw new Error("DexPaprika returned no pools meeting age/liquidity/token filters");
                }
                chainSources.push({
                  chain: network.name, provider: "DexPaprika",
                  status: "fallback", coverage: "partial", pools: chainPoolCount,
                  primaryError: failed.error, previousFallbackError: String(fallbackError)
                });
                fallbackChains.push(network.name);
              } catch (dexPaprikaError) {
                if (/HTTP 429|Too Many Requests/i.test(String(dexPaprikaError))) {
                  dexPaprikaRateLimited = true;
                  dexPaprikaRateLimitError = String(dexPaprikaError);
                }
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
      const solanaRpcDiagnostics = [];
      const failedSolana = failedNetworks.find(item => item.network.id === "solana");
      const indexedSolanaPoolCount = results.filter(item => item.chainId === "solana" || item.chain === "Solana").length;
      // Run the protocol decoder when the Solana index failed OR returned no
      // qualifying pools. An HTTP 200 with an empty first page is not proof
      // that no recent Raydium CPMM pools exist.
      if ((failedSolana || indexedSolanaPoolCount === 0) && networks.some(item => item.id === "solana")) {
        const solanaRpcUrl = String(env && env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").trim();
        if (!/^https:\/\//i.test(solanaRpcUrl) || /\s/.test(solanaRpcUrl)) {
          solanaRpcDiagnostics.push({
            chain: "Solana", provider: "Solana JSON-RPC", status: "error",
            error: "SOLANA_RPC_URL must be a valid HTTPS endpoint"
          });
        } else {
          const scanned = await scanSolanaRpcActivity(solanaRpcUrl, minutes, minLiquidity);
          results.push(...scanned.pools);
          const { pools: _decodedPools, ...diagnostics } = scanned;
          solanaRpcDiagnostics.push(diagnostics);
        }
      }

      // When all indexed providers fail or return no qualifying pools, use a
      // separately configured chain RPC to inspect recent stablecoin-quoted V2
      // PairCreated events. This is deliberately partial coverage, not a full
      // chain-wide DEX index.
      const evmRpcDiagnostics = [];
      for (const failed of failedNetworks) {
        const network = failed.network;
        const config = EVM_RPC_SCAN_CONFIG[network.id];
        if (!config) continue;
        // Do not replace a successful indexed fallback with an RPC warning.
        if (chainSources.some((source) => source.chain === network.name &&
          (source.status === "ok" || source.status === "fallback"))) continue;
        const chainRpcUrl = env && env[config.envKey];
        if (!chainRpcUrl) {
          evmRpcDiagnostics.push({
            chain: network.name,
            provider: config.networkLabel + " RPC",
            status: "not_configured",
            requiredSecret: config.envKey,
            note: "请在 Cloudflare Worker Settings → Variables and Secrets 中添加该 RPC Secret。"
          });
          continue;
        }
        try {
          const scanned = await scanEvmRpcRecentPools(config, chainRpcUrl, minutes, minLiquidity);
          results.push(...scanned.pools);
          evmRpcDiagnostics.push(scanned.diagnostics);
          chainSources.push({
            chain: network.name,
            provider: config.networkLabel + " RPC · " + config.dex,
            status: "fallback",
            coverage: "partial",
            pools: scanned.pools.length,
            diagnostics: scanned.diagnostics,
            primaryIndexError: failed.error
          });
          fallbackChains.push(network.name + " RPC");
        } catch (rpcError) {
          const detail = config.networkLabel + " RPC fallback: " + String(rpcError);
          evmRpcDiagnostics.push({
            chain: network.name,
            provider: config.networkLabel + " RPC",
            status: "error",
            error: String(rpcError)
          });
          errors.push({ chain: network.name, error: failed.error + "; " + detail });
          chainSources.push({
            chain: network.name,
            provider: config.networkLabel + " RPC",
            status: "error",
            note: String(rpcError)
          });
        }
      }
      results.sort((a, b) => a.ageMinutes - b.ageMinutes || b.volume1hUSD - a.volume1hUSD);
      const responsePayload = {
        ok: true,
        complete: errors.length === 0,
        mode: "multichain-new-pools",
        chains: networks.map((x) => x.name),
        minutes,
        minLiquidityUSD: minLiquidity,
        dataSource: "GeckoTerminal primary; DexScreener profiles/boosts fallback; DexPaprika independent fallback when both fail",
        coverage: fallbackChains.length ? "partial" : "primary-index",
        providerDiagnostics: {
          geckoTerminal: {
            note: "shared-cooldown 表示命中本 Worker 所在 Cloudflare 边缘数据中心的冷却缓存；upstream-rate-limit 表示本次请求实际收到上游429。",
            cooldownSeconds: PROVIDER_COOLDOWN_SECONDS
          },
          dexScreener: {
            note: "HTTP 429 后进入5分钟冷却；冷却期间不会重复请求该公共 Feed。",
            cooldownSeconds: PROVIDER_COOLDOWN_SECONDS
          },
          dexPaprika: {
            note: "HTTP 402 额度/套餐错误后进入10分钟冷却；HTTP 429 后进入5分钟冷却。",
            quotaCooldownSeconds: 600,
            rateLimitCooldownSeconds: PROVIDER_COOLDOWN_SECONDS
          }
        },
        chainSources,
        evmRpcDiagnostics,
        solanaRpcDiagnostics,
        fallbackChains,
        count: results.length,
        pools: results,
        chainErrors: errors,
        limitations: [
          "当前稳定模式只主动扫描 Solana；BSC 继续使用原有链上扫描接口。Ethereum/Base 暂停主动请求，相关代码和 RPC 备用配置保留，后续可恢复。",
          "GeckoTerminal new_pools 每页最多返回20个池；本版本每条链只取第一页，不保证覆盖全部新池。",
          "GeckoTerminal 公共 API 可能限流；失败时先尝试 DexScreener 最新 Token Profile 与 Boost 名单，若也失败则尝试 DexPaprika 最近新池搜索。备用源只取有限结果且覆盖不完整，必须显示为部分覆盖，不能当作完整新池扫描；第三方 API 仍可能限流。",
          "Ethereum/Base 在索引源失败时可选使用 ETH_RPC_URL / BASE_RPC_URL 扫描配置的 Uniswap V2 稳定币直连池；仅覆盖单一 V2 工厂，不覆盖全链 DEX，也不提供完整成交/K线数据。",
          "RPC 新池发现结果缺少成交量、买卖次数、价格历史或钱包兑换验证时，必须进入待复核，不能视为通过安全筛查。",
          "流动性、成交量、买卖次数和价格变化来自第三方索引，可能有延迟或缺失。",
          "多链报价资产会显示其索引符号；只有标记为 USDT 的池才表示池子直接以 USDT 为一侧资产，仍不代表钱包兑换路径已验证。",
          "Solana RPC 仅对 Raydium CPMM initialize 指令执行协议级解码，并核验池账户程序归属、双侧 Vault Token 程序和 Mint 关联；仅 USDT/USDC 报价池可按稳定币侧储备×2估算流动性。Pump.fun、PumpSwap、Raydium AMM v4、Meteora、Orca 当前仍只做活动线索诊断；本兜底不是全 Solana 新池索引，成交/K线/钱包路由缺失的候选仍待复核。",
          "公共索引和 RPC 的 429/402 使用共享冷却；5xx 最多重试一次并进入短冷却。冷却和缓存是尽力而为的 Cloudflare 边缘级治理，不代表上游配额已恢复。",
          "本接口只读，不执行兑换或交易。"
        ],
        generatedAt: new Date().toISOString()
      };
      if (scanKv && typeof scanKv.put === "function") {
        try {
          await scanKv.put(scanCacheKey, JSON.stringify({
            _cachedAt: Math.floor(Date.now() / 1000),
            payload: responsePayload
          }), { expirationTtl: 90 });
        } catch (_) {}
      }
      return json({ ...responsePayload, cache: { status: "miss", ageSeconds: 0, ttlSeconds: 45 } });
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
      const cutoffTime = latestTime - minutes * 60000;
      // Locate the first block at or before the requested time boundary.
      // Expand the lower bound if the initial estimate is too recent, then
      // binary-search timestamps so minutes=15/30/60 maps to a real time window.
      let span = Math.max(100, Math.ceil(minutes * 60 / 0.5) + 100);
      let low = Math.max(0, latest - span);
      let lowBlock = await rpc("eth_getBlockByNumber", [hexNum(low), false], rpcUrl);
      while (low > 0 && asNumber(lowBlock.timestamp) * 1000 > cutoffTime) {
        span = Math.min(latest, span * 2);
        low = Math.max(0, latest - span);
        lowBlock = await rpc("eth_getBlockByNumber", [hexNum(low), false], rpcUrl);
      }
      let high = latest;
      while (low + 1 < high) {
        const mid = Math.floor((low + high) / 2);
        const midBlock = await rpc("eth_getBlockByNumber", [hexNum(mid), false], rpcUrl);
        if (asNumber(midBlock.timestamp) * 1000 <= cutoffTime) low = mid;
        else high = mid;
      }
      const fromBlock = low;
      const blockWindow = latest - fromBlock;
      const windowStartBlock = await rpc("eth_getBlockByNumber", [hexNum(fromBlock), false], rpcUrl);
      const windowStartTime = asNumber(windowStartBlock.timestamp) * 1000;
      const actualWindowSeconds = Math.max(0, (latestTime - windowStartTime) / 1000);
      const factoryFilterBase = { fromBlock: hexNum(fromBlock), toBlock: latestHex };
      // JSON-RPC eth_getLogs accepts an address array. Query all configured
      // V2 factories in one subrequest, then partition locally by emitting factory.
      const v2FactoryLogs = await rpc("eth_getLogs", [{
        ...factoryFilterBase, address: V2_FACTORIES.map((factory) => factory.address), topics: [PAIR_CREATED]
      }], rpcUrl);
      const v2FactoryResults = V2_FACTORIES.map((factory) => {
        const allLogs = v2FactoryLogs.filter((log) => String(log.address).toLowerCase() === factory.address.toLowerCase());
        const usdtLogs = allLogs.filter((log) =>
          fromTopic(log.topics[1] || "") === USDT || fromTopic(log.topics[2] || "") === USDT
        );
        return { factory, allLogs, usdtLogs };
      });
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
      // Same aggregation for V3 factories: two version-level log queries total.
      const v3FactoryLogs = await rpc("eth_getLogs", [{
        ...factoryFilterBase, address: V3_FACTORIES.map((factory) => factory.address), topics: [V3_POOL_CREATED]
      }], rpcUrl);
      const v3FactoryResults = V3_FACTORIES.map((factory) => {
        const allLogs = v3FactoryLogs.filter((log) => String(log.address).toLowerCase() === factory.address.toLowerCase());
        const usdtLogs = allLogs.filter((log) =>
          fromTopic(log.topics[1] || "") === USDT || fromTopic(log.topics[2] || "") === USDT
        );
        return { factory, allLogs, usdtLogs };
      });
      // Quote-asset counts are diagnostics only. Only USDT pools continue into
      // the candidate pipeline; WBNB/USDC/BUSD pools are never promoted here.
      const BSC_QUOTE_ASSETS = [
        { symbol: "USDT", address: USDT.toLowerCase() },
        { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" },
        { symbol: "WBNB", address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" },
        { symbol: "BUSD", address: "0xe9e7cea3dedca5984780bafc599bd69add087d56" }
      ];
      const quoteAssetDiagnostics = Object.fromEntries(BSC_QUOTE_ASSETS.map((asset) => {
        const v2Count = v2FactoryResults.reduce((sum, item) => sum + item.allLogs.filter((log) =>
          fromTopic(log.topics[1] || "") === asset.address || fromTopic(log.topics[2] || "") === asset.address
        ).length, 0);
        const v3Count = v3FactoryResults.reduce((sum, item) => sum + item.allLogs.filter((log) =>
          fromTopic(log.topics[1] || "") === asset.address || fromTopic(log.topics[2] || "") === asset.address
        ).length, 0);
        return [asset.symbol, { v2PoolCreatedEvents: v2Count, v3PoolCreatedEvents: v3Count, total: v2Count + v3Count }];
      }));
      // Factory addresses are pinned in source control. Re-fetching bytecode for
      // all eight factories on every scan adds no candidate evidence and wastes
      // Worker subrequests; deployment-time configuration is reported instead.
      const factoryCodeChecks = [...V2_FACTORIES, ...V3_FACTORIES].map((factory) => ({
        dex: factory.name, address: factory.address,
        contractCodePresent: null, codeCheckStatus: "skipped_to_conserve_subrequests"
      }));
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
      // Every queried pair was created inside the requested <= 60 minute window.
      // A pair cannot emit Swap logs before its creation block, so these logs are
      // already time-bounded by the pool's own lifetime. Avoid one RPC block-time
      // lookup per distinct swap block: that fan-out exhausted Cloudflare's
      // subrequest budget on active pools.
      const pools = valid.map((p) => {
        const swaps = (swapsByPair.get(p.pair.toLowerCase()) || []).sort((a, b) => {
          const blockDiff = asNumber(a.blockNumber) - asNumber(b.blockNumber);
          return blockDiff || asNumber(a.logIndex) - asNumber(b.logIndex);
        });
        let volume1hUSD = 0, buys1h = 0, sells1h = 0;
        const prices = [];
        for (const s of swaps) {
          // The address-filtered log query starts no earlier than the oldest
          // candidate creation block. Enforce each pair's own creation block
          // as an additional guard; no timestamp RPC is needed for this window.
          if (asNumber(s.blockNumber) < p.createdBlock) continue;
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
          volume1hUSD: swapError ? null : volume1hUSD,
          buys1h: swapError ? null : buys1h,
          sells1h: swapError ? null : sells1h,
          priceChange1h: swapError ? null : priceChange1h,
          swapCount1h: swapError ? null : buys1h + sells1h,
          riskNote: "新池风险高；链上新池事件不代表代币安全。请另行核实合约权限、持币集中度、卖出限制及流动性变化。" +
            (swapError ? " 本轮 Swap 数据查询失败，成交指标未知，不得将其解释为零成交。" : "")
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
        windowStartBlock: fromBlock,
        windowStartTimestamp: new Date(windowStartTime).toISOString(),
        actualWindowSeconds: Math.round(actualWindowSeconds),
        requestedWindowSeconds: minutes * 60,
        blockWindow: blockWindow,
        quoteAssetDiagnostics: quoteAssetDiagnostics,
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
        swapStatsStatus: swapError ? "unavailable" : "available",
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