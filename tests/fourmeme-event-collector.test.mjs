import test from "node:test";
import assert from "node:assert/strict";
import {
  collectFourMemeFinalizedLogs,
  FOURMEME_COLLECTOR_STATE_KEY,
  FOURMEME_COLLECTOR_BLOCK_PREFIX
} from "../fourmeme-event-collector.js";
import { FOURMEME_TOKEN_MANAGER2_BSC } from "../fourmeme-event-shadow.js";

const token = "0x1111111111111111111111111111111111111111";
const tradeStopTopic = "0x8f9ab4bd7eff0d085f91575d50cd83f97aa5258e24ded7630d4fd6739e857132";
const hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const addressWord = address => address.slice(2).toLowerCase().padStart(64, "0");

class MemoryKV {
  constructor() { this.data = new Map(); this.failKey = null; this.writeCount = 0; }
  async get(key) { return this.data.has(key) ? this.data.get(key) : null; }
  async put(key, value) {
    if (this.failKey === key) throw new Error("simulated KV write failure");
    this.writeCount++;
    this.data.set(key, value);
  }
}
function makeLog(blockNumber, blockHash, index = 0, tx = 1) {
  return {
    address: FOURMEME_TOKEN_MANAGER2_BSC,
    topics: [tradeStopTopic],
    data: "0x" + addressWord(token),
    blockNumber: "0x" + BigInt(blockNumber).toString(16),
    blockHash,
    transactionHash: hash(tx),
    logIndex: "0x" + BigInt(index).toString(16)
  };
}
function providers(kv, canonical, logs, finalized = 4) {
  return {
    kv,
    startBlock: 1,
    getFinalizedBlockNumber: async () => finalized,
    getBlockHashes: async blockNumbers => {
      const result = {};
      for (const value of blockNumbers) {
        const n = BigInt(value);
        result[n.toString()] = canonical.get(n.toString());
      }
      return result;
    },
    getLogs: async () => logs
  };
}
function canonicalBlocks(from = 1, to = 4) {
  const map = new Map();
  for (let n = from; n <= to; n++) map.set(String(n), hash(n));
  return map;
}

test("collects only finalized bounded ranges and stores replaceable per-block records", async () => {
  const kv = new MemoryKV();
  const canonical = canonicalBlocks();
  const result = await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, [makeLog(2, hash(2))]),
    maxBlocksPerRun: 4,
    now: () => "2026-11-18T00:00:00.000Z"
  });
  assert.equal(result.status, "ok");
  assert.equal(result.fromBlock, "1");
  assert.equal(result.toBlock, "4");
  assert.equal(result.storedEvents, 1);
  const state = JSON.parse(await kv.get(FOURMEME_COLLECTOR_STATE_KEY));
  assert.equal(state.cursorBlock, "4");
  assert.equal(state.checkpoints.length, 3);
  const chunk = JSON.parse(await kv.get(FOURMEME_COLLECTOR_BLOCK_PREFIX + "1"));
  const block2 = chunk.blocks.find(item => item.blockNumber === "2");
  const block3 = chunk.blocks.find(item => item.blockNumber === "3");
  assert.equal(block2.events[0].eventName, "TradeStop");
  assert.deepEqual(block3.events, []);
  assert.equal(kv.writeCount, 2, "one chunk write plus one cursor write");
});

test("batches writes and preserves committed prefix when a chunk continues", async () => {
  const kv = new MemoryKV();
  const canonical = canonicalBlocks(1, 8);
  await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, [makeLog(2, hash(2))], 4),
    maxBlocksPerRun: 4
  });
  const firstWriteCount = kv.writeCount;
  const next = await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, [makeLog(6, hash(6), 0, 6)], 8),
    maxBlocksPerRun: 4
  });
  assert.equal(next.fromBlock, "5");
  assert.equal(next.toBlock, "8");
  const chunk = JSON.parse(await kv.get(FOURMEME_COLLECTOR_BLOCK_PREFIX + "1"));
  const block2 = chunk.blocks.find(item => item.blockNumber === "2");
  const block6 = chunk.blocks.find(item => item.blockNumber === "6");
  assert.equal(block2.events[0].transactionHash, hash(1));
  assert.equal(block6.events[0].transactionHash, hash(6));
  assert.equal(kv.writeCount - firstWriteCount, 2,
    "continuing within the same chunk uses one chunk write and one cursor write");
});

test("uses sparse block-hash reads instead of fetching every block header", async () => {
  const kv = new MemoryKV();
  const canonical = canonicalBlocks(1, 1000);
  let requested = [];
  const result = await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, [makeLog(333, hash(333))], 1000),
    maxBlocksPerRun: 1000,
    getBlockHashes: async blockNumbers => {
      requested = blockNumbers;
      const response = {};
      for (const value of blockNumbers) response[String(value)] = canonical.get(String(value));
      return response;
    }
  });
  assert.equal(result.processedBlocks, 1000);
  assert.ok(requested.length < 20, `expected sparse hash requests, got ${requested.length}`);
  assert.ok(requested.includes("333"), "event-bearing block hash must be independently checked");
});

