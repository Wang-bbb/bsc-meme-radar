import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeEarlyBuyerCohort,
  evaluateWalletQuality,
  isExcludedSystemAddress
} from "../wallet-intelligence.js";

const goodWallet = overrides => ({
  chain: "bsc",
  address: "0x1111111111111111111111111111111111111111",
  closedTokenCount: 12,
  winRatePct: 70,
  realizedPnlUSD: 250,
  medianReturnPct: 35,
  rugExposurePct: 5,
  dataCoveragePct: 95,
  ...overrides
});

test("wallet quality returns higher_quality only with complete, adequate evidence", () => {
  const result = evaluateWalletQuality(goodWallet());
  assert.equal(result.status, "higher_quality");
  assert.equal(result.evidenceComplete, true);
  assert.ok(result.score >= 70);
});

test("missing or insufficient history remains unknown, never safe", () => {
  const result = evaluateWalletQuality(goodWallet({ closedTokenCount: 2, dataCoveragePct: 60 }));
  assert.equal(result.status, "unknown");
  assert.equal(result.score, null);
  assert.equal(result.evidenceComplete, false);
  assert.ok(result.reasons.some(reason => reason.includes("样本不足")));
});

test("high rug exposure is conservatively classified as avoid", () => {
  const result = evaluateWalletQuality(goodWallet({ rugExposurePct: 55 }));
  assert.equal(result.status, "avoid");
});

test("weak win rate and negative realized PnL trigger avoid", () => {
  const result = evaluateWalletQuality(goodWallet({
    winRatePct: 20,
    realizedPnlUSD: -100,
    medianReturnPct: -25
  }));
  assert.equal(result.status, "avoid");
});

test("invalid percentages and non-finite metrics are rejected as unknown", () => {
  assert.equal(evaluateWalletQuality(goodWallet({ winRatePct: 140 })).status, "unknown");
  assert.equal(evaluateWalletQuality(goodWallet({ realizedPnlUSD: Number.NaN })).status, "unknown");
  assert.equal(evaluateWalletQuality(goodWallet({ rugExposurePct: -1 })).status, "unknown");
});

test("malformed EVM addresses and unsupported chains remain unknown", () => {
  assert.equal(evaluateWalletQuality(goodWallet({ address: "wallet-1" })).status, "unknown");
  assert.equal(evaluateWalletQuality(goodWallet({ address: "0x1234" })).status, "unknown");
  assert.equal(evaluateWalletQuality(goodWallet({ chain: "solana" })).status, "unknown");
  assert.equal(evaluateWalletQuality(goodWallet({ chain: "bsc " })).status, "higher_quality");
});

test("zero and burn addresses are excluded from wallet scoring", () => {
  assert.equal(isExcludedSystemAddress("0x0000000000000000000000000000000000000000"), true);
  assert.equal(isExcludedSystemAddress("0x000000000000000000000000000000000000dEaD"), true);
  const result = evaluateWalletQuality(goodWallet({
    address: "0x000000000000000000000000000000000000dead"
  }));
  assert.equal(result.status, "excluded");
  assert.equal(result.score, null);
});

test("cohort retention is calculated only with at least five known positions", () => {
  const result = analyzeEarlyBuyerCohort([
    { address: "0x0000000000000000000000000000000000000001", holdingStatus: "holding" },
    { address: "0x0000000000000000000000000000000000000002", holdingStatus: "sold" },
    { address: "0x0000000000000000000000000000000000000003", holdingStatus: "unknown" },
    { address: "0x0000000000000000000000000000000000000004", holdingStatus: "holding" }
  ]);
  assert.equal(result.retentionRatePct, null);
  assert.equal(result.status, "insufficient");
});

test("low early-buyer retention raises a review flag", () => {
  const wallets = Array.from({ length: 5 }, (_, i) => ({
    address: "0x" + (i + 10).toString(16).padStart(40, "0"),
    holdingStatus: i === 0 ? "holding" : "sold"
  }));
  const result = analyzeEarlyBuyerCohort(wallets);
  assert.equal(result.retentionRatePct, 20);
  assert.equal(result.status, "risk_review");
});

test("shared funding and synchronized buys are correlation flags, not ownership claims", () => {
  const wallets = Array.from({ length: 5 }, (_, i) => ({
    address: "0x" + (i + 20).toString(16).padStart(40, "0"),
    holdingStatus: "holding",
    fundingSourceId: i < 3 ? "funding-cluster-a" : `funding-${i}`,
    synchronizedBuyGroupId: i < 4 ? "sync-group-a" : ""
  }));
  const result = analyzeEarlyBuyerCohort(wallets);
  assert.equal(result.largestFundingCluster, 3);
  assert.equal(result.largestSynchronizedGroup, 4);
  assert.equal(result.status, "correlation_review");
  assert.ok(result.reasons.some(reason => reason.includes("不代表同一控制人")));
});

test("duplicate addresses and burn addresses do not inflate cohort size", () => {
  const result = analyzeEarlyBuyerCohort([
    { address: "0x00000000000000000000000000000000000000ab", holdingStatus: "holding" },
    { address: "0x00000000000000000000000000000000000000AB", holdingStatus: "sold" },
    { address: "0x000000000000000000000000000000000000dead", holdingStatus: "holding" }
  ]);
  assert.equal(result.cohortSize, 1);
  assert.equal(result.knownPositionCount, 1);
});

test("negative total realized PnL can never receive higher_quality", () => {
  const result = evaluateWalletQuality(goodWallet({
    winRatePct: 95,
    realizedPnlUSD: -1,
    medianReturnPct: 50,
    rugExposurePct: 0,
    closedTokenCount: 20,
    dataCoveragePct: 100
  }));
  assert.notEqual(result.status, "higher_quality");
  assert.ok(result.reasons.some(reason => reason.includes("总已实现盈亏为负")));
});
