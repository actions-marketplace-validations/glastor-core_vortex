/**
 * @module main
 * @description Entrypoint and core orchestrator for Vortex — AST-Driven Predictive CI & Impact Graph Engine.
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import { loadConfig, VORTEX_VERSION } from "./config.ts";
import { getWorkspaceGitDiff, parseUnifiedDiff } from "./git/diff-parser.ts";
import { buildDagAndEvaluateImpact } from "./graph/dag.ts";
import {
  calculateFinOpsMetrics,
  estimateTestDurationMs,
  loadTelemetryStore,
  scheduleShardsLpt,
} from "./scheduler/lpt-splitter.ts";
import { emitVortexReports, formatDuration } from "./reporters/finops-reporter.ts";
import type { ExecutionMode, ImpactedTest, VortexAnalysisResult, VortexConfig } from "./types.ts";

/**
 * Executes the full 5-stage Vortex AST Impact & LPT Sharding pipeline.
 */
export function runVortexAnalysis(config: VortexConfig): VortexAnalysisResult {
  const startTime = performance.now();

  // Stage 1: Extract Git Diff Hunks
  const changedFiles = config.rawDiffOverride !== undefined
    ? parseUnifiedDiff(config.rawDiffOverride)
    : getWorkspaceGitDiff(config.workspaceDir, config.baseRef, config.headRef);

  // Stage 2 & 3: Parse AST Symbols & Build Reverse Dependency DAG
  const {
    dag,
    triggeredFailSafeFiles,
    mutatedSymbols,
    reachableTests,
    allChangesAreSemanticNoise,
  } = buildDagAndEvaluateImpact({
    workspaceDir: config.workspaceDir,
    changedFiles,
    testGlobs: config.testGlobs,
    failSafeGlobs: config.failSafeGlobs,
    ignoreDirs: config.ignoreDirs,
    ignoreTypeOnlyChanges: config.ignoreTypeOnlyChanges,
  });

  const allTestModules = dag.getAllTestModules();
  const telemetryStore = loadTelemetryStore(config.workspaceDir, config.telemetryPath);

  let executionMode: ExecutionMode = "surgical";
  let modeReason = "";
  const candidateTests: ImpactedTest[] = [];

  if (triggeredFailSafeFiles.length > 0) {
    executionMode = "full-fail-safe";
    modeReason = `Global fail-safe configuration modified (${
      triggeredFailSafeFiles.join(", ")
    }); executing full test suite.`;
    for (const mod of allTestModules) {
      const rec = telemetryStore.tests[mod.filePath];
      const flakinessScore = rec?.flakinessRate ?? 0;
      candidateTests.push({
        testFile: mod.filePath,
        impactChain: [triggeredFailSafeFiles[0], mod.filePath],
        depth: 1,
        estimatedDurationMs: estimateTestDurationMs(mod, rec),
        flakinessScore,
        quarantined: config.flakyQuarantine && flakinessScore >= config.flakyThreshold,
      });
    }
  } else if (allChangesAreSemanticNoise || reachableTests.size === 0) {
    executionMode = "skip";
    modeReason = changedFiles.length === 0
      ? "No modified files detected between base and head revisions."
      : allChangesAreSemanticNoise
      ? "All modifications are semantic noise (comments, documentation, or formatting only)."
      : "Modified AST symbols have zero reachable test dependents in the Reverse Dependency DAG.";
  } else {
    executionMode = "surgical";
    modeReason =
      `Surgical AST execution: ${reachableTests.size} of ${allTestModules.length} test suite(s) reachable from ${mutatedSymbols.length} mutated AST symbol(s).`;
    for (const [testPath, info] of reachableTests.entries()) {
      const mod = dag.getModule(testPath);
      const rec = telemetryStore.tests[testPath];
      const flakinessScore = rec?.flakinessRate ?? 0;
      candidateTests.push({
        testFile: testPath,
        impactChain: info.chain,
        depth: info.depth,
        estimatedDurationMs: estimateTestDurationMs(mod, rec),
        flakinessScore,
        quarantined: config.flakyQuarantine && flakinessScore >= config.flakyThreshold,
      });
    }
  }

  // Stage 4: Separate Quarantined Flaky Tests & Run LPT Bin-Packing Scheduler
  const impactedTests = candidateTests.filter((t) => !t.quarantined);
  const quarantinedTests = candidateTests.filter((t) => t.quarantined);

  const { shards, matrix, makespanMs } = scheduleShardsLpt(impactedTests, config.shards);
  const shouldRun = impactedTests.length > 0;

  if (executionMode === "surgical" && !shouldRun && quarantinedTests.length > 0) {
    executionMode = "skip";
    modeReason = "All reachable tests are currently isolated in flaky test quarantine.";
  }

  // Stage 5: Compute FinOps & Green-CI Telemetry
  const finops = calculateFinOpsMetrics({
    allTestModules,
    telemetryStore,
    selectedTests: impactedTests,
    quarantinedTests,
    makespanMs,
    runnerCostPerMinUsd: config.runnerCostPerMinUsd,
    changedFilesCount: changedFiles.length,
    totalModulesCount: dag.getAllModules().length,
    triggeredFailSafe: triggeredFailSafeFiles.length > 0,
  });

  const analysisDurationMs = Math.max(1, Math.round(performance.now() - startTime));

  return {
    version: VORTEX_VERSION,
    timestamp: new Date().toISOString(),
    analysisDurationMs,
    baseRef: config.baseRef,
    headRef: config.headRef,
    executionMode,
    modeReason,
    shouldRun,
    changedFiles,
    triggeredFailSafeFiles,
    mutatedSymbols,
    impactedTests,
    quarantinedTests,
    shards,
    matrix,
    finops,
  };
}

