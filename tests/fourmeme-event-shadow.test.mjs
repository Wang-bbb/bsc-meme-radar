import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFourMemeEvent,
  summarizeFourMemeTokenEvents,
  FOURMEME_TOKEN_MANAGER2_BSC
} from "../fourmeme-event-shadow.js";

const token = "0x1111111111111111111111111111111111111111";
const creator = "0x2222222222222222222222222222222222222222";
const buyer = "0x3333333333333333333333333333333333333333";
const sender = "0x4444444444444444444444444444444444444444";
const hash = "0x" + "a".repeat(64);
const blockHash = "0x" + "b".repeat(64);

function event(eventName, args, overrides = {}) {
  return normalizeFourMemeEvent({
    address: FOURMEME_TOKEN_MANAGER2_BSC,
    eventName,
    args,
    blockNumber: "100",
    blockHash,
    transactionHash: hash,
    logIndex: 0,
    finalityStatus: "finalized",
    ...overrides
  });
}

test("normalizes TokenCreate using stable contract identity and string uints", () => {
  const result = event("TokenCreate", {
    creator, token, requestId: 7n, name: " Test ", symbol: " TST ",
    totalSupply: 1000n, launchTime: 1700000000n, launchFee: 2n
  });
  assert.equal(result.tokenAddress, token);
  assert.equal(result.creatorAddress, creator);
  assert.equal(result.name, "Test");
  assert.equal(result.symbol, "TST");
  assert.equal(result.requestId, "7");
});

test("keeps TokenPurchase account separate from transaction sender", () => {
  const result = event("TokenPurchase", {
    token, account: buyer, price: 1n, amount: 2n, cost: 3n,
    fee: 1n, offers: 4n, funds: 5n
  }, { transactionFrom: sender });
  assert.equal(result.accountAddress, buyer);
  assert.equal(result.accountRole, "recipient_not_necessarily_sender");
  assert.equal(result.transactionSenderAddress, sender);
  assert.notEqual(result.accountAddress, result.transactionSenderAddress);
});

test("normalizes TokenSale seller and LiquidityAdded token identity", () => {
  const sale = event("TokenSale", {
    token, account: buyer, price: 1n, amount: 2n, cost: 3n,
    fee: 1n, offers: 4n, funds: 5n
  });
  const liquidity = event("LiquidityAdded", {
    base: token, quote: "0x0000000000000000000000000000000000000000",
    offers: 10n, funds: 11n
  }, { transactionHash: "0x" + "c".repeat(64), logIndex: 1 });
  assert.equal(sale.accountRole, "seller");
  assert.equal(liquidity.tokenAddress, token);
});

test("rejects logs from a different contract", () => {
  assert.throws(() => event("TokenCreate", {}, { address: token }), /Unexpected/);
});

test("rejects unrecognized events and malformed addresses", () => {
  assert.throws(() => event("Approval", {}), /Unsupported/);
  assert.throws(() => event("TokenPurchase", {
    token: "not-an-address", account: buyer, price: 1, amount: 2,
    cost: 3, fee: 1, offers: 4, funds: 5
  }), /Invalid token/);
});

test("requires explicit finality and valid block identity", () => {
  assert.throws(() => event("TokenCreate", {
    creator, token, requestId: 1, name: "X", symbol: "X",
    totalSupply: 1, launchTime: 1, launchFee: 1
  }, { finalityStatus: "pending" }), /finalityStatus/);
  assert.throws(() => event("TokenCreate", {
    creator, token, requestId: 1, name: "X", symbol: "X",
    totalSupply: 1, launchTime: 1, launchFee: 1
  }, { blockHash: "bad" }), /blockHash/);
});

test("aggregates only finalized events and deduplicates transaction logs", () => {
  const create = event("TokenCreate", {
    creator, token, requestId: 1, name: "X", symbol: "X",
    totalSupply: 100, launchTime: 1000, launchFee: 1
  });
  const buy = event("TokenPurchase", {
    token, account: buyer, price: 1, amount: 2, cost: 30,
    fee: 1, offers: 4, funds: 50
  }, { transactionHash: "0x" + "c".repeat(64), logIndex: 1 });
  const unfinalized = { ...buy, eventId: "pending", finalityStatus: "confirmed" };
  const result = summarizeFourMemeTokenEvents([create, buy, buy, unfinalized]);
  assert.equal(result.length, 1);
  assert.equal(result[0].eventCount, 2);
  assert.equal(result[0].buyEventCount, 1);
  assert.equal(result[0].totalBuyCostRaw, "30");
  assert.equal(result[0].evidenceStatus, "onchain_observed_not_safety_verified");
});

test("tracks sell pressure and liquidity migration without assigning a safety score", () => {
  const buy = event("TokenPurchase", {
    token, account: buyer, price: 1, amount: 2, cost: 30,
    fee: 1, offers: 4, funds: 50
  });
  const sale = event("TokenSale", {
    token, account: buyer, price: 1, amount: 2, cost: 20,
    fee: 1, offers: 4, funds: 30
  }, { transactionHash: "0x" + "c".repeat(64), logIndex: 1 });
  const result = summarizeFourMemeTokenEvents([buy, sale])[0];
  assert.equal(result.buyEventCount, 1);
  assert.equal(result.sellEventCount, 1);
  assert.equal(result.totalBuyCostRaw, "30");
  assert.equal(result.totalSellCostRaw, "20");
  assert.equal(result.evidenceStatus, "onchain_observed_not_safety_verified");
  assert.equal("safetyScore" in result, false);
});
