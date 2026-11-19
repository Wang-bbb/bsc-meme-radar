import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNarrativeEvidence } from "../narrative-observation.js";

const now = 1_800_000_000_000;
const row = (source, observedAt, rank = 1, listSize = 10) => ({
  entity: "  DOG   STORY ", source, observedAt, rank, listSize
});
const statuses = [
  { source: "weibo", status: "ok" },
  { source: "douyin", status: "ok" }
];

test("requires cross-source coverage and previous-window evidence", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    expectedSources: ["weibo", "douyin"],
    sourceStatuses: statuses,
    observations: [row("weibo", now - 1000), row("douyin", now - 2000)]
  });
  assert.equal(result[0].entity, "dog story");
  assert.equal(result[0].state, "warming_up");
  assert.equal(result[0].momentum, null);
  assert.equal(result[0].productionScoreImpact, false);
});

test("marks momentum only when the same cross-source set accelerates", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    expectedSources: ["weibo", "douyin"],
    sourceStatuses: statuses,
    observations: [
      row("weibo", now - 7 * 60 * 60 * 1000, 8),
      row("douyin", now - 7 * 60 * 60 * 1000, 8),
      row("weibo", now - 1000, 1),
      row("douyin", now - 2000, 1)
    ]
  });
  assert.equal(result[0].state, "momentum_candidate");
  assert.equal(result[0].comparableSourceCount, 2);
  assert.ok(result[0].momentum >= 1.3);
});

test("unexpected sources cannot satisfy the cross-source requirement", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    expectedSources: ["weibo", "douyin"],
    sourceStatuses: statuses,
    observations: [row("weibo", now - 1000), row("unconfigured-source", now - 2000)]
  });
  assert.equal(result[0].currentSourceCount, 1);
  assert.equal(result[0].state, "insufficient_coverage");
});

test("newly appearing sources do not create artificial momentum", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    expectedSources: ["weibo", "douyin", "x"],
    sourceStatuses: [
      ...statuses,
      { source: "x", status: "ok" }
    ],
    observations: [
      row("weibo", now - 7 * 60 * 60 * 1000, 8),
      row("weibo", now - 1000, 1),
      row("douyin", now - 2000, 1),
      row("x", now - 3000, 1)
    ]
  });
  assert.equal(result[0].currentSourceCount, 3);
  assert.equal(result[0].comparableSourceCount, 1);
  assert.equal(result[0].momentum, null);
  assert.equal(result[0].state, "warming_up");
});

test("failed or missing upstream source status forces insufficient coverage", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    observations: [row("weibo", now - 1000), row("douyin", now - 2000)],
    expectedSources: ["weibo", "douyin", "x"],
    sourceStatuses: [
      { source: "weibo", status: "ok" },
      { source: "douyin", status: "ok" },
      { source: "x", status: "failed" }
    ]
  });
  assert.equal(result[0].state, "insufficient_coverage");
  assert.deepEqual(result[0].failedSources, ["x"]);
});

test("rejects invalid ranks, future observations, and stale observations", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    expectedSources: ["weibo", "douyin"],
    sourceStatuses: statuses,
    observations: [
      row("weibo", now - 1000, 0),
      row("douyin", now + 1000),
      row("weibo", now - 13 * 60 * 60 * 1000)
    ]
  });
  assert.deepEqual(result, []);
});

test("invalid window and unsafe thresholds are rejected", () => {
  assert.throws(() => evaluateNarrativeEvidence({ nowMs: now, windowMs: 0 }), TypeError);
  assert.throws(() => evaluateNarrativeEvidence({ nowMs: now, minSources: 1 }), TypeError);
  assert.throws(() => evaluateNarrativeEvidence({ nowMs: now, minSources: 0 }), TypeError);
  assert.throws(() => evaluateNarrativeEvidence({ nowMs: now, minMomentum: 0.9 }), TypeError);
});

test("empty expected sources never imply complete coverage", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    observations: [row("weibo", now - 1000), row("douyin", now - 2000)]
  });
  assert.deepEqual(result, []);
});


test("conflicting duplicate source health states fail closed", () => {
  const result = evaluateNarrativeEvidence({
    nowMs: now,
    expectedSources: ["weibo", "douyin"],
    sourceStatuses: [
      { source: "weibo", status: "ok" },
      { source: "weibo", status: "failed" },
      { source: "douyin", status: "ok" }
    ],
    observations: [
      row("weibo", now - 1000),
      row("douyin", now - 1000),
      row("weibo", now - 7 * 60 * 60 * 1000),
      row("douyin", now - 7 * 60 * 60 * 1000)
    ]
  });
  assert.equal(result[0].coverageComplete, false);
  assert.equal(result[0].state, "insufficient_coverage");
  assert.deepEqual(result[0].failedSources, ["weibo"]);
});
