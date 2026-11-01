/**
 * @module scheduler/lpt-splitter
 * @description LPT (Longest Processing Time) Bin-Packing Test Splitter, Predictive Fail-Fast
 *              Intra-Shard Prioritizer, EWMA Telemetry Auto-Learner, and FinOps Calculator (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeRelativeFilePath, resolveSafeWorkspacePath } from "../security.ts";
import type {
  FinOpsMetrics,
  GitHubMatrixPayload,
  ImpactedTest,
  ParsedModule,
  TelemetryStore,
  TestRunObservation,
  TestShard,
  TestTelemetryRecord,
} from "../types.ts";

/**
 * Loads historical test timing and flakiness telemetry from `.vortex/telemetry.json` if present.
 */
export function loadTelemetryStore(workspaceDir: string, telemetryPath: string): TelemetryStore {
  try {
    const absPath = resolveSafeWorkspacePath(workspaceDir, telemetryPath);
    if (fs.existsSync(absPath)) {
      const raw = fs.readFileSync(absPath, "utf-8");
      const parsed = JSON.parse(raw) as TelemetryStore;
      if (parsed && typeof parsed.tests === "object") {
        return parsed;
      }
    }
  } catch {
    // Fallback to empty store on missing/invalid/out-of-bounds path
  }
  return { version: "1.1.0", tests: {} };
}

/**
 * Persists the updated EWMA telemetry store to `.vortex/telemetry.json`.
 */
export function saveTelemetryStore(
  workspaceDir: string,
  telemetryPath: string,
  store: TelemetryStore,
): void {
  try {
    const absPath = resolveSafeWorkspacePath(workspaceDir, telemetryPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(store, null, 2) + "\n", "utf-8");
  } catch {
    // Ignore read-only filesystem or blocked path traversal
  }
}

/**
 * Parses test run observations from either a JSON report or a JUnit XML report.
 */
