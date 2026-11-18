import { isExcludedSystemAddress } from "./wallet-intelligence.js";

/**
 * Aggregate only what the radar actually observed.
 *
 * This intentionally does not infer wallet balances, closed positions, PnL,
 * win rate, or holdings from a partial pool sample.
 */
export function summarizeObservedWalletActivity(observations) {
  if (!Array.isArray(observations)) {
    return { status: "unknown", wallets: [], reason: "观察记录不是数组" };
  }

  const wallets = new Map();
  for (const item of observations) {
    if (!item || item.status !== "observed" || item.coverage && item.coverage !== "observed_pool_only") continue;
    const address = typeof item.initiatorAddress === "string" ? item.initiatorAddress.trim().toLowerCase() : "";
    const chain = typeof item.chain === "string" ? item.chain.trim().toLowerCase() : "";
    if (!address || !chain || isExcludedSystemAddress(address)) continue;
    if (!["buy", "sell"].includes(item.side) || !item.targetToken || !item.poolAddress) continue;

    const key = chain + ":" + address;
    if (!wallets.has(key)) {
      wallets.set(key, {
        address,
        chain,
        observedTradeCount: 0,
        observedBuyCount: 0,
        observedSellCount: 0,
        uniqueTokenAddresses: new Set(),
        uniquePoolAddresses: new Set(),
        firstObservedAt: null,
        lastObservedAt: null
      });
    }
    const wallet = wallets.get(key);
    wallet.observedTradeCount++;
    if (item.side === "buy") wallet.observedBuyCount++;
    else wallet.observedSellCount++;
    wallet.uniqueTokenAddresses.add(String(item.targetToken).toLowerCase());
    wallet.uniquePoolAddresses.add(String(item.poolAddress).toLowerCase());

    const observedAt = Number(item.observedAt);
    if (Number.isFinite(observedAt) && observedAt > 0) {
      wallet.firstObservedAt = wallet.firstObservedAt === null ? observedAt : Math.min(wallet.firstObservedAt, observedAt);
      wallet.lastObservedAt = wallet.lastObservedAt === null ? observedAt : Math.max(wallet.lastObservedAt, observedAt);
    }
  }

  const result = [...wallets.values()].map(wallet => ({
    address: wallet.address,
    chain: wallet.chain,
    observedTradeCount: wallet.observedTradeCount,
    observedBuyCount: wallet.observedBuyCount,
    observedSellCount: wallet.observedSellCount,
    uniqueTokenCount: wallet.uniqueTokenAddresses.size,
    uniquePoolCount: wallet.uniquePoolAddresses.size,
    firstObservedAt: wallet.firstObservedAt,
    lastObservedAt: wallet.lastObservedAt,
    coverage: "observed_pool_only",
    performanceStatus: "unknown",
    realizedPnlUSD: null,
    winRatePct: null,
    medianReturnPct: null,
    rugExposurePct: null,
    walletBalanceKnown: false,
    note: "仅统计雷达观察到的池内交易；不能代表全链钱包历史、真实余额或完整盈亏"
  })).sort((a, b) => b.observedTradeCount - a.observedTradeCount);

  return { status: "observed_sample", walletCount: result.length, wallets: result };
}
