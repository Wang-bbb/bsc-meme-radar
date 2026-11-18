import { BSC_V2_SWAP_TOPIC0, parseBscV2SwapObservation } from "./wallet-observation.js";

const DEFAULT_MAX_POOLS = 3;
const DEFAULT_MAX_BLOCKS = 10;
const DEFAULT_MAX_LOGS = 25;
const DEFAULT_TX_CONCURRENCY = 5;
const DEFAULT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

function asSafeBlock(value) {
  const n = typeof value === "string" && value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function toHexBlock(value) {
  return "0x" + value.toString(16);
}

function normalizeAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function observationKey(observation) {
  return [
    "wallet-observation:v1",
    observation.chain,
    observation.poolAddress,
    observation.transactionHash,
    observation.logIndex
  ].join(":");
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Collect a bounded slice of BSC V2 Swap logs for already-approved pools.
 * Dependencies are injected so the collector can be tested without network
 * access and cannot silently create a provider or paid-service dependency.
 *
 * rpc(method, params) must implement standard read-only JSON-RPC.
 * kv must implement Cloudflare KV get/put.
 */
export async function collectBscV2WalletObservations({
  rpc,
  kv,
  pools,
  latestBlock,
  maxPools = DEFAULT_MAX_POOLS,
  maxBlocks = DEFAULT_MAX_BLOCKS,
  maxLogs = DEFAULT_MAX_LOGS,
  txConcurrency = DEFAULT_TX_CONCURRENCY,
  retentionSeconds = DEFAULT_RETENTION_SECONDS
} = {}) {
  const latest = asSafeBlock(latestBlock);
  if (typeof rpc !== "function" || !kv || typeof kv.get !== "function" || typeof kv.put !== "function") {
    return { status: "not_configured", processedPools: 0, savedObservations: 0, errors: ["RPC 或 KV 未配置"] };
  }
  if (latest === null) {
    return { status: "invalid_input", processedPools: 0, savedObservations: 0, errors: ["latestBlock 无效"] };
  }
  if (!Array.isArray(pools) || pools.length === 0) {
    return { status: "no_pools", processedPools: 0, savedObservations: 0, errors: [] };
  }

  const poolLimit = Math.max(1, Math.min(DEFAULT_MAX_POOLS, Number(maxPools) || DEFAULT_MAX_POOLS));
  const blockLimit = Math.max(1, Math.min(DEFAULT_MAX_BLOCKS, Number(maxBlocks) || DEFAULT_MAX_BLOCKS));
  const logLimit = Math.max(1, Math.min(DEFAULT_MAX_LOGS, Number(maxLogs) || DEFAULT_MAX_LOGS));
  const concurrency = Math.max(1, Math.min(DEFAULT_TX_CONCURRENCY, Number(txConcurrency) || DEFAULT_TX_CONCURRENCY));
  const ttl = Math.max(60, Math.min(DEFAULT_RETENTION_SECONDS, Number(retentionSeconds) || DEFAULT_RETENTION_SECONDS));
  // Rotate through the supplied pool list so pools beyond the per-run cap
  // cannot be starved forever by a fixed first-N slice.
  const rotationKey = "wallet-observation:v1:bsc:pool-rotation";
  let rotationIndex = 0;
  try {
    const savedRotation = await kv.get(rotationKey, "json");
    const savedIndex = Number(savedRotation && savedRotation.nextIndex);
    if (Number.isSafeInteger(savedIndex) && savedIndex >= 0) rotationIndex = savedIndex % pools.length;
  } catch (_) {
    // A missing/unreadable rotation pointer safely falls back to the first pool.
  }
  const selectedPools = Array.from(
    { length: Math.min(poolLimit, pools.length) },
    (_, offset) => pools[(rotationIndex + offset) % pools.length]
  );
  const result = { status: "ok", processedPools: 0, savedObservations: 0, skippedPools: 0, errors: [], pools: [] };

  for (const pool of selectedPools) {
    const poolAddress = normalizeAddress(pool && pool.address);
    if (!/^0x[a-f0-9]{40}$/.test(poolAddress)) {
      result.skippedPools++;
      result.pools.push({ poolAddress: poolAddress || null, status: "invalid_pool_metadata" });
      continue;
    }
    const cursorKey = "wallet-observation:v1:bsc:cursor:" + poolAddress;
    try {
      const savedCursor = await kv.get(cursorKey, "json");
      const cursor = savedCursor && asSafeBlock(savedCursor.lastCompleteBlock);
      const fromBlock = cursor === null
        ? Math.max(0, latest - blockLimit + 1)
        : cursor + 1;
      if (fromBlock > latest) {
        result.processedPools++;
        result.pools.push({ poolAddress, status: "up_to_date", fromBlock, toBlock: latest });
        continue;
      }
      const toBlock = Math.min(latest, fromBlock + blockLimit - 1);
      const logs = await rpc("eth_getLogs", [{
        fromBlock: toHexBlock(fromBlock),
        toBlock: toHexBlock(toBlock),
        address: poolAddress,
        topics: [BSC_V2_SWAP_TOPIC0]
      }]);
      if (!Array.isArray(logs)) throw new Error("eth_getLogs 返回格式无效");
      if (logs.length > logLimit) {
        result.errors.push("池 " + poolAddress + " 在区块范围内事件过多，游标未推进");
        result.pools.push({ poolAddress, status: "backlog_overflow", fromBlock, toBlock, logCount: logs.length });
        result.status = "partial";
        continue;
      }

      const uniqueLogs = [...new Map(logs.map(log => [
        String(log && log.transactionHash || "").toLowerCase() + ":" + String(log && log.logIndex || "").toLowerCase(),
        log
      ])).values()];
      if (uniqueLogs.some(log =>
        !/^0x[a-f0-9]{64}$/i.test(String(log && log.transactionHash || "")) ||
        !/^0x[a-f0-9]+$/i.test(String(log && log.logIndex || ""))
      )) {
        throw new Error("Swap 日志缺少有效 transactionHash/logIndex；游标未推进");
      }
      const txHashes = [...new Set(uniqueLogs.map(log => String(log && log.transactionHash || "").toLowerCase()))];
      if (txHashes.some(hash => !/^0x[a-f0-9]{64}$/.test(hash))) {
        throw new Error("Swap 日志缺少有效 transactionHash；游标未推进");
      }
      const txEntries = await mapLimit(txHashes, concurrency, async hash => {
        const tx = await rpc("eth_getTransactionByHash", [hash]);
        if (!tx || !tx.from) throw new Error("交易 " + hash + " 尚无可用发起地址；游标未推进");
        return [hash, tx];
      });
      const txByHash = new Map(txEntries);
      let savedForPool = 0;
      for (const log of uniqueLogs) {
        const parsed = parseBscV2SwapObservation({
          log,
          transaction: txByHash.get(String(log.transactionHash).toLowerCase()),
          pool
        });
        if (parsed.status !== "observed") continue;
        const key = observationKey(parsed);
        await kv.put(key, JSON.stringify({
          ...parsed,
          observedAt: Math.floor(Date.now() / 1000),
          source: "bsc_rpc_v2_swap",
          coverage: "observed_pool_only"
        }), { expirationTtl: ttl });
        savedForPool++;
      }
      // Cursor advances only after every transaction lookup and every KV write succeeds.
      await kv.put(cursorKey, JSON.stringify({
        lastCompleteBlock: toBlock,
        updatedAt: Math.floor(Date.now() / 1000),
        coverage: "observed_pool_only"
      }), { expirationTtl: ttl });
      result.processedPools++;
      result.savedObservations += savedForPool;
      result.pools.push({ poolAddress, status: "processed", fromBlock, toBlock, logCount: uniqueLogs.length, savedObservations: savedForPool });
    } catch (error) {
      result.status = "partial";
      const message = String(error && error.message || error).slice(0, 180);
      result.errors.push("池 " + poolAddress + ": " + message);
      result.pools.push({ poolAddress, status: "error", error: message });
    }
  }

  if (pools.length > selectedPools.length) {
    result.status = "partial";
    result.skippedPools += pools.length - selectedPools.length;
    result.errors.push("本轮处理 " + selectedPools.length + " 个池；轮询游标会让剩余池在后续轮次获得机会");
  }
  try {
    await kv.put(rotationKey, JSON.stringify({
      nextIndex: (rotationIndex + selectedPools.length) % pools.length,
      updatedAt: Math.floor(Date.now() / 1000)
    }), { expirationTtl: ttl });
  } catch (error) {
    result.status = "partial";
    result.errors.push("池轮询游标保存失败: " + String(error && error.message || error).slice(0, 120));
  }
  return result;
}
