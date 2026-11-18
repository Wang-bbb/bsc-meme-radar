import test from "node:test";
import assert from "node:assert/strict";
import { BSC_V2_SWAP_TOPIC0 } from "../wallet-observation.js";
import { collectBscV2WalletObservations } from "../wallet-observation-collector.js";

const pool = {
  address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  token0: "0x1111111111111111111111111111111111111111",
  token1: "0x2222222222222222222222222222222222222222",
  targetToken: "0x1111111111111111111111111111111111111111",
  quoteToken: "0x2222222222222222222222222222222222222222"
};
const initiator = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const sender = "0xcccccccccccccccccccccccccccccccccccccccc";
const recipient = "0xdddddddddddddddddddddddddddddddddddddddd";
const topic = address => "0x" + address.slice(2).padStart(64, "0");
const word = value => BigInt(value).toString(16).padStart(64, "0");
const hash = "0x" + "e".repeat(64);
const makeLog = () => ({
  address: pool.address,
  topics: [BSC_V2_SWAP_TOPIC0, topic(sender), topic(recipient)],
  data: "0x" + [0, 5n, 100n, 0].map(word).join(""),
  transactionHash: hash,
  logIndex: "0x2",
  blockNumber: "0x100"
});
function memoryKv() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; },
    async put(key, value) { values.set(key, value); }
  };
}

test("collects only a bounded V2 pool slice and persists observation plus cursor", async () => {
  const kv = memoryKv();
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_getLogs") return [makeLog()];
    if (method === "eth_getTransactionByHash") return { from: initiator };
    throw new Error("unexpected method");
  };
  const result = await collectBscV2WalletObservations({ rpc, kv, pools: [pool], latestBlock: 1000 });
  assert.equal(result.status, "ok");
  assert.equal(result.savedObservations, 1);
  assert.equal(result.pools[0].fromBlock, 991);
  assert.equal(result.pools[0].toBlock, 1000);
  assert.ok([...kv.values.keys()].some(key => key.includes(":cursor:")));
  assert.ok([...kv.values.keys()].some(key => key.includes(hash)));
  assert.equal(calls.filter(call => call.method === "eth_getLogs").length, 1);
  assert.equal(calls.filter(call => call.method === "eth_getTransactionByHash").length, 1);
});

test("does not advance cursor when transaction attribution is unavailable", async () => {
  const kv = memoryKv();
  const rpc = async method => {
    if (method === "eth_getLogs") return [makeLog()];
    if (method === "eth_getTransactionByHash") return null;
    throw new Error("unexpected method");
  };
  const result = await collectBscV2WalletObservations({ rpc, kv, pools: [pool], latestBlock: 1000 });
  assert.equal(result.status, "partial");
  assert.equal(kv.values.has("wallet-observation:v1:bsc:cursor:" + pool.address), false);
});

test("does not advance cursor when event volume exceeds the safety cap", async () => {
  const kv = memoryKv();
  const rpc = async method => method === "eth_getLogs"
    ? Array.from({ length: 26 }, makeLog)
    : { from: initiator };
  const result = await collectBscV2WalletObservations({ rpc, kv, pools: [pool], latestBlock: 1000 });
  assert.equal(result.status, "partial");
  assert.equal(result.pools[0].status, "backlog_overflow");
  assert.equal(kv.values.has("wallet-observation:v1:bsc:cursor:" + pool.address), false);
});

test("deduplicates identical transaction/log events by deterministic KV key", async () => {
  const kv = memoryKv();
  const rpc = async method => method === "eth_getLogs"
    ? [makeLog(), makeLog()]
    : { from: initiator };
  const result = await collectBscV2WalletObservations({ rpc, kv, pools: [pool], latestBlock: 1000 });
  assert.equal(result.savedObservations, 1);
  const observationKeys = [...kv.values.keys()].filter(key => key.includes(hash));
  assert.equal(observationKeys.length, 1);
});

test("rejects missing dependencies and caps work to three pools and ten blocks", async () => {
  const missing = await collectBscV2WalletObservations({ pools: [pool], latestBlock: 1000 });
  assert.equal(missing.status, "not_configured");
  const kv = memoryKv();
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    return method === "eth_getLogs" ? [] : { from: initiator };
  };
  const result = await collectBscV2WalletObservations({
    rpc, kv, pools: [pool, pool, pool, pool], latestBlock: 1000, maxPools: 99, maxBlocks: 99
  });
  assert.equal(result.status, "partial");
  assert.equal(result.processedPools, 3);
  assert.equal(result.skippedPools, 1);
  for (const call of calls.filter(x => x.method === "eth_getLogs")) {
    const from = Number.parseInt(call.params[0].fromBlock, 16);
    const to = Number.parseInt(call.params[0].toBlock, 16);
    assert.ok(to - from + 1 <= 10);
  }
});
