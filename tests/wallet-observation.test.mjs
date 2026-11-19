import test from "node:test";
import assert from "node:assert/strict";
import { BSC_V2_SWAP_TOPIC0, parseBscV2SwapObservation } from "../wallet-observation.js";

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
const makeLog = (amounts, overrides = {}) => ({
  address: pool.address,
  topics: [BSC_V2_SWAP_TOPIC0, topic(sender), topic(recipient)],
  data: "0x" + amounts.map(word).join(""),
  transactionHash: "0x" + "e".repeat(64),
  logIndex: "0x2",
  blockNumber: "0x100",
  ...overrides
});
const tx = { from: initiator, to: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" };

test("parses a V2 buy while labeling tx.from as initiator only", () => {
  const result = parseBscV2SwapObservation({
    log: makeLog([0, 5000000000000000000n, 100000000000000000000n, 0]),
    transaction: tx,
    pool
  });
  assert.equal(result.status, "observed");
  assert.equal(result.side, "buy");
  assert.equal(result.initiatorAddress, initiator);
  assert.equal(result.attribution, "transaction_initiator_only");
  assert.equal(result.tokenAmountRaw, "100000000000000000000");
  assert.equal(result.quoteAmountRaw, "5000000000000000000");
  assert.equal(result.usdValue, null);
});

test("parses a V2 sell with reversed token flow", () => {
  const result = parseBscV2SwapObservation({
    log: makeLog([100000000000000000000n, 0, 0, 5000000000000000000n]),
    transaction: tx,
    pool
  });
  assert.equal(result.status, "observed");
  assert.equal(result.side, "sell");
  assert.equal(result.tokenAmountRaw, "100000000000000000000");
  assert.equal(result.quoteAmountRaw, "5000000000000000000");
});

test("returns unknown when the event direction is ambiguous", () => {
  const result = parseBscV2SwapObservation({
    log: makeLog([100, 200, 300, 400]),
    transaction: tx,
    pool
  });
  assert.equal(result.status, "unknown");
});

test("rejects a mismatched pool address or missing transaction initiator", () => {
  const mismatched = parseBscV2SwapObservation({
    log: makeLog([0, 5, 100, 0], { address: "0xffffffffffffffffffffffffffffffffffffffff" }),
    transaction: tx,
    pool
  });
  assert.equal(mismatched.status, "unknown");
  const noInitiator = parseBscV2SwapObservation({
    log: makeLog([0, 5, 100, 0]),
    transaction: {},
    pool
  });
  assert.equal(noInitiator.status, "unknown");
});

test("does not mislabel V3 or non-Swap logs as V2", () => {
  const result = parseBscV2SwapObservation({
    log: makeLog([0, 5, 100, 0], { topics: ["0x" + "1".repeat(64), topic(sender), topic(recipient)] }),
    transaction: tx,
    pool
  });
  assert.equal(result.status, "unknown");
});
