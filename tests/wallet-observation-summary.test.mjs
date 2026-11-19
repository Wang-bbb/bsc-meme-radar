import test from "node:test";
import assert from "node:assert/strict";
import { summarizeObservedWalletActivity } from "../wallet-observation-summary.js";

const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const burn = "0x000000000000000000000000000000000000dead";
const base = {
  status: "observed",
  chain: "bsc",
  initiatorAddress: wallet,
  poolAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  targetToken: "0xcccccccccccccccccccccccccccccccccccccccc",
  observedAt: 1000,
  coverage: "observed_pool_only"
};

test("summarizes observed buys and sells without inventing wallet performance", () => {
  const result = summarizeObservedWalletActivity([
    { ...base, side: "buy" },
    { ...base, side: "sell", observedAt: 2000, poolAddress: "0xdddddddddddddddddddddddddddddddddddddddd" },
    { ...base, side: "buy", targetToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }
  ]);
  assert.equal(result.status, "observed_sample");
  assert.equal(result.walletCount, 1);
  const row = result.wallets[0];
  assert.equal(row.observedTradeCount, 3);
  assert.equal(row.observedBuyCount, 2);
  assert.equal(row.observedSellCount, 1);
  assert.equal(row.uniqueTokenCount, 2);
  assert.equal(row.uniquePoolCount, 2);
  assert.equal(row.firstObservedAt, 1000);
  assert.equal(row.lastObservedAt, 2000);
  assert.equal(row.performanceStatus, "unknown");
  assert.equal(row.realizedPnlUSD, null);
  assert.equal(row.walletBalanceKnown, false);
});

test("excludes burn/system addresses and ignores unsupported or incomplete rows", () => {
  const result = summarizeObservedWalletActivity([
    { ...base, initiatorAddress: burn, side: "buy" },
    { ...base, side: "transfer" },
    { ...base, status: "unknown", side: "buy" },
    { ...base, coverage: "full_chain", side: "buy" },
    { ...base, initiatorAddress: "", side: "buy" }
  ]);
  assert.equal(result.walletCount, 0);
});

test("keeps chains separate and returns unknown for non-array input", () => {
  const result = summarizeObservedWalletActivity([
    { ...base, side: "buy" },
    { ...base, chain: "base", side: "sell" }
  ]);
  assert.equal(result.walletCount, 2);
  assert.deepEqual(summarizeObservedWalletActivity(null), {
    status: "unknown", wallets: [], reason: "观察记录不是数组"
  });
});
