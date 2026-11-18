import { decodeFourMemeRawLog } from "./fourmeme-event-shadow.js";

const STATE_KEY = "fourmeme:v2:collector:state";
const BLOCK_KEY_PREFIX = "fourmeme:v2:collector:block:";
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function quantity(value, field) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${field}`);
    return BigInt(value);
  }
  if (typeof value !== "string") throw new TypeError(`Invalid ${field}`);
  if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (/^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError(`Invalid ${field}`);
}

function hashAt(result, blockNumber) {
  const key = blockNumber.toString();
  const value = result instanceof Map ? result.get(key) : result?.[key];
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new TypeError(`Missing or invalid block hash for ${key}`);
  }
  return value.toLowerCase();
}

async function readJson(kv, key) {
  const raw = await kv.get(key);
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new TypeError(`Corrupt collector state at ${key}`);
  }
}

/**
 * Bounded, read-only Four.meme V2 log collector.
 *
 * Dependencies are injected so this module never chooses an RPC provider or
 * decides how the chain's finalized height is established. getBlockHashes must
 * return canonical hashes for every requested block (prefer a JSON-RPC batch).
 * getFinalizedBlockNumber must return a genuinely finalized/safe height, not
 * the unstable latest tip.
 *
 * Each block is stored as one replaceable KV record. Cursor state is written
 * last, so a partial KV failure causes safe replay rather than cursor loss.
 * A rolling per-block hash window detects reorgs; if the fork reaches beyond
 * the retained window, collection stops for operator review.
 */
export async function collectFourMemeFinalizedLogs({
  kv,
  getFinalizedBlockNumber,
  getBlockHashes,
  getLogs,
  startBlock,
  maxBlocksPerRun = 100,
  maxLogsPerRun = 500,
  checkpointWindow = 128,
  eventTtlSeconds = 30 * 24 * 60 * 60,
  now = () => new Date().toISOString()
}) {
  if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function") {
    throw new TypeError("KV get/put binding is required");
  }
  if (typeof getFinalizedBlockNumber !== "function" ||
      typeof getBlockHashes !== "function" || typeof getLogs !== "function") {
    throw new TypeError("Finalized-height, block-hash and log providers are required");
  }
  if (!Number.isSafeInteger(maxBlocksPerRun) || maxBlocksPerRun < 1 || maxBlocksPerRun > 1000 ||
      !Number.isSafeInteger(maxLogsPerRun) || maxLogsPerRun < 1 ||
      !Number.isSafeInteger(checkpointWindow) || checkpointWindow < 2) {
    throw new TypeError("Invalid collector bounds");
  }

  const configuredStart = quantity(startBlock, "startBlock");
  const state = await readJson(kv, STATE_KEY);
  let cursor = configuredStart - 1n;
  let checkpoints = [];
  let reorgDetected = false;

  if (state) {
    if (state.version !== 1 || !Array.isArray(state.checkpoints)) {
      throw new TypeError("Unsupported or corrupt collector state");
    }
    cursor = quantity(state.cursorBlock, "cursorBlock");
    checkpoints = state.checkpoints.map(item => ({
      blockNumber: quantity(item.blockNumber, "checkpoint blockNumber"),
      blockHash: String(item.blockHash || "").toLowerCase()
    }));
    if (checkpoints.some(item => !HASH_RE.test(item.blockHash)) ||
        checkpoints.some((item, index) => index > 0 &&
          item.blockNumber !== checkpoints[index - 1].blockNumber + 1n) ||
        (checkpoints.length && checkpoints[checkpoints.length - 1].blockNumber !== cursor)) {
      throw new TypeError("Collector checkpoint history is invalid");
    }
    if (!checkpoints.length && cursor >= configuredStart) {
      throw new TypeError("Collector state has no reorg checkpoints");
    }
  }

  const finalizedHeight = quantity(await getFinalizedBlockNumber(), "finalized block number");
  if (finalizedHeight < cursor) throw new Error("Finalized height regressed below the saved cursor");

  if (checkpoints.length) {
    const canonical = await getBlockHashes(
      checkpoints[0].blockNumber.toString(),
      checkpoints[checkpoints.length - 1].blockNumber.toString()
    );
    let firstMismatch = -1;
    for (let i = 0; i < checkpoints.length; i++) {
      const checkpoint = checkpoints[i];
      if (hashAt(canonical, checkpoint.blockNumber) !== checkpoint.blockHash) {
        firstMismatch = i;
        break;
      }
    }
    if (firstMismatch === 0) {
      throw new Error("Reorg exceeds retained checkpoint window; collector halted for manual recovery");
    }
    if (firstMismatch > 0) {
      cursor = checkpoints[firstMismatch - 1].blockNumber;
      checkpoints = checkpoints.slice(0, firstMismatch);
      reorgDetected = true;
    }
  }

  const fromBlock = cursor + 1n;
  const maxEnd = fromBlock + BigInt(maxBlocksPerRun) - 1n;
  const toBlock = finalizedHeight < maxEnd ? finalizedHeight : maxEnd;
  if (toBlock < fromBlock) {
    return {
      status: "idle",
      cursorBlock: cursor.toString(),
      finalizedBlock: finalizedHeight.toString(),
      reorgDetected
    };
  }

  const canonicalHashes = await getBlockHashes(fromBlock.toString(), toBlock.toString());
  const blockHashes = new Map();
  for (let block = fromBlock; block <= toBlock; block++) {
    blockHashes.set(block.toString(), hashAt(canonicalHashes, block));
  }

  const rawLogs = await getLogs(fromBlock.toString(), toBlock.toString());
  if (!Array.isArray(rawLogs)) throw new TypeError("getLogs must return an array");
  if (rawLogs.length > maxLogsPerRun) {
    throw new Error("Four.meme log batch exceeds maxLogsPerRun; cursor was not advanced");
  }

  const grouped = new Map();
  const seen = new Set();
  const orderedLogs = rawLogs.slice().sort((a, b) => {
    const blockA = quantity(a?.blockNumber, "log blockNumber");
    const blockB = quantity(b?.blockNumber, "log blockNumber");
    if (blockA !== blockB) return blockA < blockB ? -1 : 1;
    const indexA = quantity(a?.logIndex, "logIndex");
    const indexB = quantity(b?.logIndex, "logIndex");
    return indexA === indexB ? 0 : indexA < indexB ? -1 : 1;
  });

  let storedEventCount = 0;
  for (const log of orderedLogs) {
    const blockNumber = quantity(log?.blockNumber, "log blockNumber");
    if (blockNumber < fromBlock || blockNumber > toBlock) {
      throw new Error("RPC returned a log outside the requested block range");
    }
    const expectedHash = blockHashes.get(blockNumber.toString());
    if (!expectedHash || String(log.blockHash || "").toLowerCase() !== expectedHash) {
      throw new Error("RPC log block hash does not match the canonical block hash");
    }
    const event = decodeFourMemeRawLog(log, {
      finalityStatus: "finalized",
      transactionFrom: log.transactionFrom
    });
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    if (!grouped.has(blockNumber.toString())) grouped.set(blockNumber.toString(), []);
    grouped.get(blockNumber.toString()).push(event);
    storedEventCount++;
  }

  // Replace every block record in the replay range, including empty blocks.
  // This clears stale events from a replaced fork without needing KV list/delete.
  for (let block = fromBlock; block <= toBlock; block++) {
    const key = BLOCK_KEY_PREFIX + block.toString();
    const record = {
      version: 1,
      blockNumber: block.toString(),
      blockHash: blockHashes.get(block.toString()),
      events: grouped.get(block.toString()) || []
    };
    await kv.put(key, JSON.stringify(record), { expirationTtl: eventTtlSeconds });
  }

  const nextCheckpoints = [
    ...checkpoints,
    ...[...blockHashes.entries()].map(([blockNumber, blockHash]) => ({
      blockNumber: BigInt(blockNumber),
      blockHash
    }))
  ].slice(-checkpointWindow).map(item => ({
    blockNumber: item.blockNumber.toString(),
    blockHash: item.blockHash
  }));

  const nextState = {
    version: 1,
    cursorBlock: toBlock.toString(),
    checkpoints: nextCheckpoints,
    updatedAt: now()
  };
  // Cursor is deliberately the final write. Any prior failure is replayable.
  await kv.put(STATE_KEY, JSON.stringify(nextState));

  return {
    status: "ok",
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    cursorBlock: toBlock.toString(),
    processedBlocks: Number(toBlock - fromBlock + 1n),
    receivedLogs: rawLogs.length,
    storedEvents: storedEventCount,
    reorgDetected
  };
}

export const FOURMEME_COLLECTOR_STATE_KEY = STATE_KEY;
export const FOURMEME_COLLECTOR_BLOCK_PREFIX = BLOCK_KEY_PREFIX;
