import { FOURMEME_TOKEN_MANAGER2_BSC } from "./fourmeme-event-shadow.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_HASHES = 32;
const DEFAULT_MAX_BLOCK_SPAN = 2000;
// Keep this OR-filter aligned with the five event signatures decoded by
// fourmeme-event-shadow.js. Without topic0 filtering, unrelated contract logs
// can make the collector fail on an otherwise valid observation range.
const FOURMEME_EVENT_TOPICS = Object.freeze([
  "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20", // TokenCreate
  "0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942", // TokenPurchase
  "0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19", // TokenSale
  "0x8f9ab4bd7eff0d085f91575d50cd83f97aa5258e24ded7630d4fd6739e857132", // TradeStop
  "0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0"  // LiquidityAdded
]);

function toQuantity(value, field) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError(`Invalid ${field}`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${field}`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError(`Invalid ${field}`);
}

function rpcHex(value) {
  return `0x${value.toString(16)}`;
}

function validateBlock(block, field) {
  if (!block || typeof block !== "object" ||
      typeof block.number !== "string" || !/^0x[0-9a-fA-F]+$/.test(block.number) ||
      typeof block.hash !== "string" || !HASH_RE.test(block.hash)) {
    throw new TypeError(`Incomplete ${field} block response`);
  }
  return { number: BigInt(block.number).toString(), hash: block.hash.toLowerCase() };
}

/**
 * Create a bounded, read-only JSON-RPC adapter for the Four.meme collector.
 * It never queries "latest" for collection finality and never submits writes.
 */
export function createNodeRealFourMemeRpcAdapter({
  endpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxHashLookups = DEFAULT_MAX_HASHES,
  maxBlockSpan = DEFAULT_MAX_BLOCK_SPAN
} = {}) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new TypeError("A valid NodeReal RPC URL is required"); }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new TypeError("NodeReal RPC endpoint must use HTTPS");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000 ||
      !Number.isSafeInteger(maxHashLookups) || maxHashLookups < 1 || maxHashLookups > 32 ||
      !Number.isSafeInteger(maxBlockSpan) || maxBlockSpan < 1 || maxBlockSpan > 2000) {
    throw new TypeError("Invalid RPC adapter bounds");
  }

  let nextId = 1;
  let chainIdVerified = false;
  async function post(payload) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new Error("NodeReal RPC transport failed; endpoint details are intentionally hidden");
    }
    if (!response.ok) throw new Error(`NodeReal RPC HTTP status ${response.status}`);
    let body;
    try { body = await response.json(); } catch {
      throw new Error("NodeReal RPC returned invalid JSON");
    }
    return body;
  }

  async function call(method, params) {
    const id = nextId++;
    const body = await post({ jsonrpc: "2.0", id, method, params });
    if (!body || body.id !== id || body.error || body.result == null) {
      throw new Error(`NodeReal RPC method failed: ${method}`);
    }
    return body.result;
  }

  async function batch(calls) {
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > maxHashLookups) {
      throw new TypeError("RPC batch exceeds configured request bound");
    }
    const requests = calls.map(({ method, params }) => ({
      jsonrpc: "2.0", id: nextId++, method, params
    }));
    const body = await post(requests);
    if (!Array.isArray(body) || body.length !== requests.length) {
      throw new Error("NodeReal RPC returned an invalid batch response");
    }
    const byId = new Map(body.map(item => [item?.id, item]));
    return requests.map(request => {
      const item = byId.get(request.id);
      if (!item || item.error || item.result == null) {
        throw new Error(`NodeReal RPC batch method failed: ${request.method}`);
      }
      return item.result;
    });
  }

  async function ensureBscChain() {
    if (chainIdVerified) return;
    const chainId = await call("eth_chainId", []);
    if (typeof chainId !== "string" || !/^0x[0-9a-fA-F]+$/.test(chainId) || BigInt(chainId) !== 56n) {
      throw new Error("NodeReal RPC endpoint is not BNB Smart Chain mainnet");
    }
    chainIdVerified = true;
  }

  return Object.freeze({
    async getFinalizedBlockNumber() {
      await ensureBscChain();
      const block = validateBlock(
        await call("eth_getBlockByNumber", ["finalized", false]),
        "finalized"
      );
      return block.number;
    },

    async getBlockHashes(blockNumbers) {
      if (!Array.isArray(blockNumbers) || blockNumbers.length < 1 ||
          blockNumbers.length > maxHashLookups) {
        throw new TypeError("Block-hash request exceeds configured bound");
      }
      const normalized = blockNumbers.map(value => toQuantity(value, "block number"));
      if (new Set(normalized.map(String)).size !== normalized.length) {
        throw new TypeError("Duplicate block number in hash request");
      }
      await ensureBscChain();
      const blocks = await batch(normalized.map(number => ({
        method: "eth_getBlockByNumber",
        params: [rpcHex(number), false]
      })));
      const result = {};
      for (let i = 0; i < normalized.length; i++) {
        const block = validateBlock(blocks[i], "canonical");
        if (BigInt(block.number) !== normalized[i]) {
          throw new Error("NodeReal returned a block number that does not match the request");
        }
        result[normalized[i].toString()] = block.hash;
      }
      return result;
    },

    async getLogs(fromBlock, toBlock) {
      const from = toQuantity(fromBlock, "fromBlock");
      const to = toQuantity(toBlock, "toBlock");
      if (to < from || to - from + 1n > BigInt(maxBlockSpan)) {
        throw new TypeError("eth_getLogs range exceeds configured block bound");
      }
      await ensureBscChain();
      const logs = await call("eth_getLogs", [{
        address: FOURMEME_TOKEN_MANAGER2_BSC,
        fromBlock: rpcHex(from),
        toBlock: rpcHex(to),
        topics: [FOURMEME_EVENT_TOPICS]
      }]);
      if (!Array.isArray(logs)) throw new TypeError("eth_getLogs did not return an array");
      if (logs.length > 500) {
        throw new Error("eth_getLogs response exceeds 500 logs; cursor must not advance");
      }
      return logs;
    }
  });
}
