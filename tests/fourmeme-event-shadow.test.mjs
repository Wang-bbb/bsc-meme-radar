import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFourMemeEvent,
  decodeFourMemeRawLog,
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

function abiWord(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}
function abiAddress(value) {
  return value.slice(2).toLowerCase().padStart(64, "0");
}
function abiString(value) {
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return abiWord(bytes.length) + padded;
}
function rawLog(topic, data, overrides = {}) {
  return {
    address: FOURMEME_TOKEN_MANAGER2_BSC,
    topics: [topic],
    data: "0x" + data,
    blockNumber: "0x64",
    blockHash,
    transactionHash: hash,
    logIndex: "0x0",
    ...overrides
  };
}

test("decodes raw TokenPurchase logs using the verified V2 topic and preserves sender separately", () => {
  const topic = "0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942";
  const data = [
    abiAddress(token), abiAddress(buyer), abiWord(11), abiWord(22),
    abiWord(33), abiWord(4), abiWord(55), abiWord(66)
  ].join("");
  const decoded = decodeFourMemeRawLog(rawLog(topic, data), {
    finalityStatus: "finalized",
    transactionFrom: sender
  });
  assert.equal(decoded.eventName, "TokenPurchase");
  assert.equal(decoded.tokenAddress, token);
  assert.equal(decoded.accountAddress, buyer);
  assert.equal(decoded.transactionSenderAddress, sender);
  assert.equal(decoded.cost, "33");
  assert.equal(decoded.funds, "66");
  assert.equal(decoded.blockNumber, "100");
});

test("decodes TokenCreate dynamic UTF-8 strings and all static fields", () => {
  const topic = "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20";
  const name = "测试 Meme";
  const symbol = "TST";
  const nameTail = abiString(name);
  const symbolOffset = 256 + nameTail.length / 2;
  const data = [
    abiAddress(creator), abiAddress(token), abiWord(9),
    abiWord(256), abiWord(symbolOffset), abiWord(1000),
    abiWord(1700000000), abiWord(7),
    nameTail, abiString(symbol)
  ].join("");
  const decoded = decodeFourMemeRawLog(rawLog(topic, data), { finalityStatus: "finalized" });
  assert.equal(decoded.eventName, "TokenCreate");
  assert.equal(decoded.name, name);
  assert.equal(decoded.symbol, symbol);
  assert.equal(decoded.totalSupply, "1000");
  assert.equal(decoded.launchFee, "7");
});

test("decodes TokenSale, TradeStop and LiquidityAdded raw logs", () => {
  const saleTopic = "0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19";
  const saleData = [
    abiAddress(token), abiAddress(buyer), abiWord(1), abiWord(2),
    abiWord(3), abiWord(4), abiWord(5), abiWord(6)
  ].join("");
  const sale = decodeFourMemeRawLog(rawLog(saleTopic, saleData), { finalityStatus: "finalized" });
  assert.equal(sale.eventName, "TokenSale");
  assert.equal(sale.accountRole, "seller");

  const stopTopic = "0x8f9ab4bd7eff0d085f91575d50cd83f97aa5258e24ded7630d4fd6739e857132";
  const stopped = decodeFourMemeRawLog(rawLog(stopTopic, abiAddress(token)), { finalityStatus: "finalized" });
  assert.equal(stopped.eventName, "TradeStop");
  assert.equal(stopped.tokenAddress, token);

  const liquidityTopic = "0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0";
  const quote = "0x0000000000000000000000000000000000000000";
  const liquidityData = [abiAddress(token), abiWord(999), abiAddress(quote), abiWord(1200)].join("");
  const liquidity = decodeFourMemeRawLog(rawLog(liquidityTopic, liquidityData), { finalityStatus: "finalized" });
  assert.equal(liquidity.eventName, "LiquidityAdded");
  assert.equal(liquidity.offers, "999");
  assert.equal(liquidity.quoteAddress, quote);
});

test("rejects unknown, indexed-looking, removed and malformed raw logs", () => {
  assert.throws(() => decodeFourMemeRawLog(rawLog("0x" + "0".repeat(64), ""), { finalityStatus: "finalized" }), /Unknown/);
  assert.throws(() => decodeFourMemeRawLog(rawLog("0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942", "", { topics: ["0x" + "0".repeat(64), hash] }), { finalityStatus: "finalized" }), /exactly topic0/);
  assert.throws(() => decodeFourMemeRawLog(rawLog("0x8f9ab4bd7eff0d085f91575d50cd83f97aa5258e24ded7630d4fd6739e857132", abiAddress(token), { removed: true }), { finalityStatus: "finalized" }), /Removed/);
  assert.throws(() => decodeFourMemeRawLog(rawLog("0x8f9ab4bd7eff0d085f91575d50cd83f97aa5258e24ded7630d4fd6739e857132", "00"), { finalityStatus: "finalized" }), /Truncated/);
});

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

test("rejects unsafe JavaScript numbers instead of silently accepting rounded uints", () => {
  assert.throws(() => event("TokenCreate", {
    creator, token, requestId: Number.MAX_SAFE_INTEGER + 1, name: "X", symbol: "X",
    totalSupply: 1, launchTime: 1, launchFee: 1
  }), /unsafe numeric input/);
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


test("records TradeStop as a lifecycle event, not a safety verdict", () => {
  const stopped = event("TradeStop", { token }, {
    transactionHash: "0x" + "d".repeat(64),
    logIndex: 2
  });
  const result = summarizeFourMemeTokenEvents([stopped])[0];
  assert.equal(stopped.tokenAddress, token);
  assert.equal(result.tradeStopped, true);
  assert.equal(result.evidenceStatus, "onchain_observed_not_safety_verified");
  assert.equal("safetyScore" in result, false);
});


test("orders out-of-order logs before selecting the latest funds and preserves migration quote details", () => {
  const earlierBuy = event("TokenPurchase", {
    token, account: buyer, price: 1, amount: 2, cost: 10,
    fee: 1, offers: 4, funds: 100
  }, {
    blockNumber: "101",
    transactionHash: "0x" + "e".repeat(64),
    logIndex: 0
  });
  const laterLiquidity = event("LiquidityAdded", {
    base: token, quote: "0x0000000000000000000000000000000000000000",
    offers: 900, funds: 120
  }, {
    blockNumber: "102",
    transactionHash: "0x" + "f".repeat(64),
    logIndex: 1
  });
  const result = summarizeFourMemeTokenEvents([laterLiquidity, earlierBuy])[0];
  assert.equal(result.lastEventBlock, "102");
  assert.equal(result.latestFundsRaw, "120");
  assert.equal(result.liquidityAdded, true);
  assert.deepEqual(result.liquidityDetails, {
    quoteAddress: "0x0000000000000000000000000000000000000000",
    lpTokenAmountRaw: "900",
    cumulativeFundsRaw: "120",
    blockNumber: "102"
  });
});