test("fails closed when event-heavy blocks exceed the RPC hash lookup budget", async () => {
  const kv = new MemoryKV();
  const canonical = canonicalBlocks(1, 1000);
  const logs = Array.from({ length: 65 }, (_, index) => {
    const block = index + 1;
    return makeLog(block, hash(block), 0, block);
  });
  let hashCalls = 0;
  await assert.rejects(
    collectFourMemeFinalizedLogs({
      ...providers(kv, canonical, logs, 1000),
      maxBlocksPerRun: 1000,
      maxHashLookupsPerRun: 64,
      getBlockHashes: async numbers => {
        hashCalls++;
        const response = {};
        for (const value of numbers) response[String(value)] = canonical.get(String(value));
        return response;
      }
    }),
    /lookup budget exceeded/
  );
  assert.equal(hashCalls, 0, "over-budget request must stop before spending RPC units");
  assert.equal(await kv.get(FOURMEME_COLLECTOR_STATE_KEY), null);
});

test("limits each invocation to maxBlocksPerRun", async () => {
  const kv = new MemoryKV();
  const canonical = canonicalBlocks(1, 10);
  const result = await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, [], 10),
    maxBlocksPerRun: 2
  });
  assert.equal(result.fromBlock, "1");
  assert.equal(result.toBlock, "2");
  assert.equal(result.processedBlocks, 2);
});

test("detects a shallow reorg and replaces orphaned block observations", async () => {
  const kv = new MemoryKV();
  const canonical = canonicalBlocks();
  await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, [makeLog(3, hash(3), 0, 3)]),
    maxBlocksPerRun: 4
  });
  canonical.set("3", hash(303));
  canonical.set("4", hash(404));
  const replacement = makeLog(3, hash(303), 0, 303);
  const result = await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, [replacement]),
    maxBlocksPerRun: 4
  });
  assert.equal(result.reorgDetected, true);
  assert.equal(result.fromBlock, "3");
  assert.equal(result.toBlock, "4");
  const chunk = JSON.parse(await kv.get(FOURMEME_COLLECTOR_BLOCK_PREFIX + "1"));
  const block3 = chunk.blocks.find(item => item.blockNumber === "3");
  const block4 = chunk.blocks.find(item => item.blockNumber === "4");
  assert.equal(block3.blockHash, hash(303));
  assert.equal(block3.events[0].transactionHash, hash(303));
  assert.equal(block4.blockHash, hash(404));
  assert.deepEqual(block4.events, []);
});

test("halts when a reorg reaches beyond the retained checkpoint window", async () => {
  const kv = new MemoryKV();
  const canonical = canonicalBlocks();
  await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, []),
    maxBlocksPerRun: 4
  });
  canonical.set("1", hash(101));
  const before = await kv.get(FOURMEME_COLLECTOR_STATE_KEY);
  await assert.rejects(
    collectFourMemeFinalizedLogs({ ...providers(kv, canonical, []), maxBlocksPerRun: 4 }),
    /exceeds retained checkpoint window/
  );
  assert.equal(await kv.get(FOURMEME_COLLECTOR_STATE_KEY), before);
});

test("does not advance cursor if a block record write fails", async () => {
  const kv = new MemoryKV();
  kv.failKey = FOURMEME_COLLECTOR_BLOCK_PREFIX + "1";
  await assert.rejects(
    collectFourMemeFinalizedLogs({
      ...providers(kv, canonicalBlocks(), [makeLog(1, hash(1))]),
      maxBlocksPerRun: 4
    }),
    /simulated KV write failure/
  );
  assert.equal(await kv.get(FOURMEME_COLLECTOR_STATE_KEY), null);
});

test("rejects oversized log batches and block-hash mismatches without advancing cursor", async () => {
  const kv = new MemoryKV();
  await assert.rejects(
    collectFourMemeFinalizedLogs({
      ...providers(kv, canonicalBlocks(), [makeLog(1, hash(1)), makeLog(2, hash(2), 1, 2)]),
      maxBlocksPerRun: 4,
      maxLogsPerRun: 1
    }),
    /exceeds maxLogsPerRun/
  );
  assert.equal(await kv.get(FOURMEME_COLLECTOR_STATE_KEY), null);

  await assert.rejects(
    collectFourMemeFinalizedLogs({
      ...providers(kv, canonicalBlocks(), [makeLog(1, hash(999))]),
      maxBlocksPerRun: 4
    }),
    /does not match the canonical block hash/
  );
  assert.equal(await kv.get(FOURMEME_COLLECTOR_STATE_KEY), null);
});

test("rejects logs outside the requested finalized range", async () => {
  const kv = new MemoryKV();
  await assert.rejects(
    collectFourMemeFinalizedLogs({
      ...providers(kv, canonicalBlocks(1, 5), [makeLog(5, hash(5))], 4),
      maxBlocksPerRun: 4
    }),
    /outside the requested block range/
  );
  assert.equal(await kv.get(FOURMEME_COLLECTOR_STATE_KEY), null);
});

test("returns idle without RPC log scans when cursor is already finalized", async () => {
  const kv = new MemoryKV();
  const canonical = canonicalBlocks();
  await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, []),
    maxBlocksPerRun: 4
  });
  let calls = 0;
  const result = await collectFourMemeFinalizedLogs({
    ...providers(kv, canonical, []),
    maxBlocksPerRun: 4,
    getLogs: async () => { calls++; return []; }
  });
  assert.equal(result.status, "idle");
  assert.equal(calls, 0);
});