function printHelp(): void {
  console.log(`
⚡ GLASTOR® Core — Vortex v${VORTEX_VERSION}
AST-Driven Predictive CI Orchestrator, Reverse Dependency DAG & LPT Test Splitter

Usage:
  deno task start [options]
  vortex [options]

Options:
  -c, --config <path>          Path to .vortex.yml config (default: .vortex.yml)
  -w, --workspace <dir>        Workspace root directory (default: current directory)
  -b, --base-ref <ref>         Base Git ref to diff against (default: HEAD~1)
  -h, --head-ref <ref>         Head Git ref to analyze (default: HEAD)
  -s, --shards <number>        Maximum parallel shards for LPT bin-packing (default: 4)
  --test-globs <csv>           Comma-separated test file globs
  --fail-safe-globs <csv>      Comma-separated fail-safe global trigger globs
  --flaky-quarantine           Enable automatic flaky test quarantine (default: true)
  --no-flaky-quarantine        Disable flaky test quarantine
  --flaky-threshold <0..1>     Flakiness rate threshold for quarantine (default: 0.35)
  --ignore-type-only           Ignore compile-time interface/type edits (default: false)
  -o, --report-file <path>     JSON report output path (default: vortex-report.json)
  -v, --version                Print version
  --help                       Show this help message
`);
}

if (import.meta.main) {
  const { config, helpRequested, versionRequested } = loadConfig(Deno.args);

  if (versionRequested) {
    console.log(VORTEX_VERSION);
    Deno.exit(0);
  }
  if (helpRequested) {
    printHelp();
    Deno.exit(0);
  }

  console.log(
    `⚡ [Vortex v${VORTEX_VERSION}] Analyzing AST Impact Graph (${config.baseRef}...${config.headRef})`,
  );
  const result = runVortexAnalysis(config);
  const { reportPath } = emitVortexReports(
    result,
    config.workspaceDir,
    config.reportFile,
    config.writeSummary,
  );

  console.log(
    `   ├─ Execution Mode      : ${result.executionMode.toUpperCase()} (should-run=${result.shouldRun})`,
  );
  console.log(`   ├─ Reason              : ${result.modeReason}`);
  console.log(`   ├─ Mutated AST Symbols : ${result.mutatedSymbols.length}`);
  console.log(
    `   ├─ Test Suites         : ${result.finops.selectedTestsCount} selected / ${result.finops.skippedTestsCount} skipped / ${result.finops.quarantinedTestsCount} quarantined (Total: ${result.finops.totalTestsInRepo})`,
  );
  console.log(
    `   ├─ LPT Parallel Shards : ${result.shards.length} shard(s) (Makespan: ${
      formatDuration(result.finops.optimizedMakespanMs)
    } vs Baseline: ${formatDuration(result.finops.baselineDurationMs)})`,
  );
  console.log(
    `   ├─ FinOps Savings      : -${result.finops.timeReductionPercent}% wall-clock time | $${
      result.finops.estimatedCostSavedUsd.toFixed(4)
    } USD | ${result.finops.estimatedCo2SavedGrams}g CO2e`,
  );
  console.log(`   └─ Completed in        : ${result.analysisDurationMs}ms (Report: ${reportPath})`);
}
