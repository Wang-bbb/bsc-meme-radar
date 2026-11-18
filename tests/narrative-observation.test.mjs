import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNarrativeEvidence } from "../narrative-observation.js";

const now = 1_800_000_000_000;
const row = (source, observedAt, rank = 1, listSize = 10) => ({
  entity: "  DOG   STORY ", source, observedAt, rank, listSize
});

test("requires cross-platform coverage and previous-window evidence", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    observations: [row("weibo", now - 1000), row("douyin", now - 2000)]
  });
  assert.equal(result[0].entity, "dog story");
  assert.equal(result[0].state, "warming_up");
  assert.equal(result[0].momentum, null);
  assert.equal(result[0].productionScoreImpact, false);
});

test("marks momentum only when current cross-source score accelerates", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    observations: [
      row("weibo", now - 7 * 60 * 60 * 1000, 8),
      row("douyin", now - 7 * 60 * 60 * 1000, 8),
      row("weibo", now - 1000, 1),
      row("douyin", now - 2000, 1)
    ]
  });
  assert.equal(result[0].state, "momentum_candidate");
  assert.ok(result[0].momentum >= 1.3);
});

test("failed upstream source forces insufficient coverage", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    observations: [row("weibo", now - 1000), row("douyin", now - 2000)],
    sourceStatuses: [{ source: "x", status: "failed" }]
  });
  assert.equal(result[0].state, "insufficient_coverage");
  assert.deepEqual(result[0].failedSources, ["x"]);
});

test("rejects invalid ranks, future observations, and stale observations", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    observations: [
      row("bad-rank", now - 1000, 0),
      row("future", now + 1000),
      row("stale", now - 13 * 60 * 60 * 1000)
    ]
  });
  assert.deepEqual(result, []);
});

test("invalid window is rejected", () => {
  assert.throws(() => evaluateNarrativeEvidence({ nowMs: now, windowMs: 0 }), TypeError);
});
