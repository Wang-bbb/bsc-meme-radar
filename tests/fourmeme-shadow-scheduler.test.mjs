import test from "node:test";
import assert from "node:assert/strict";
import {
  readFourMemeShadowStatus,
  runFourMemeShadowSchedule
} from "../fourmeme-shadow-scheduler.js";

const STATUS_KEY = "fourmeme:v2:collector:status";
const START_BLOCK_KEY = "fourmeme:v2:collector:start-block";

class MemoryKV {
  constructor() { this.data = new Map(); this.readCount = 0; }
  async get(key) { this.readCount++; return this.data.has(key) ? this.data.get(key) : null; }
  async put(key, value) { this.data.set(key, value); }
}

test("scheduled observer is disabled by default and does not create an RPC adapter", async () => {
  const kv = new MemoryKV();
  let adapterCreated = false;
  const result = await runFourMemeShadowSchedule({
    RADAR_KV: kv,
    NODEREAL_RPC_URL: "https://example.invalid/secret"
  }, {
    createAdapter() { adapterCreated = true; throw new Error("must not run"); },
    now: () => "2026-11-19T00:00:00.000Z"
  });
  assert.equal(result.status, "disabled");
  assert.equal(adapterCreated, false);
  assert.equal(await kv.get(STATUS_KEY), null, "disabled runs must not consume KV writes");
});

test("enabled observer reports missing bindings without calling the provider", async () => {
  let adapterCreated = false;
  const result = await runFourMemeShadowSchedule({
    FOURMEME_SHADOW_ENABLED: "true",
    NODEREAL_RPC_URL: "https://example.invalid/secret"
  }, {
    createAdapter() { adapterCreated = true; throw new Error("must not run"); }
  });
  assert.equal(result.status, "not_configured");
  assert.deepEqual(result.missing, ["RADAR_KV"]);
  assert.equal(adapterCreated, false);
});

test("first enabled run anchors at finalized height and uses bounded collection settings", async () => {
  const kv = new MemoryKV();
  let adapterOptions;
  let collectOptions;
  const result = await runFourMemeShadowSchedule({
    FOURMEME_SHADOW_ENABLED: "true",
    NODEREAL_RPC_URL: "https://example.invalid/secret",
    RADAR_KV: kv
  }, {
    createAdapter(options) {
      adapterOptions = options;
      return {
        getFinalizedBlockNumber: async () => "123456",
        getBlockHashes: async () => ({}),
        getLogs: async () => []
      };
    },
    async collect(options) {
      collectOptions = options;
      return { status: "ok", fromBlock: "123456", toBlock: "123456", processedBlocks: 1 };
    },
    now: () => "2026-11-19T00:00:00.000Z"
  });
  assert.equal(result.status, "ok");
  assert.equal(adapterOptions.timeoutMs, 12000);
  assert.equal(adapterOptions.maxHashLookups, 32);
  assert.equal(adapterOptions.maxBlockSpan, 250);
  assert.equal(collectOptions.startBlock, "123456");
  assert.equal(collectOptions.maxBlocksPerRun, 250);
  assert.equal(collectOptions.maxLogsPerRun, 25);
  assert.equal(collectOptions.blocksPerKvChunk, 250);
  assert.equal(await kv.get(START_BLOCK_KEY), "123456");
  assert.equal(JSON.parse(await kv.get(STATUS_KEY)).status, "ok");
});

test("observer retries smaller ranges when a log batch exceeds its bound", async () => {
  const kv = new MemoryKV();
  const attempted = [];
  const result = await runFourMemeShadowSchedule({
    FOURMEME_SHADOW_ENABLED: "true",
    NODEREAL_RPC_URL: "https://example.invalid/secret",
    RADAR_KV: kv
  }, {
    createAdapter() {
      return {
        getFinalizedBlockNumber: async () => "500",
        getBlockHashes: async () => ({}),
        getLogs: async () => []
      };
    },
    async collect(options) {
      attempted.push(options.maxBlocksPerRun);
      if (options.maxBlocksPerRun > 6) throw new Error("Four.meme log batch exceeds maxLogsPerRun");
      return { status: "ok", processedBlocks: options.maxBlocksPerRun };
    }
  });
  assert.deepEqual(attempted, [250, 125, 62, 31, 15, 7, 3]);
  assert.equal(result.status, "ok");
  assert.equal(result.maxBlocksPerRun, 3);
});

