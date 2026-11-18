import { collectFourMemeFinalizedLogs } from "./fourmeme-event-collector.js";
import { createNodeRealFourMemeRpcAdapter } from "./fourmeme-nodereal-adapter.js";

const STATUS_KEY = "fourmeme:v2:collector:status";
const START_BLOCK_KEY = "fourmeme:v2:collector:start-block";
const STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;
const START_BLOCK_TTL_SECONDS = 365 * 24 * 60 * 60;
const BLOCK_RETRY_STEPS = [250, 125, 62, 31, 15, 7, 3, 1];

function parseStored(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function writeStatus(kv, value) {
  if (!kv || typeof kv.put !== "function") return;
  try {
    await kv.put(STATUS_KEY, JSON.stringify(value), { expirationTtl: STATUS_TTL_SECONDS });
  } catch {
    // Status persistence must never cause the finalized collector cursor to advance.
  }
}

export async function readFourMemeShadowStatus(kv, enabled) {
  const active = enabled === true;
  let lastStatus = null;
  try {
    if (kv && typeof kv.get === "function") {
      lastStatus = parseStored(await kv.get(STATUS_KEY));
    }
  } catch {
    return { enabled: active, status: "status_unavailable" };
  }
  if (!active) {
    return {
      enabled: false,
      status: "disabled",
      lastRunAt: lastStatus?.updatedAt || null
    };
  }
  if (!kv || typeof kv.get !== "function") {
    return { enabled: true, status: "not_configured", reason: "RADAR_KV binding missing" };
  }
  return lastStatus
    ? { enabled: true, ...lastStatus }
    : { enabled: true, status: "not_started" };
}

/**
 * Runs one bounded, finalized-only observation pass.
 * The feature flag is opt-in; missing config and provider errors fail closed.
 * On the first enabled run, the anchor is the current finalized height, so
 * historical backfill is intentionally not attempted.
 */
export async function runFourMemeShadowSchedule(env, dependencies = {}) {
  const kv = env?.RADAR_KV;
  const enabled = String(env?.FOURMEME_SHADOW_ENABLED || "").toLowerCase() === "true";
  const now = dependencies.now || (() => new Date().toISOString());
  const createAdapter = dependencies.createAdapter || createNodeRealFourMemeRpcAdapter;
  const collect = dependencies.collect || collectFourMemeFinalizedLogs;

  if (!enabled) {
    const result = { status: "disabled", enabled: false, updatedAt: now() };
    await writeStatus(kv, result);
    return result;
  }
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function" ||
      !env?.NODEREAL_RPC_URL) {
    const result = {
      status: "not_configured",
      enabled: true,
      missing: [
        ...(!kv ? ["RADAR_KV"] : []),
        ...(!env?.NODEREAL_RPC_URL ? ["NODEREAL_RPC_URL"] : [])
      ],
      updatedAt: now()
    };
    await writeStatus(kv, result);
    return result;
  }

  try {
    const adapter = createAdapter({
      endpoint: env.NODEREAL_RPC_URL,
      timeoutMs: 12000,
      maxHashLookups: 32,
      maxBlockSpan: 250
    });
    const finalizedHeight = String(await adapter.getFinalizedBlockNumber());
    let startBlock = await kv.get(START_BLOCK_KEY);
    if (startBlock == null) {
      startBlock = finalizedHeight;
      await kv.put(START_BLOCK_KEY, String(startBlock), {
        expirationTtl: START_BLOCK_TTL_SECONDS
      });
    }
    if (!/^(0|[1-9][0-9]*)$/.test(String(startBlock))) {
      throw new Error("Invalid persisted Four.meme start block");
    }

    let lastError = null;
    for (const maxBlocksPerRun of BLOCK_RETRY_STEPS) {
      try {
        const collection = await collect({
          kv,
          getFinalizedBlockNumber: async () => finalizedHeight,
          getBlockHashes: adapter.getBlockHashes,
          getLogs: adapter.getLogs,
          startBlock: String(startBlock),
          maxBlocksPerRun,
          maxLogsPerRun: 25,
          checkpointWindow: 8,
          maxHashLookupsPerRun: 32,
          maxChunkBytes: 768 * 1024,
          blocksPerKvChunk: 250,
          now
        });
        const result = {
          status: collection.status,
          enabled: true,
          updatedAt: now(),
          startBlock: String(startBlock),
          finalizedBlock: finalizedHeight,
          maxBlocksPerRun,
          collection
        };
        await writeStatus(kv, result);
        return result;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error);
        const canRetrySmaller =
          /exceeds maxLogsPerRun|Canonical block-hash lookup budget exceeded|maxChunkBytes/.test(message);
        if (!canRetrySmaller || maxBlocksPerRun === 1) break;
      }
    }

    const result = {
      status: "error",
      enabled: true,
      updatedAt: now(),
      startBlock: String(startBlock),
      finalizedBlock: finalizedHeight,
      error: String(lastError?.message || "Four.meme collection failed").slice(0, 200)
    };
    await writeStatus(kv, result);
    return result;
  } catch (error) {
    const result = {
      status: "error",
      enabled: true,
      updatedAt: now(),
      error: String(error?.message || "Four.meme schedule failed").slice(0, 200)
    };
    await writeStatus(kv, result);
    return result;
  }
}