export function parseTestReportObservations(rawContent: string): TestRunObservation[] {
  const trimmed = rawContent.trim();
  if (!trimmed) return [];

  // 1. JSON format (`[{ "testFile": "tests/a.test.ts", "durationMs": 320, "passed": true }]`)
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : (parsed.observations ?? parsed.tests ?? []);
      if (Array.isArray(list)) {
        return list
          .filter((item) => item && typeof (item.testFile ?? item.file) === "string")
          .map((item) => ({
            testFile: String(item.testFile ?? item.file).replace(/\\/g, "/"),
            durationMs: Math.max(1, Number(item.durationMs ?? item.duration ?? 250)),
            passed: item.passed !== false,
            flakyOrRetried: Boolean(item.flakyOrRetried ?? item.flaky ?? item.retried),
          }));
      }
    } catch {
      // Fallback to XML check
    }
  }

  // 2. JUnit XML format (`<testcase classname="tests/a.test.ts" name="..." time="0.42">`)
  if (trimmed.includes("<testcase")) {
    const byFile = new Map<
      string,
      { durationMs: number; sawPass: boolean; sawFail: boolean; flakyAttr: boolean }
    >();
    const testcaseRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let m: RegExpExecArray | null;
    while ((m = testcaseRegex.exec(trimmed)) !== null) {
      const attrs = m[1];
      const inner = m[2] ?? "";
      const fileMatch = /(?:file|classname)=["']([^"']+)["']/.exec(attrs);
      if (!fileMatch) continue;
      const testFile = fileMatch[1].replace(/\\/g, "/");
      const timeMatch = /time=["']([0-9.]+)["']/.exec(attrs);
      const durationMs = timeMatch ? Math.max(1, Math.round(Number(timeMatch[1]) * 1000)) : 200;
      const failed = /<(?:failure|error)\b/.test(inner);
      const flakyAttr = /flaky=["']true["']/.test(attrs) || /<flakyFailure\b/.test(inner);

      const prev = byFile.get(testFile) ?? {
        durationMs: 0,
        sawPass: false,
        sawFail: false,
        flakyAttr: false,
      };
      prev.durationMs += durationMs;
      if (failed) prev.sawFail = true;
      else prev.sawPass = true;
      if (flakyAttr) prev.flakyAttr = true;
      byFile.set(testFile, prev);
    }

    const observations: TestRunObservation[] = [];
    for (const [testFile, stats] of byFile.entries()) {
      observations.push({
        testFile,
        durationMs: stats.durationMs,
        passed: !stats.sawFail || stats.sawPass,
        flakyOrRetried: stats.flakyAttr || (stats.sawFail && stats.sawPass),
      });
    }
    return observations;
  }

  return [];
}

/**
 * Updates the historical telemetry store using an Exponentially Weighted Moving Average (EWMA):
 * $T_{\text{new}} = \alpha \cdot T_{\text{obs}} + (1 - \alpha) \cdot T_{\text{prev}}$
 * $F_{\text{new}} = \alpha \cdot S_{\text{flaky}} + (1 - \alpha) \cdot F_{\text{prev}}$
 */
export function updateTelemetryStoreEwma(
  store: TelemetryStore,
  observations: TestRunObservation[],
  alpha = 0.3,
): TelemetryStore {
  const clampedAlpha = Math.max(0.05, Math.min(0.95, alpha));
  const nowIso = new Date().toISOString();
  const updatedTests: Record<string, TestTelemetryRecord> = { ...store.tests };

  for (const obs of observations) {
    const normPath = obs.testFile.replace(/\\/g, "/");
    if (!isSafeRelativeFilePath(normPath)) continue;
    const existing = updatedTests[normPath];
    const flakySample = obs.flakyOrRetried ? 1.0 : 0.0;

    if (!existing) {
      updatedTests[normPath] = {
        durationMs: Math.round(obs.durationMs),
        flakinessRate: Math.round(flakySample * 1000) / 1000,
        runsCount: 1,
        lastUpdated: nowIso,
      };
    } else {
      const newDuration = Math.round(
        clampedAlpha * obs.durationMs + (1 - clampedAlpha) * existing.durationMs,
      );
      const newFlakiness = Math.round(
        (clampedAlpha * flakySample + (1 - clampedAlpha) * existing.flakinessRate) * 1000,
      ) / 1000;

      updatedTests[normPath] = {
        durationMs: Math.max(1, newDuration),
        flakinessRate: Math.max(0, Math.min(1, newFlakiness)),
        runsCount: (existing.runsCount ?? 1) + 1,
        lastUpdated: nowIso,
      };
    }
  }

  return {
    version: "1.1.0",
    tests: updatedTests,
  };
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
  return Math.max(150, 200 + mod.testCaseCount * 120 + mod.lineCount * 2);
}

/**
 * Computes a Predictive Fail-Fast Priority Score for ordering tests *within* a shard.
 * Higher score runs first:
 * - Direct hop distance (`depth === 0` or `1`) gets highest priority (+1000 / (depth + 1))
 * - Recent non-quarantined instability gets +200 * flakinessScore
 * - Faster unit tests run before slower integration tests (+100 / (1 + durationSec))
 */
export function computeFailFastPriorityScore(test: ImpactedTest): number {
  const depthScore = 1000 / (Math.max(0, test.depth) + 1);
  const instabilityBoost = test.flakinessScore * 200;
  const speedBoost = 100 / (1 + test.estimatedDurationMs / 1000);
  return Math.round((depthScore + instabilityBoost + speedBoost) * 100) / 100;
}

/**
 * Greedy Longest Processing Time (LPT) Multi-Way Number Partitioning algorithm
 * combined with Predictive Fail-Fast Intra-Shard Ordering.
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

  // Step 1: Sort descending by estimated duration for optimal LPT bin-packing across shards
  const sortedForPacking = [...executableTests].sort((a, b) => {
    if (b.estimatedDurationMs !== a.estimatedDurationMs) {
      return b.estimatedDurationMs - a.estimatedDurationMs;
    }
    return a.testFile.localeCompare(b.testFile);
  });

  const buckets: Array<{ items: ImpactedTest[]; loadMs: number }> = Array.from(
    { length: effectiveShardCount },
    () => ({ items: [], loadMs: 0 }),
  );

  for (const test of sortedForPacking) {
    test.failFastPriorityScore = computeFailFastPriorityScore(test);
    let minIdx = 0;
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i].loadMs < buckets[minIdx].loadMs) {
        minIdx = i;
      }
    }
    buckets[minIdx].items.push(test);
    buckets[minIdx].loadMs += test.estimatedDurationMs;
  }

  // Step 2: Inside each shard, order tests by Fail-Fast Priority Score (descending)
  // so direct-impact and fast tests fail within the first seconds of shard execution
  const shards: TestShard[] = buckets
    .filter((b) => b.items.length > 0)
    .map((b, idx) => {
      const orderedItems = [...b.items].sort((x, y) => {
        const scoreX = x.failFastPriorityScore ?? computeFailFastPriorityScore(x);
        const scoreY = y.failFastPriorityScore ?? computeFailFastPriorityScore(y);
        if (scoreY !== scoreX) return scoreY - scoreX;
        return x.testFile.localeCompare(y.testFile);
      });
      const files = orderedItems.map((t) => t.testFile);
      return {
        shard_id: idx + 1,
        test_files: files.join(" "),
        files,
        estimated_ms: Math.round(b.loadMs),
      };
    });

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
  prunedBarrelEdgesCount?: number;
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
    prunedBarrelEdgesCount = 0,
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

  const savedMinutes = computeSavedMs / 60000;
  const estimatedCostSavedUsd = Math.round(savedMinutes * runnerCostPerMinUsd * 10000) / 10000;
  const estimatedCo2SavedGrams = Math.round(savedMinutes * 2.4 * 100) / 100;

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
    prunedBarrelEdgesCount,
    baselineDurationMs,
    optimizedMakespanMs: makespanMs,
    timeSavedMs: wallClockSavedMs,
    timeReductionPercent,
    estimatedCostSavedUsd,
    estimatedCo2SavedGrams,
    blastRadiusScore,
  };
}
