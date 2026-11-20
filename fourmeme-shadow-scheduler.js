import { collectFourMemeFinalizedLogs } from "./fourmeme-event-collector.js";
import { createNodeRealFourMemeRpcAdapter } from "./fourmeme-nodereal-adapter.js";

const STATUS_KEY = "fourmeme:v2:collector:status";
const START_BLOCK_KEY = "fourmeme:v2:collector:start-block";
const STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATUS_STALE_AFTER_MS = 30 * 60 * 1000;
const START_BLOCK_TTL_SECONDS = 365 * 24 * 60 * 60;
const BLOCK_RETRY_STEPS = [250, 125, 62, 31, 15, 7, 3, 1];

function parseStored(value) {
  if (value == null) return { valid: true, value: null };
  if (typeof value === "object") {
    return value && !Array.isArray(value) && typeof value.status === "string"
      ? { valid: true, value }
      : { valid: false, value: null };
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof parsed.status === "string"
      ? { valid: true, value: parsed }
      : { valid: false, value: null };
  } catch {
    return { valid: false, value: null };
  }
}

async function writeStatus(kv, value) {
  if (!kv || typeof kv.put !== "function") return;
  try {
    await kv.put(STATUS_KEY, JSON.stringify(value), { expirationTtl: STATUS_TTL_SECONDS });
  } catch {
    // Status persistence must never cause the finalized collector cursor to advance.
  }
}

export async function readFourMemeShadowStatus(kv, enabled, nowMs = Date.now()) {
  const active = enabled === true;
  // Disabled status checks must not touch KV; the feature's off state is
  // intentionally a zero-read, zero-write, zero-RPC path.
  if (!active) {
    return { enabled: false, status: "disabled", lastRunAt: null };
  }
  let parsedStatus = { valid: true, value: null };
  try {
    if (kv && typeof kv.get === "function") {
      parsedStatus = parseStored(await kv.get(STATUS_KEY));
    }
  } catch {
    return { enabled: true, status: "status_unavailable" };
  }
  if (!kv || typeof kv.get !== "function") {
    return { enabled: true, status: "not_configured", reason: "RADAR_KV binding missing" };
  }
  if (!parsedStatus.valid) {
    return { enabled: true, status: "status_corrupt" };
  }
  if (!parsedStatus.value) {
    return { enabled: true, status: "not_started" };
  }
  const updatedAtMs = Date.parse(parsedStatus.value.updatedAt);
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) {
    return { enabled: true, status: "status_corrupt" };
  }
  const ageMs = nowMs - updatedAtMs;
  if (ageMs < -5 * 60 * 1000) {
    return { enabled: true, status: "status_corrupt" };
  }
  if (ageMs > STATUS_STALE_AFTER_MS) {
    return {
      enabled: true,
      status: "stale",
      lastRunAt: parsedStatus.value.updatedAt,
      staleAfterSeconds: STATUS_STALE_AFTER_MS / 1000,
      lastStatus: parsedStatus.value
    };
  }
  return {
    ...parsedStatus.value,
    enabled: true,
    statusAgeSeconds: Math.max(0, Math.floor(ageMs / 1000))
  };
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
    return { status: "disabled", enabled: false, updatedAt: now() };
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

/**
 * Convert persisted scheduler outcomes into the Cron invocation outcome.
 * Disabled is an intentional no-op; only completed collection states are
 * successful. Error, missing configuration, and unknown states must reject
 * so Cloudflare's Cron telemetry cannot report a false success.
 */
export async function runFourMemeShadowScheduledInvocation(
  env,
  runSchedule = runFourMemeShadowSchedule
) {
  const result = await runSchedule(env);
  const status = typeof result?.status === "string" ? result.status : "invalid_status";
  if (!["disabled", "ok", "idle"].includes(status)) {
    throw new Error(`Four.meme scheduled observer did not complete cleanly (${status})`);
  }
  return result;
}
