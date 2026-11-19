/**
 * Parse one BSC Uniswap-V2-compatible Swap log into a read-only observation.
 *
 * Important: transaction.from is only the transaction initiator. It is not
 * proof of the beneficial trader/owner (routers, relayers and smart accounts
 * can alter attribution). This parser does not fetch data or persist records.
 */

export const BSC_V2_SWAP_TOPIC0 =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

const ADDRESS_RE = /^0x[a-f0-9]{40}$/i;

function normalizeAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function topicAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) return "";
  return "0x" + value.slice(-40).toLowerCase();
}

function uint256Word(data, index) {
  if (typeof data !== "string" || !/^0x(?:[0-9a-f]{64}){4}$/i.test(data)) return null;
  try {
    return BigInt("0x" + data.slice(2 + index * 64, 2 + (index + 1) * 64));
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} input
 * @param {object} input.log Raw eth_getLogs log for a V2-compatible pool.
 * @param {object} input.transaction Raw eth_getTransactionByHash result.
 * @param {object} input.pool Known pool metadata: address, token0, token1,
 *   targetToken and quoteToken.
 */
export function parseBscV2SwapObservation({ log, transaction, pool } = {}) {
  const poolAddress = normalizeAddress(pool && pool.address);
  const logAddress = normalizeAddress(log && log.address);
  const token0 = normalizeAddress(pool && pool.token0);
  const token1 = normalizeAddress(pool && pool.token1);
  const targetToken = normalizeAddress(pool && pool.targetToken);
  const quoteToken = normalizeAddress(pool && pool.quoteToken);
  const txHash = typeof (log && log.transactionHash) === "string"
    ? log.transactionHash.toLowerCase() : "";
  const initiatorAddress = normalizeAddress(transaction && transaction.from);

  if (![poolAddress, logAddress, token0, token1, targetToken, quoteToken].every(x => ADDRESS_RE.test(x)) ||
      logAddress !== poolAddress || targetToken === quoteToken ||
      !((targetToken === token0 && quoteToken === token1) ||
        (targetToken === token1 && quoteToken === token0))) {
    return { status: "unknown", reason: "池地址或 token 元数据无效/不匹配" };
  }
  if (!txHash || !/^0x[0-9a-f]{64}$/.test(txHash) || !ADDRESS_RE.test(initiatorAddress)) {
    return { status: "unknown", reason: "交易哈希或交易发起地址缺失" };
  }
  const topics = Array.isArray(log && log.topics) ? log.topics : [];
  if (topics.length !== 3 || String(topics[0]).toLowerCase() !== BSC_V2_SWAP_TOPIC0) {
    return { status: "unknown", reason: "不是受支持的 V2 Swap 事件" };
  }
  const amount0In = uint256Word(log.data, 0);
  const amount1In = uint256Word(log.data, 1);
  const amount0Out = uint256Word(log.data, 2);
  const amount1Out = uint256Word(log.data, 3);
  if ([amount0In, amount1In, amount0Out, amount1Out].some(x => x === null)) {
    return { status: "unknown", reason: "Swap 事件数据格式无效" };
  }

  const eventSender = topicAddress(topics[1]);
  const recipient = topicAddress(topics[2]);
  if (!ADDRESS_RE.test(eventSender) || !ADDRESS_RE.test(recipient)) {
    return { status: "unknown", reason: "Swap 事件参与地址无效" };
  }

  const targetIs0 = targetToken === token0;
  const targetIn = targetIs0 ? amount0In : amount1In;
  const targetOut = targetIs0 ? amount0Out : amount1Out;
  const quoteIn = targetIs0 ? amount1In : amount0In;
  const quoteOut = targetIs0 ? amount1Out : amount0Out;

  let side = null;
  let tokenAmountRaw = null;
  let quoteAmountRaw = null;
  if (targetOut > 0n && quoteIn > 0n && targetIn === 0n && quoteOut === 0n) {
    side = "buy";
    tokenAmountRaw = targetOut.toString();
    quoteAmountRaw = quoteIn.toString();
  } else if (targetIn > 0n && quoteOut > 0n && targetOut === 0n && quoteIn === 0n) {
    side = "sell";
    tokenAmountRaw = targetIn.toString();
    quoteAmountRaw = quoteOut.toString();
  } else {
    return { status: "unknown", reason: "Swap 方向不明确或包含多侧流入/流出" };
  }

  return {
    status: "observed",
    chain: "bsc",
    dexVersion: "v2",
    poolAddress,
    transactionHash: txHash,
    logIndex: log.logIndex == null ? null : String(log.logIndex),
    blockNumber: log.blockNumber == null ? null : String(log.blockNumber),
    initiatorAddress,
    attribution: "transaction_initiator_only",
    eventSenderAddress: eventSender,
    poolRecipientAddress: recipient,
    side,
    targetToken,
    quoteToken,
    tokenAmountRaw,
    quoteAmountRaw,
    usdValue: null,
    valuationStatus: "not_calculated"
  };
}
