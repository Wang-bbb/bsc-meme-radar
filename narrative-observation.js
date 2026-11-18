const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeEntity(value) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\\s+/g, " ");
}

function rankScore(rank, listSize) {
  const r = finiteNumber(rank);
  const size = finiteNumber(listSize);
  if (r == null || size == null || r < 1 || size < 1 || r > size) return null;
  return Math.round(1000 * (1 - (r - 1) / Math.max(size, 1))) / 10;
}

/**
 * Evaluates manually/externally mapped narrative observations without fetching
 * social platforms, matching token contracts, or changing production scores.
 *
 * Each observation: { entity, source, observedAt, rank, listSize }.
 * sourceStatuses: [{ source, status: "ok"|"failed"|"disabled" }]
 */
export function evaluateNarrativeEvidence({
  observations = [],
  sourceStatuses = [],
  nowMs = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  minSources = 2,
  minMomentum = 1.3
} = {}) {
  const now = finiteNumber(nowMs);
  const window = finiteNumber(windowMs);
  if (now == null || window == null || window <= 0) {
    throw new TypeError("nowMs and windowMs must be finite, and windowMs must be positive");
  }

  const statusBySource = new Map();
  for (const item of sourceStatuses) {
    if (item?.source) statusBySource.set(String(item.source), String(item.status ?? "unknown"));
  }

  const groups = new Map();
  for (const item of observations) {
    const entity = normalizeEntity(item?.entity);
    const source = String(item?.source ?? "").trim();
    const at = finiteNumber(item?.observedAt);
    const score = rankScore(item?.rank, item?.listSize);
    if (!entity || !source || at == null || score == null || at > now || at < now - window * 2) continue;
    let group = groups.get(entity);
    if (!group) groups.set(entity, group = { current: new Map(), previous: new Map() });
    const bucket = at >= now - window ? group.current : group.previous;
    bucket.set(source, Math.max(bucket.get(source) ?? 0, score));
  }

  const failedSources = [...statusBySource.entries()]
    .filter(([, status]) => status === "failed")
    .map(([source]) => source);
  const output = [];

  for (const [entity, group] of groups) {
    const currentSources = [...group.current.keys()];
    const previousSources = [...group.previous.keys()];
    const currentScore = [...group.current.values()].reduce((sum, value) => sum + value, 0);
    const previousScore = [...group.previous.values()].reduce((sum, value) => sum + value, 0);
    const momentum = previousScore > 0 ? Math.round((currentScore / previousScore) * 100) / 100 : null;
    const coverageComplete = failedSources.length === 0;
    const enoughSpread = currentSources.length >= minSources;
    const state = !enoughSpread || !coverageComplete
      ? "insufficient_coverage"
      : momentum == null
        ? "warming_up"
        : momentum >= minMomentum
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
