/**
 * @module scheduler/lpt-splitter
 * @description LPT (Longest Processing Time) Bin-Packing Test Splitter, Flaky Test Quarantine Guard,
 *              and FinOps / Green-CI efficiency calculator.
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FinOpsMetrics,
  GitHubMatrixPayload,
  ImpactedTest,
  ParsedModule,
  TelemetryStore,
  TestShard,
  TestTelemetryRecord,
} from "../types.ts";

/**
 * Loads historical test timing and flakiness telemetry from `.vortex/telemetry.json` if present.
 */
export function loadTelemetryStore(workspaceDir: string, telemetryPath: string): TelemetryStore {
  const absPath = path.resolve(workspaceDir, telemetryPath);
  if (fs.existsSync(absPath)) {
    try {
      const raw = fs.readFileSync(absPath, "utf-8");
      const parsed = JSON.parse(raw) as TelemetryStore;
      if (parsed && typeof parsed.tests === "object") {
        return parsed;
      }
    } catch {
      // Fallback to empty store
    }
  }
  return { version: "1.0.0", tests: {} };
}

/**
 * Estimates the execution time of a test file in milliseconds when historical telemetry is absent,
 * based on AST test case count (`Deno.test` / `it`) and line count.
 */
export function estimateTestDurationMs(
  mod: ParsedModule | undefined,
  telemetry: TestTelemetryRecord | undefined,
): number {
  if (telemetry && telemetry.durationMs > 0) {
    return Math.round(telemetry.durationMs);
  }
  if (!mod) return 450;
  // Base cold-start overhead (200ms) + 120ms per test case + 2ms per source line
  return Math.max(150, 200 + mod.testCaseCount * 120 + mod.lineCount * 2);
}

/**
 * Greedy Longest Processing Time (LPT) Multi-Way Number Partitioning algorithm.
 * Sorts executable tests in descending order of duration and assigns each test to the shard
 * with the minimum accumulated load, minimizing parallel makespan ($C_{\max}$).
 */
export function scheduleShardsLpt(
  executableTests: ImpactedTest[],
  maxShards: number,
): {
  shards: TestShard[];
  matrix: GitHubMatrixPayload;
  makespanMs: number;
} {
  if (executableTests.length === 0) {
    return {
      shards: [],
      matrix: { include: [] },
      makespanMs: 0,
    };
  }

  const effectiveShardCount = Math.max(1, Math.min(maxShards, executableTests.length));

  // Sort tests by descending estimated duration (tie-breaker: deterministic path order)
  const sorted = [...executableTests].sort((a, b) => {
    if (b.estimatedDurationMs !== a.estimatedDurationMs) {
      return b.estimatedDurationMs - a.estimatedDurationMs;
    }
    return a.testFile.localeCompare(b.testFile);
  });

  const buckets: Array<{ files: string[]; loadMs: number }> = Array.from(
    { length: effectiveShardCount },
    () => ({ files: [], loadMs: 0 }),
  );

  for (const test of sorted) {
    // Find bucket with minimum current load
    let minIdx = 0;
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i].loadMs < buckets[minIdx].loadMs) {
        minIdx = i;
      }
    }
    buckets[minIdx].files.push(test.testFile);
    buckets[minIdx].loadMs += test.estimatedDurationMs;
  }

  const shards: TestShard[] = buckets
    .filter((b) => b.files.length > 0)
    .map((b, idx) => ({
      shard_id: idx + 1,
      test_files: b.files.join(" "),
      files: b.files,
      estimated_ms: Math.round(b.loadMs),
    }));

  const makespanMs = shards.reduce((max, s) => Math.max(max, s.estimated_ms), 0);

  return {
    shards,
    matrix: { include: shards },
    makespanMs,
  };
}

/**
 * Calculates FinOps, Green-CI carbon reduction, and Blast-Radius scores.
 */
export function calculateFinOpsMetrics(params: {
  allTestModules: ParsedModule[];
  telemetryStore: TelemetryStore;
  selectedTests: ImpactedTest[];
  quarantinedTests: ImpactedTest[];
  makespanMs: number;
  runnerCostPerMinUsd: number;
  changedFilesCount: number;
  totalModulesCount: number;
  triggeredFailSafe: boolean;
}): FinOpsMetrics {
  const {
    allTestModules,
    telemetryStore,
    selectedTests,
    quarantinedTests,
    makespanMs,
    runnerCostPerMinUsd,
    changedFilesCount,
    totalModulesCount,
    triggeredFailSafe,
  } = params;

  const totalTestsInRepo = allTestModules.length;
  const selectedTestsCount = selectedTests.length;
  const quarantinedTestsCount = quarantinedTests.length;
  const skippedTestsCount = Math.max(
    0,
    totalTestsInRepo - selectedTestsCount - quarantinedTestsCount,
  );

  // Baseline duration: running all test files sequentially without AST pruning or LPT sharding
  const baselineDurationMs = allTestModules.reduce((acc, mod) => {
    const rec = telemetryStore.tests[mod.filePath];
    return acc + estimateTestDurationMs(mod, rec);
  }, 0);

  const selectedComputeMs = selectedTests.reduce((acc, t) => acc + t.estimatedDurationMs, 0);
  const computeSavedMs = Math.max(0, baselineDurationMs - selectedComputeMs);
  const wallClockSavedMs = Math.max(0, baselineDurationMs - makespanMs);

  const timeReductionPercent = baselineDurationMs > 0
    ? Math.round((wallClockSavedMs / baselineDurationMs) * 1000) / 10
    : 0;

  // FinOps USD saved based on runner compute minutes avoided
  const savedMinutes = computeSavedMs / 60000;
  const estimatedCostSavedUsd = Math.round(savedMinutes * runnerCostPerMinUsd * 10000) / 10000;

  // Green-CI CO2e saved (approx 2.4g CO2e per vCPU minute on cloud CI runners)
  const estimatedCo2SavedGrams = Math.round(savedMinutes * 2.4 * 100) / 100;

  // Blast-radius score (0 - 100)
  let blastRadiusScore = 0;
  if (triggeredFailSafe) {
    blastRadiusScore = 100;
  } else if (totalTestsInRepo > 0) {
    const testRatio = (selectedTestsCount + quarantinedTestsCount) / totalTestsInRepo;
    const fileRatio = totalModulesCount > 0 ? changedFilesCount / totalModulesCount : 0;
    blastRadiusScore = Math.min(100, Math.round((testRatio * 0.75 + fileRatio * 0.25) * 100));
  }

  return {
    totalTestsInRepo,
    selectedTestsCount,
    skippedTestsCount,
    quarantinedTestsCount,
    baselineDurationMs,
    optimizedMakespanMs: makespanMs,
    timeSavedMs: wallClockSavedMs,
    timeReductionPercent,
    estimatedCostSavedUsd,
    estimatedCo2SavedGrams,
    blastRadiusScore,
  };
}
