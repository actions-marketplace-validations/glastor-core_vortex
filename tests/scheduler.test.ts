/**
 * @module tests/scheduler.test
 * @description Dedicated test suite for LPT Bin-Packing Scheduler, EWMA Telemetry Auto-Learner,
 *              Fail-Fast Priority Scoring, and Mermaid Reporter (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import assert from "node:assert/strict";
import {
  calculateFinOpsMetrics,
  computeFailFastPriorityScore,
  estimateTestDurationMs,
  parseTestReportObservations,
  scheduleShardsLpt,
  updateTelemetryStoreEwma,
} from "../src/scheduler/lpt-splitter.ts";
import { buildMermaidImpactGraph, formatDuration } from "../src/reporters/finops-reporter.ts";
import type { ImpactedTest, TelemetryStore, VortexAnalysisResult } from "../src/types.ts";

Deno.test("Scheduler: returns empty matrix when zero tests are impacted", () => {
  const { shards, matrix, makespanMs } = scheduleShardsLpt([], 4);
  assert.equal(shards.length, 0);
  assert.equal(matrix.include.length, 0);
  assert.equal(makespanMs, 0);
});

Deno.test("Scheduler: caps active shards to number of impacted tests", () => {
  const singleTest: ImpactedTest[] = [
    {
      testFile: "tests/only.test.ts",
      impactChain: ["src/core.ts", "tests/only.test.ts"],
      depth: 1,
      estimatedDurationMs: 350,
      flakinessScore: 0,
      quarantined: false,
    },
  ];
  const { shards, makespanMs } = scheduleShardsLpt(singleTest, 8);
  assert.equal(shards.length, 1);
  assert.equal(shards[0].shard_id, 1);
  assert.equal(makespanMs, 350);
});

Deno.test("Scheduler: estimates fallback test duration and Fail-Fast priority scores", () => {
  const duration = estimateTestDurationMs(
    {
      filePath: "tests/sample.test.ts",
      language: "typescript",
      isTestFile: true,
      imports: [],
      symbols: [],
      lineCount: 100,
      testCaseCount: 5,
    },
    undefined,
  );
  assert.equal(duration, 1000);

  const directFastScore = computeFailFastPriorityScore({
    testFile: "tests/direct.test.ts",
    impactChain: ["tests/direct.test.ts"],
    depth: 0,
    estimatedDurationMs: 150,
    flakinessScore: 0.1,
    quarantined: false,
  });
  const deepSlowScore = computeFailFastPriorityScore({
    testFile: "tests/deep.test.ts",
    impactChain: ["a", "b", "c", "tests/deep.test.ts"],
    depth: 3,
    estimatedDurationMs: 2500,
    flakinessScore: 0,
    quarantined: false,
  });
  assert.equal(directFastScore > deepSlowScore, true);
});

Deno.test("TelemetryLearner: parses JUnit XML & JSON reports and applies EWMA smoothing", () => {
  const junitXml = `
    <testsuites>
      <testsuite name="deno test">
        <testcase classname="tests/auth.test.ts" name="login" time="0.500" />
        <testcase classname="tests/flaky.test.ts" name="race" time="0.300">
          <failure message="timeout" />
        </testcase>
        <testcase classname="tests/flaky.test.ts" name="race" time="0.200" />
      </testsuite>
    </testsuites>
  `;

  const observations = parseTestReportObservations(junitXml);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].testFile, "tests/auth.test.ts");
  assert.equal(observations[0].durationMs, 500);
  assert.equal(observations[0].flakyOrRetried, false);

  // `tests/flaky.test.ts` had both a failure and a pass in the same run -> detected as flaky retry!
  assert.equal(observations[1].testFile, "tests/flaky.test.ts");
  assert.equal(observations[1].flakyOrRetried, true);

  const initialStore: TelemetryStore = {
    version: "1.1.0",
    tests: {
      "tests/auth.test.ts": { durationMs: 1000, flakinessRate: 0.0, runsCount: 2 },
    },
  };

  // With alpha = 0.3: new duration = 0.3 * 500 + 0.7 * 1000 = 150 + 700 = 850ms
  const updated = updateTelemetryStoreEwma(initialStore, observations, 0.3);
  assert.equal(updated.tests["tests/auth.test.ts"].durationMs, 850);
  assert.equal(updated.tests["tests/auth.test.ts"].runsCount, 3);
  assert.equal(updated.tests["tests/flaky.test.ts"].flakinessRate, 1);
});

Deno.test("Reporter: formats durations and builds valid Mermaid blast-radius diagram with pruned edges", () => {
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(2500), "2.50s");
  assert.equal(formatDuration(125000), "2m 5s");

  const mockResult: VortexAnalysisResult = {
    version: "1.1.0",
    timestamp: "2026-11-01T00:00:00.000Z",
    analysisDurationMs: 12,
    baseRef: "HEAD~1",
    headRef: "HEAD",
    executionMode: "surgical",
    modeReason: "Surgical test execution",
    shouldRun: true,
    changedFiles: [
      {
        filePath: "src/graph/dag.ts",
        status: "M",
        hunks: [],
        isCommentOrFormatOnly: false,
      },
    ],
    triggeredFailSafeFiles: [],
    mutatedSymbols: [],
    prunedEdges: [
      {
        fromFile: "src/graph/dag.ts",
        toFile: "tests/scheduler.test.ts",
        importedSymbols: ["unusedHelper"],
        mutatedSymbolsInSource: ["DependencyDag"],
      },
    ],
    impactedTests: [
      {
        testFile: "tests/vortex.test.ts",
        impactChain: ["src/graph/dag.ts", "tests/vortex.test.ts"],
        depth: 1,
        estimatedDurationMs: 420,
        flakinessScore: 0,
        quarantined: false,
      },
    ],
    quarantinedTests: [],
    shards: [],
    matrix: { include: [] },
    finops: calculateFinOpsMetrics({
      allTestModules: [],
      telemetryStore: { version: "1.1.0", tests: {} },
      selectedTests: [],
      quarantinedTests: [],
      prunedBarrelEdgesCount: 1,
      makespanMs: 420,
      runnerCostPerMinUsd: 0.016,
      changedFilesCount: 1,
      totalModulesCount: 6,
      triggeredFailSafe: false,
    }),
    governance: {
      detectedTicketIds: ["GLS-101"],
      maxBlastRadiusScore: 100,
      blastRadiusPassed: true,
      nemesisTargetFiles: ["src/graph/dag.ts", "tests/vortex.test.ts"],
    },
  };

  const mermaid = buildMermaidImpactGraph(mockResult);
  assert.equal(mermaid.includes("flowchart LR"), true);
  assert.equal(mermaid.includes("dag.ts"), true);
  assert.equal(mermaid.includes("vortex.test.ts"), true);
  assert.equal(mermaid.includes("pruned"), true);
});
