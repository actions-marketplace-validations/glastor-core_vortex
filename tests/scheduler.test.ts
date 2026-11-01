/**
 * @module tests/scheduler.test
 * @description Dedicated test suite for LPT Bin-Packing Scheduler, Flaky Quarantine, and Mermaid Reporter.
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import assert from "node:assert/strict";
import {
  calculateFinOpsMetrics,
  estimateTestDurationMs,
  scheduleShardsLpt,
} from "../src/scheduler/lpt-splitter.ts";
import { buildMermaidImpactGraph, formatDuration } from "../src/reporters/finops-reporter.ts";
import type { ImpactedTest, VortexAnalysisResult } from "../src/types.ts";

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

Deno.test("Scheduler: estimates fallback test duration from AST test case and line counts", () => {
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
  // 200 + 5*120 + 100*2 = 1000ms
  assert.equal(duration, 1000);
});

Deno.test("Reporter: formats durations and builds valid Mermaid blast-radius diagram", () => {
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(2500), "2.50s");
  assert.equal(formatDuration(125000), "2m 5s");

  const mockResult: VortexAnalysisResult = {
    version: "1.0.0",
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
      telemetryStore: { version: "1.0.0", tests: {} },
      selectedTests: [],
      quarantinedTests: [],
      makespanMs: 420,
      runnerCostPerMinUsd: 0.016,
      changedFilesCount: 1,
      totalModulesCount: 6,
      triggeredFailSafe: false,
    }),
  };

  const mermaid = buildMermaidImpactGraph(mockResult);
  assert.equal(mermaid.includes("flowchart LR"), true);
  assert.equal(mermaid.includes("dag.ts"), true);
  assert.equal(mermaid.includes("vortex.test.ts"), true);
});
