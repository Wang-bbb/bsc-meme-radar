const TOKEN_MANAGER2_BSC = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;

const EVENT_NAMES = new Set([
  "TokenCreate",
  "TokenPurchase",
  "TokenSale",
  "LiquidityAdded"
]);

function requireAddress(value, field) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value.toLowerCase();
}

function requireUint(value, field) {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!UINT_RE.test(normalized)) throw new TypeError(`Invalid ${field}`);
  return normalized;
}

function requireText(value, field, maxLength = 128) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value.trim();
}

/**
 * Normalize an ABI-decoded TokenManager2 event into a stable, read-only record.
 * The caller must supply only logs decoded against the official V2 ABI and must
 * mark finality explicitly. This function does not decode raw RPC log data.
 */
export function normalizeFourMemeEvent(input) {
  if (!input || typeof input !== "object") throw new TypeError("Event is required");
  if (String(input.address || "").toLowerCase() !== TOKEN_MANAGER2_BSC) {
    throw new TypeError("Unexpected Four.meme TokenManager2 contract");
  }
  if (!EVENT_NAMES.has(input.eventName)) throw new TypeError("Unsupported Four.meme event");
  if (input.finalityStatus !== "finalized" && input.finalityStatus !== "confirmed") {
    throw new TypeError("Invalid finalityStatus");
  }
  const blockNumber = requireUint(input.blockNumber, "blockNumber");
  const logIndex = Number(input.logIndex);
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) throw new TypeError("Invalid logIndex");
  if (!HASH_RE.test(input.blockHash || "")) throw new TypeError("Invalid blockHash");
  if (!HASH_RE.test(input.transactionHash || "")) throw new TypeError("Invalid transactionHash");

  const args = input.args;
  if (!args || typeof args !== "object") throw new TypeError("Decoded event args are required");
  const common = {
    chainId: 56,
    source: "fourmeme-tokenmanager2-v2",
    eventName: input.eventName,
    blockNumber,
    blockHash: input.blockHash.toLowerCase(),
    transactionHash: input.transactionHash.toLowerCase(),
    logIndex,
    eventId: `${input.transactionHash.toLowerCase()}:${logIndex}`,
    finalityStatus: input.finalityStatus,
    transactionSenderAddress: input.transactionFrom
      ? requireAddress(input.transactionFrom, "transactionFrom")
      : null
  };

  if (input.eventName === "TokenCreate") {
    return {
      ...common,
      tokenAddress: requireAddress(args.token, "token"),
      creatorAddress: requireAddress(args.creator, "creator"),
      requestId: requireUint(args.requestId, "requestId"),
      name: requireText(args.name, "name"),
      symbol: requireText(args.symbol, "symbol", 32),
      totalSupply: requireUint(args.totalSupply, "totalSupply"),
      launchTime: requireUint(args.launchTime, "launchTime"),
      launchFee: requireUint(args.launchFee, "launchFee")
    };
  }

  if (input.eventName === "TokenPurchase" || input.eventName === "TokenSale") {
    const isBuy = input.eventName === "TokenPurchase";
    return {
      ...common,
      tokenAddress: requireAddress(args.token, "token"),
      accountAddress: requireAddress(args.account, "account"),
      accountRole: isBuy ? "recipient_not_necessarily_sender" : "seller",
      price: requireUint(args.price, "price"),
      amount: requireUint(args.amount, "amount"),
      cost: requireUint(args.cost, "cost"),
      fee: requireUint(args.fee, "fee"),
      offers: requireUint(args.offers, "offers"),
      funds: requireUint(args.funds, "funds")
    };
  }

  return {
    ...common,
    tokenAddress: requireAddress(args.base, "base"),
    quoteAddress: requireAddress(args.quote, "quote"),
    offers: requireUint(args.offers, "offers"),
    funds: requireUint(args.funds, "funds")
  };
}

/**
 * Aggregate only finalized, normalized observations. This is descriptive
 * evidence, not a safety grade, profitability estimate, or buy signal.
 */
export function summarizeFourMemeTokenEvents(events) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const byToken = new Map();
  const seen = new Set();

  for (const event of events) {
    if (!event || !EVENT_NAMES.has(event.eventName)) continue;
    if (event.finalityStatus !== "finalized") continue;
    const tokenAddress = String(event.tokenAddress || "").toLowerCase();
    if (!ADDRESS_RE.test(tokenAddress)) continue;
    const eventId = String(event.eventId || "");
    if (!eventId || seen.has(eventId)) continue;
    seen.add(eventId);

    let summary = byToken.get(tokenAddress);
    if (!summary) {
      summary = {
        chainId: 56,
        tokenAddress,
        creation: null,
        buyEventCount: 0,
        sellEventCount: 0,
        liquidityAdded: false,
        distinctBuyAccounts: [],
        distinctTransactionSenders: [],
        totalBuyCostRaw: "0",
        totalSellCostRaw: "0",
        latestFundsRaw: null,
        eventCount: 0,
        lastEventBlock: null
      };
      byToken.set(tokenAddress, summary);
    }

    summary.eventCount += 1;
    if (summary.lastEventBlock == null || BigInt(event.blockNumber) > BigInt(summary.lastEventBlock)) {
      summary.lastEventBlock = event.blockNumber;
    }

    if (event.eventName === "TokenCreate") {
      summary.creation = {
        creatorAddress: event.creatorAddress,
        name: event.name,
        symbol: event.symbol,
        launchTime: event.launchTime,
        launchFeeRaw: event.launchFee
      };
    } else if (event.eventName === "TokenPurchase") {
      summary.buyEventCount += 1;
      summary.totalBuyCostRaw = (BigInt(summary.totalBuyCostRaw) + BigInt(event.cost)).toString();
      if (!summary.distinctBuyAccounts.includes(event.accountAddress)) {
        summary.distinctBuyAccounts.push(event.accountAddress);
      }
      if (event.transactionSenderAddress &&
          !summary.distinctTransactionSenders.includes(event.transactionSenderAddress)) {
        summary.distinctTransactionSenders.push(event.transactionSenderAddress);
      }
      summary.latestFundsRaw = event.funds;
    } else if (event.eventName === "TokenSale") {
      summary.sellEventCount += 1;
      summary.totalSellCostRaw = (BigInt(summary.totalSellCostRaw) + BigInt(event.cost)).toString();
      summary.latestFundsRaw = event.funds;
    } else if (event.eventName === "LiquidityAdded") {
      summary.liquidityAdded = true;
      summary.latestFundsRaw = event.funds;
    }
  }

  return [...byToken.values()].map(summary => ({
    ...summary,
    distinctBuyAccounts: summary.distinctBuyAccounts.sort(),
    distinctTransactionSenders: summary.distinctTransactionSenders.sort(),
    evidenceStatus: summary.eventCount > 0 ? "onchain_observed_not_safety_verified" : "unknown"
  }));
}

export const FOURMEME_TOKEN_MANAGER2_BSC = TOKEN_MANAGER2_BSC;
