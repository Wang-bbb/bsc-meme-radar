const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeEntity(value) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function normalizeSource(value) {
  return typeof value === "string" ? value.trim() : "";
}

function rankScore(rank, listSize) {
  const r = finiteNumber(rank);
  const size = finiteNumber(listSize);
  if (r == null || size == null || r < 1 || size < 1 || r > size) return null;
  return Math.round(1000 * (1 - (r - 1) / size)) / 10;
}

/**
 * Evaluate manually/externally mapped narrative observations.
 * Only declared, healthy sources contribute. Momentum is compared over the
 * same source set in both windows so a change in source coverage cannot
 * masquerade as an increase in topic interest.
 */
export function evaluateNarrativeEvidence({
  observations = [],
  sourceStatuses = [],
  nowMs = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  minSources = 2,
  expectedSources = [],
  minMomentum = 1.3
} = {}) {
  const now = finiteNumber(nowMs);
  const window = finiteNumber(windowMs);
  const threshold = finiteNumber(minMomentum);
  if (now == null || window == null || window <= 0) {
    throw new TypeError("nowMs and windowMs must be finite, and windowMs must be positive");
  }
  if (!Number.isInteger(minSources) || minSources < 2) {
    throw new TypeError("minSources must be an integer greater than or equal to 2");
  }
  if (threshold == null || threshold < 1) {
    throw new TypeError("minMomentum must be finite and at least 1");
  }
  if (!Array.isArray(observations) || !Array.isArray(sourceStatuses) || !Array.isArray(expectedSources)) {
    throw new TypeError("observations, sourceStatuses, and expectedSources must be arrays");
  }

  const expected = [...new Set(expectedSources.map(normalizeSource).filter(Boolean))];
  const statusBySource = new Map();
  for (const item of sourceStatuses) {
    const source = normalizeSource(item?.source);
    if (!source) continue;
    const status = String(item?.status ?? "unknown").trim().toLowerCase();
    if (!statusBySource.has(source)) {
      statusBySource.set(source, status);
    } else if (statusBySource.get(source) !== status) {
      // Conflicting health records for one source are ambiguous; fail closed.
      statusBySource.set(source, "conflict");
    }
  }

  const unavailableSources = expected.filter(source => statusBySource.get(source) !== "ok");
  const failedSources = [...unavailableSources];
  const healthyExpected = new Set(expected.filter(source => statusBySource.get(source) === "ok"));
  const groups = new Map();

  for (const item of observations) {
    const entity = normalizeEntity(item?.entity);
    const source = normalizeSource(item?.source);
    const at = finiteNumber(item?.observedAt);
    const score = rankScore(item?.rank, item?.listSize);
    if (!entity || !healthyExpected.has(source) || at == null || score == null ||
        at > now || at < now - window * 2) continue;

    let group = groups.get(entity);
    if (!group) groups.set(entity, group = { current: new Map(), previous: new Map() });
    const bucket = at >= now - window ? group.current : group.previous;
    bucket.set(source, Math.max(bucket.get(source) ?? 0, score));
  }

  const coverageComplete = expected.length >= minSources && unavailableSources.length === 0;
  const output = [];

  for (const [entity, group] of groups) {
    const currentSources = [...group.current.keys()].sort();
    const previousSources = [...group.previous.keys()].sort();
    const comparableSources = currentSources.filter(source => group.previous.has(source));
    const currentScore = [...group.current.values()].reduce((sum, value) => sum + value, 0);
    const previousScore = [...group.previous.values()].reduce((sum, value) => sum + value, 0);
    const comparableCurrentScore = comparableSources.reduce((sum, source) => sum + group.current.get(source), 0);
    const comparablePreviousScore = comparableSources.reduce((sum, source) => sum + group.previous.get(source), 0);
    const momentum = comparableSources.length >= minSources && comparablePreviousScore > 0
      ? Math.round((comparableCurrentScore / comparablePreviousScore) * 100) / 100
      : null;
    const enoughSpread = currentSources.length >= minSources;
    const enoughComparableHistory = comparableSources.length >= minSources && comparablePreviousScore > 0;
    const state = !enoughSpread || !coverageComplete
      ? "insufficient_coverage"
      : !enoughComparableHistory
        ? "warming_up"
        : momentum >= threshold
          ? "momentum_candidate"
          : "observed";

    output.push({
      entity,
      currentScore: Math.round(currentScore * 10) / 10,
      previousScore: Math.round(previousScore * 10) / 10,
      momentum,
      currentSourceCount: currentSources.length,
      currentSources,
      previousSourceCount: previousSources.length,
      previousSources,
      comparableSourceCount: comparableSources.length,
      comparableSources,
      failedSources,
      coverageComplete,
      state,
      tokenMatchStatus: "not_checked",
      safetyStatus: "not_checked",
      productionScoreImpact: false
    });
  }

  return output.sort((a, b) =>
    Number(b.state === "momentum_candidate") - Number(a.state === "momentum_candidate") ||
    (b.momentum ?? -1) - (a.momentum ?? -1) ||
    b.currentScore - a.currentScore
  );
}

export { DEFAULT_WINDOW_MS };
