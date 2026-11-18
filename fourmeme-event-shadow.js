const TOKEN_MANAGER2_BSC = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;

const EVENT_NAMES = new Set([
  "TokenCreate",
  "TokenPurchase",
  "TokenSale",
  "TradeStop",
  "LiquidityAdded"
]);

function requireAddress(value, field) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value.toLowerCase();
}

function requireUint(value, field) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`Invalid ${field}: unsafe numeric input`);
  }
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

const EVENT_TOPICS = Object.freeze({
  TokenCreate: "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20",
  TokenPurchase: "0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942",
  TokenSale: "0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19",
  TradeStop: "0x8f9ab4bd7eff0d085f91575d50cd83f97aa5258e24ded7630d4fd6739e857132",
  LiquidityAdded: "0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0"
});

const TOPIC_TO_EVENT = new Map(
  Object.entries(EVENT_TOPICS).map(([name, topic]) => [topic, name])
);

function normalizeHexData(value, field) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value.slice(2).toLowerCase();
}

function readWord(data, index) {
  const start = index * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) throw new TypeError("Truncated ABI data");
  return word;
}

function wordUint(word, field) {
  return BigInt("0x" + word);
}

function wordAddress(word, field) {
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) throw new TypeError(`Invalid ABI address: ${field}`);
  return "0x" + word.slice(24);
}

function readDynamicString(data, offsetWord, field) {
  const offset = BigInt("0x" + offsetWord);
  if (offset < 256n || offset % 32n !== 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`Invalid ABI offset: ${field}`);
  }
  const byteOffset = Number(offset);
  const lengthWord = data.slice(byteOffset * 2, byteOffset * 2 + 64);
  if (lengthWord.length !== 64) throw new TypeError(`Truncated ABI string length: ${field}`);
  const length = BigInt("0x" + lengthWord);
  if (length > 4096n) throw new TypeError(`ABI string too long: ${field}`);
  const start = byteOffset * 2 + 64;
  const end = start + Number(length) * 2;
  const encoded = data.slice(start, end);
  if (encoded.length !== Number(length) * 2) throw new TypeError(`Truncated ABI string: ${field}`);
  const bytes = new Uint8Array(Number(length));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(encoded.slice(i * 2, i * 2 + 2), 16);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`Invalid UTF-8 ABI string: ${field}`);
  }
}

function parseRpcQuantity(value, field) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${field}`);
    return String(value);
  }
  if (typeof value !== "string") throw new TypeError(`Invalid ${field}`);
  if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value).toString();
  return requireUint(value, field);
}

/**
 * Decode a raw eth_getLogs entry from the canonical Four.meme TokenManager2 V2
 * contract. All five official V2 events have non-indexed arguments; topic0
 * identifies the event and the ABI data contains every argument.
 *
 * This function does not fetch RPC data or determine finality. The caller must
 * provide an explicit finalityStatus and must not pass removed/reorged logs.
 */
export function decodeFourMemeRawLog(log, options = {}) {
  if (!log || typeof log !== "object") throw new TypeError("Raw log is required");
  if (String(log.address || "").toLowerCase() !== TOKEN_MANAGER2_BSC) {
    throw new TypeError("Unexpected Four.meme TokenManager2 contract");
  }
  if (log.removed === true) throw new TypeError("Removed/reorged log is not accepted");
  if (!Array.isArray(log.topics) || log.topics.length !== 1) {
    throw new TypeError("Expected exactly topic0; V2 event arguments are non-indexed");
  }
  const topic0 = String(log.topics[0]).toLowerCase();
  const eventName = TOPIC_TO_EVENT.get(topic0);
  if (!eventName) throw new TypeError("Unknown Four.meme TokenManager2 event topic");
  const data = normalizeHexData(log.data, "log data");
  const wordCount = {
    TokenCreate: 8,
    TokenPurchase: 8,
    TokenSale: 8,
    TradeStop: 1,
    LiquidityAdded: 4
  }[eventName];
  if (data.length < wordCount * 64) throw new TypeError("Truncated ABI event head");

  const uintAt = index => wordUint(readWord(data, index), `arg${index}`).toString();
  const addressAt = index => wordAddress(readWord(data, index), `arg${index}`);
  let args;
  if (eventName === "TokenCreate") {
    args = {
      creator: addressAt(0),
      token: addressAt(1),
      requestId: uintAt(2),
      name: readDynamicString(data, readWord(data, 3), "name"),
      symbol: readDynamicString(data, readWord(data, 4), "symbol"),
      totalSupply: uintAt(5),
      launchTime: uintAt(6),
      launchFee: uintAt(7)
    };
  } else if (eventName === "TokenPurchase" || eventName === "TokenSale") {
    args = {
      token: addressAt(0),
      account: addressAt(1),
      price: uintAt(2),
      amount: uintAt(3),
      cost: uintAt(4),
      fee: uintAt(5),
      offers: uintAt(6),
      funds: uintAt(7)
    };
  } else if (eventName === "TradeStop") {
    args = { token: addressAt(0) };
  } else {
    args = {
      base: addressAt(0),
      offers: uintAt(1),
      quote: addressAt(2),
      funds: uintAt(3)
    };
  }

  return normalizeFourMemeEvent({
    address: log.address,
    eventName,
    args,
    blockNumber: parseRpcQuantity(log.blockNumber, "blockNumber"),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: parseRpcQuantity(log.logIndex, "logIndex"),
    finalityStatus: options.finalityStatus,
    transactionFrom: options.transactionFrom
  });
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

  if (input.eventName === "TradeStop") {
    return { ...common, tokenAddress: requireAddress(args.token, "token") };
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

  const orderedEvents = events
    .filter(event => event && EVENT_NAMES.has(event.eventName) &&
      event.finalityStatus === "finalized" &&
      UINT_RE.test(String(event.blockNumber)) &&
      Number.isSafeInteger(Number(event.logIndex)) && Number(event.logIndex) >= 0)
    .slice()
    .sort((a, b) => {
      const aBlock = BigInt(a.blockNumber);
      const bBlock = BigInt(b.blockNumber);
      if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
      return Number(a.logIndex) - Number(b.logIndex);
    });

  for (const event of orderedEvents) {
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
        tradeStopped: false,
        liquidityAdded: false,
        liquidityDetails: null,
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
    } else if (event.eventName === "TradeStop") {
      summary.tradeStopped = true;
    } else if (event.eventName === "LiquidityAdded") {
      summary.liquidityAdded = true;
      summary.liquidityDetails = {
        quoteAddress: event.quoteAddress,
        lpTokenAmountRaw: event.offers,
        cumulativeFundsRaw: event.funds,
        blockNumber: event.blockNumber
      };
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
