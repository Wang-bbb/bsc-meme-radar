/**
 * Read-only wallet intelligence heuristics for Meme Radar.
 *
 * This module is deliberately provider-agnostic and has no network, wallet,
 * signing, trading, or persistence code. Callers must supply observed metrics.
 * Results are advisory evidence only; they must not override security gates.
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finiteNumber = value => value !== null && value !== undefined &&
  value !== "" && Number.isFinite(Number(value));
const normalizeAddress = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const EVM_ADDRESS_RE = /^0x[a-f0-9]{40}$/;
const isValidEvmAddress = value => EVM_ADDRESS_RE.test(normalizeAddress(value));

const BURN_OR_NULL_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead"
]);

export function isExcludedSystemAddress(address) {
  return BURN_OR_NULL_ADDRESSES.has(normalizeAddress(address));
}

/**
 * Required evidence:
 * - at least five closed-token observations;
 * - realized PnL, win rate, median return and rug exposure;
 * - at least 80% source coverage.
 *
 * The score uses only bounded, explainable contributions. Absolute PnL size
 * is intentionally not rewarded because wallet sizes are not comparable.
 */
export function evaluateWalletQuality(wallet) {
  const address = normalizeAddress(wallet && wallet.address);
  const chain = typeof (wallet && wallet.chain) === "string" ? wallet.chain.trim().toLowerCase() : "";
  if (!isValidEvmAddress(address) || chain !== "bsc") {
    return {
      status: "unknown",
      score: null,
      reasons: ["钱包地址格式无效，或链不是当前已验证的 BSC"],
      evidenceComplete: false
    };
  }
  if (isExcludedSystemAddress(address)) {
    return { status: "excluded", score: null, reasons: ["零地址或销毁地址不作为普通钱包质量样本"], evidenceComplete: false };
  }

  const closedTokenCount = Number(wallet.closedTokenCount);
  const winRatePct = Number(wallet.winRatePct);
  const realizedPnlUSD = Number(wallet.realizedPnlUSD);
  const medianReturnPct = Number(wallet.medianReturnPct);
  const rugExposurePct = Number(wallet.rugExposurePct);
  const dataCoveragePct = Number(wallet.dataCoveragePct);
  const required = [
    Number.isInteger(closedTokenCount) && closedTokenCount >= 5,
    finiteNumber(wallet.winRatePct) && winRatePct >= 0 && winRatePct <= 100,
    finiteNumber(wallet.realizedPnlUSD),
    finiteNumber(wallet.medianReturnPct),
    finiteNumber(wallet.rugExposurePct) && rugExposurePct >= 0 && rugExposurePct <= 100,
    finiteNumber(wallet.dataCoveragePct) && dataCoveragePct >= 80 && dataCoveragePct <= 100
  ];
  const missing = [];
  if (!required[0]) missing.push("已完成代币样本不足5个");
  if (!required[1]) missing.push("胜率缺失或超出有效范围");
  if (!required[2]) missing.push("已实现盈亏数据缺失");
  if (!required[3]) missing.push("收益中位数数据缺失");
  if (!required[4]) missing.push("高风险/归零代币暴露比例缺失或无效");
  if (!required[5]) missing.push("数据覆盖率低于80%或缺失");
  if (missing.length) {
    return { status: "unknown", score: null, reasons: missing, evidenceComplete: false };
  }

  const score = Math.round(clamp(
    40 +
    winRatePct * 0.30 +
    (realizedPnlUSD > 0 ? 10 : realizedPnlUSD < 0 ? -10 : 0) +
    clamp(medianReturnPct, -50, 50) * 0.20 -
    rugExposurePct * 0.70 +
    Math.min(closedTokenCount, 20) * 0.5,
    0, 100
  ));
  const reasons = [
    `历史胜率 ${winRatePct}%（样本 ${closedTokenCount} 个已完成代币）`,
    `已实现盈亏为${realizedPnlUSD > 0 ? "正" : realizedPnlUSD < 0 ? "负" : "零"}`,
    `收益中位数 ${medianReturnPct}%`,
    `高风险/归零代币暴露 ${rugExposurePct}%`,
    `数据覆盖率 ${dataCoveragePct}%`
  ];

  let status = score >= 70 && realizedPnlUSD > 0 ? "higher_quality" : score >= 50 ? "watch" : "weak";
  if (realizedPnlUSD < 0 && score >= 70) reasons.push("总已实现盈亏为负，不授予 higher_quality 历史质量标签");
  if (rugExposurePct >= 50 || (realizedPnlUSD < 0 && winRatePct < 25)) {
    status = "avoid";
    reasons.push("触发保守风险条件：高风险代币暴露过高，或历史胜率与已实现盈亏同时偏弱");
  }
  return { status, score, reasons, evidenceComplete: true };
}

/**
 * Summarize an early-buyer cohort. Shared funding/synchronized activity is
 * correlation evidence only; it does not establish common ownership.
 */
export function analyzeEarlyBuyerCohort(wallets, options = {}) {
  const input = Array.isArray(wallets) ? wallets : [];
  const seen = new Set();
  const cohort = [];
  for (const item of input) {
    const address = normalizeAddress(item && item.address);
    if (!isValidEvmAddress(address) || isExcludedSystemAddress(address) || seen.has(address)) continue;
    seen.add(address);
    cohort.push({ ...item, address });
  }

  const knownPositions = cohort.filter(item =>
    item.holdingStatus === "holding" || item.holdingStatus === "sold"
  );
  const holdingCount = knownPositions.filter(item => item.holdingStatus === "holding").length;
  const retentionRatePct = knownPositions.length >= 5
    ? Math.round(holdingCount / knownPositions.length * 10000) / 100
    : null;

  const countGroups = field => {
    const counts = new Map();
    for (const item of cohort) {
      const key = typeof item[field] === "string" ? item[field].trim() : "";
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.values()].sort((a, b) => b - a);
  };
  const largestFundingCluster = countGroups("fundingSourceId")[0] || 0;
  const largestSynchronizedGroup = countGroups("synchronizedBuyGroupId")[0] || 0;
  const reasons = [];
  const minClusterSize = Number.isInteger(options.minClusterSize) && options.minClusterSize >= 2
    ? options.minClusterSize : 3;

  if (retentionRatePct === null) {
    reasons.push("已知持仓状态不足5个钱包，早期买家留存率暂不可判断");
  } else if (retentionRatePct < 40) {
    reasons.push("早期买家留存率低于40%，存在集中退出迹象");
  }
  if (largestFundingCluster >= minClusterSize) {
    reasons.push(`${largestFundingCluster}个早期钱包共享同一资金来源标记，需核查关联性（不代表同一控制人）`);
  }
  if (largestSynchronizedGroup >= minClusterSize) {
    reasons.push(`${largestSynchronizedGroup}个早期钱包出现同步买入标记，需核查是否为协调行为`);
  }

  return {
    cohortSize: cohort.length,
    knownPositionCount: knownPositions.length,
    holdingCount,
    soldCount: knownPositions.length - holdingCount,
    retentionRatePct,
    largestFundingCluster,
    largestSynchronizedGroup,
    status: reasons.some(reason => reason.includes("低于40%")) ? "risk_review"
      : reasons.some(reason => reason.includes("共享") || reason.includes("同步")) ? "correlation_review"
      : retentionRatePct === null ? "insufficient" : "no_obvious_cohort_flag",
    reasons
  };
}