test("provider errors are recorded without exposing the RPC endpoint", async () => {
  const kv = new MemoryKV();
  const secret = "https://example.invalid/sensitive-api-key";
  const result = await runFourMemeShadowSchedule({
    FOURMEME_SHADOW_ENABLED: "true",
    NODEREAL_RPC_URL: secret,
    RADAR_KV: kv
  }, {
    createAdapter() {
      throw new Error("NodeReal RPC transport failed; endpoint details are intentionally hidden");
    }
  });
  assert.equal(result.status, "error");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(await readFourMemeShadowStatus(kv, true)).includes(secret), false);
});

test("enabled status marks old successful records stale after three cron intervals", async () => {
  const kv = new MemoryKV();
  const updatedAt = "2026-11-19T00:00:00.000Z";
  kv.data.set(STATUS_KEY, JSON.stringify({
    status: "ok",
    enabled: true,
    updatedAt
  }));
  const status = await readFourMemeShadowStatus(kv, true, Date.parse("2026-11-19T00:31:00.000Z"));
  assert.equal(status.status, "stale");
  assert.equal(status.lastRunAt, updatedAt);
  assert.equal(status.lastStatus.status, "ok");
  assert.equal(status.staleAfterSeconds, 1800);
});

test("enabled status includes age for a fresh persisted record", async () => {
  const kv = new MemoryKV();
  kv.data.set(STATUS_KEY, JSON.stringify({
    status: "ok",
    enabled: true,
    updatedAt: "2026-11-19T00:00:00.000Z"
  }));
  const status = await readFourMemeShadowStatus(kv, true, Date.parse("2026-11-19T00:10:00.000Z"));
  assert.equal(status.status, "ok");
  assert.equal(status.statusAgeSeconds, 600);
});

test("enabled status rejects invalid or future timestamps", async () => {
  const kv = new MemoryKV();
  kv.data.set(STATUS_KEY, JSON.stringify({
    status: "ok",
    enabled: true,
    updatedAt: "not-a-date"
  }));
  assert.equal((await readFourMemeShadowStatus(kv, true, Date.parse("2026-11-19T00:10:00.000Z"))).status, "status_corrupt");
  kv.data.set(STATUS_KEY, JSON.stringify({
    status: "ok",
    enabled: true,
    updatedAt: "2026-11-19T01:00:00.000Z"
  }));
  assert.equal((await readFourMemeShadowStatus(kv, true, Date.parse("2026-11-19T00:10:00.000Z"))).status, "status_corrupt");
});

test("enabled status reports corrupt persisted JSON instead of claiming not_started", async () => {
  const kv = new MemoryKV();
  kv.data.set(STATUS_KEY, "{invalid-json");
  const status = await readFourMemeShadowStatus(kv, true);
  assert.deepEqual(status, { enabled: true, status: "status_corrupt" });
});

test("enabled status rejects structurally invalid persisted records", async () => {
  const kv = new MemoryKV();
  kv.data.set(STATUS_KEY, JSON.stringify({ enabled: true, updatedAt: "2026-11-19T00:00:00.000Z" }));
  const status = await readFourMemeShadowStatus(kv, true);
  assert.deepEqual(status, { enabled: true, status: "status_corrupt" });
});

test("disabled status endpoint does not read KV or expose stale run state", async () => {
  const kv = new MemoryKV();
  await kv.put(STATUS_KEY, JSON.stringify({
    status: "ok",
    enabled: true,
    updatedAt: "2026-11-18T00:00:00.000Z"
  }));
  kv.readCount = 0;
  const status = await readFourMemeShadowStatus(kv, false);
  assert.equal(status.enabled, false);
  assert.equal(status.status, "disabled");
  assert.equal(status.lastRunAt, null);
  assert.equal(kv.readCount, 0);
});
