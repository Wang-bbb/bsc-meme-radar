import test from "node:test";
import assert from "node:assert/strict";
import { createNodeRealFourMemeRpcAdapter } from "../fourmeme-nodereal-adapter.js";
import { FOURMEME_TOKEN_MANAGER2_BSC } from "../fourmeme-event-shadow.js";

const hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const block = n => ({ number: "0x" + BigInt(n).toString(16), hash: hash(n) });
const SUPPORTED_TOPICS = [
  "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20",
  "0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942",
  "0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19",
  "0x8f9ab4bd7eff0d085f91575d50cd83f97aa5258e24ded7630d4fd6739e857132",
  "0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0"
];
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function rpcResult(request, result) {
  return { jsonrpc: "2.0", id: request.id, result };
}

test("reads finalized height and rejects any fallback to latest for collector finality", async () => {
  const calls = [];
  const adapter = createNodeRealFourMemeRpcAdapter({
    endpoint: "https://bsc-mainnet.nodereal.io/v1/test-key",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.method === "eth_chainId") {
        assert.deepEqual(body.params, []);
        return response(rpcResult(body, "0x38"));
      }
      assert.equal(body.method, "eth_getBlockByNumber");
      assert.deepEqual(body.params, ["finalized", false]);
      return response(rpcResult(body, block(123)));
    }
  });
  assert.equal(await adapter.getFinalizedBlockNumber(), "123");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "eth_chainId");
});

test("rejects a non-BSC RPC endpoint before reading finalized blocks", async () => {
  const methods = [];
  const adapter = createNodeRealFourMemeRpcAdapter({
    endpoint: "https://bsc-mainnet.nodereal.io/v1/test-key",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      methods.push(request.method);
      return response(rpcResult(request, "0x1"));
    }
  });
  await assert.rejects(adapter.getFinalizedBlockNumber(), /BNB Smart Chain mainnet/);
  assert.deepEqual(methods, ["eth_chainId"]);
});

test("batch-reads exact canonical block hashes and validates response identities", async () => {
  const adapter = createNodeRealFourMemeRpcAdapter({
    endpoint: "https://bsc-mainnet.nodereal.io/v1/test-key",
    fetchImpl: async (_url, init) => {
      const requests = JSON.parse(init.body);
      if (!Array.isArray(requests)) {
        assert.equal(requests.method, "eth_chainId");
        return response(rpcResult(requests, "0x38"));
      }
      assert.equal(requests.length, 2);
      return response([
        rpcResult(requests[1], block(9)),
        rpcResult(requests[0], block(8))
      ]);
    }
  });
  assert.deepEqual(await adapter.getBlockHashes(["8", "9"]), {
    "8": hash(8), "9": hash(9)
  });
});

test("queries only the official TokenManager2 address and the five supported event topics", async () => {
  let captured;
  const adapter = createNodeRealFourMemeRpcAdapter({
    endpoint: "https://bsc-mainnet.nodereal.io/v1/test-key",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === "eth_chainId") {
        return response(rpcResult(request, "0x38"));
      }
      captured = request;
      return response(rpcResult(captured, []));
    }
  });
  assert.deepEqual(await adapter.getLogs("100", "120"), []);
  assert.equal(captured.method, "eth_getLogs");
  assert.equal(captured.params[0].address, FOURMEME_TOKEN_MANAGER2_BSC);
  assert.equal(captured.params[0].fromBlock, "0x64");
  assert.equal(captured.params[0].toBlock, "0x78");
  assert.deepEqual(captured.params[0].topics, [SUPPORTED_TOPICS]);
  await assert.rejects(adapter.getLogs("1", "2001"), /range exceeds/);
});

test("fails closed on HTTP errors, RPC errors, invalid blocks and oversized batches", async () => {
  const httpFailure = createNodeRealFourMemeRpcAdapter({
    endpoint: "https://bsc-mainnet.nodereal.io/v1/test-key",
    fetchImpl: async () => response({}, 429)
  });
  await assert.rejects(httpFailure.getFinalizedBlockNumber(), /HTTP status 429/);

  const rpcFailure = createNodeRealFourMemeRpcAdapter({
    endpoint: "https://bsc-mainnet.nodereal.io/v1/test-key",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      return response({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "quota" } });
    }
  });
  await assert.rejects(rpcFailure.getFinalizedBlockNumber(), /method failed/);

  const invalidBlock = createNodeRealMemeRpcAdapterForTest({ number: "0x7b", hash: "0x1234" });
  await assert.rejects(invalidBlock.getFinalizedBlockNumber(), /Incomplete finalized/);

  const bounded = createNodeRealMemeRpcAdapterForTest();
  await assert.rejects(bounded.getBlockHashes(Array.from({ length: 33 }, (_, i) => String(i + 1))),
    /configured bound/);
});

function createNodeRealMemeRpcAdapterForTest(result = block(123)) {
  return createNodeRealFourMemeRpcAdapter({
    endpoint: "https://bsc-mainnet.nodereal.io/v1/test-key",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === "eth_chainId") {
        return response(rpcResult(request, "0x38"));
      }
      return response(rpcResult(request, result));
    }
  });
}

test("rejects insecure endpoints and duplicate or mismatched block requests", async () => {
  assert.throws(() => createNodeRealFourMemeRpcAdapter({
    endpoint: "http://example.com/rpc"
  }), /must use HTTPS/);

  const adapter = createNodeRealFourMemeRpcAdapter({
    endpoint: "https://bsc-mainnet.nodereal.io/v1/test-key",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (!Array.isArray(request)) {
        return response(rpcResult(request, "0x38"));
      }
      return response([rpcResult(request[0], block(999))]);
    }
  });
  await assert.rejects(adapter.getBlockHashes(["10"]), /does not match the request/);
  await assert.rejects(adapter.getBlockHashes(["10", "10"]), /Duplicate block/);
});
