/**
 * @module main
 * @description Entrypoint and core orchestrator for Vortex — AST-Driven Predictive CI & Impact Graph Engine (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, VORTEX_VERSION } from "./config.ts";
import { getWorkspaceGitDiff, parseUnifiedDiff } from "./git/diff-parser.ts";
import { buildDagAndEvaluateImpact } from "./graph/dag.ts";
import {
  calculateFinOpsMetrics,
  estimateTestDurationMs,
  loadTelemetryStore,
  parseTestReportObservations,
  saveTelemetryStore,
  scheduleShardsLpt,
  updateTelemetryStoreEwma,
} from "./scheduler/lpt-splitter.ts";
import { evaluateGovernance } from "./governance/gatekeeper.ts";
import {
  emitVortexReports,
  formatDuration,
  postOrUpdateStickyPrComment,
} from "./reporters/finops-reporter.ts";
import type { ExecutionMode, ImpactedTest, VortexAnalysisResult, VortexConfig } from "./types.ts";

/**
 * Executes the full Vortex AST Impact, Symbol-Level Barrel Pruning, LPT Fail-Fast Sharding,
 * EWMA Telemetry Learning, and Governance Gatekeeper pipeline.
 */
export function runVortexAnalysis(config: VortexConfig): VortexAnalysisResult {
  const startTime = performance.now();

  // Optional Pre-Step: Ingest JUnit XML / JSON test report into EWMA Telemetry Store
  let telemetryStore = loadTelemetryStore(config.workspaceDir, config.telemetryPath);
  if (config.updateTelemetryFromReport) {
    const absReportPath = path.resolve(config.workspaceDir, config.updateTelemetryFromReport);
    if (fs.existsSync(absReportPath)) {
      try {
        const rawReport = fs.readFileSync(absReportPath, "utf-8");
        const observations = parseTestReportObservations(rawReport);
        if (observations.length > 0) {
          telemetryStore = updateTelemetryStoreEwma(
            telemetryStore,
            observations,
            config.ewmaAlpha,
          );
          saveTelemetryStore(config.workspaceDir, config.telemetryPath, telemetryStore);
        }
      } catch {
        // Ignore unreadable report
      }
    }
  }

  // Stage 1: Extract Git Diff Hunks
  const changedFiles = config.rawDiffOverride !== undefined
    ? parseUnifiedDiff(config.rawDiffOverride)
    : getWorkspaceGitDiff(config.workspaceDir, config.baseRef, config.headRef);

  // Stage 2 & 3: Parse AST Symbols, Resolve Monorepo Aliases & Build Reverse Dependency DAG with Barrel Pruning
  const {
    dag,
    triggeredFailSafeFiles,
    mutatedSymbols,
    prunedEdges,
    impactedFiles,
    reachableTests,
    allChangesAreSemanticNoise,
  } = buildDagAndEvaluateImpact({
    workspaceDir: config.workspaceDir,
    changedFiles,
    testGlobs: config.testGlobs,
    failSafeGlobs: config.failSafeGlobs,
    ignoreDirs: config.ignoreDirs,
    ignoreTypeOnlyChanges: config.ignoreTypeOnlyChanges,
    symbolLevelPruning: config.symbolLevelPruning,
  });

  const allTestModules = dag.getAllTestModules();

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
      : prunedEdges.length > 0
      ? `Symbol-level AST pruning eliminated ${prunedEdges.length} unrelated barrel import edge(s); zero test suites impacted.`
      : "Modified AST symbols have zero reachable test dependents in the Reverse Dependency DAG.";
  } else {
    executionMode = "surgical";
    modeReason =
      `Surgical AST execution: ${reachableTests.size} of ${allTestModules.length} test suite(s) reachable from ${mutatedSymbols.length} mutated AST symbol(s) (${prunedEdges.length} barrel edge(s) pruned).`;
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

  // Stage 4: Separate Quarantined Flaky Tests & Run LPT + Fail-Fast Intra-Shard Scheduler
  const impactedTests = candidateTests.filter((t) => !t.quarantined);
  const quarantinedTests = candidateTests.filter((t) => t.quarantined);

  const { shards, matrix, makespanMs } = scheduleShardsLpt(impactedTests, config.shards);
  const shouldRun = impactedTests.length > 0;

  if (executionMode === "surgical" && !shouldRun && quarantinedTests.length > 0) {
    executionMode = "skip";
    modeReason = "All reachable tests are currently isolated in flaky test quarantine.";
  }

  // Stage 5: Compute FinOps, Green-CI & Governance / Ticket Traceability
  const finops = calculateFinOpsMetrics({
    allTestModules,
    telemetryStore,
    selectedTests: impactedTests,
    quarantinedTests,
    prunedBarrelEdgesCount: prunedEdges.length,
    makespanMs,
    runnerCostPerMinUsd: config.runnerCostPerMinUsd,
    changedFilesCount: changedFiles.length,
    totalModulesCount: dag.getAllModules().length,
    triggeredFailSafe: triggeredFailSafeFiles.length > 0,
  });

  const governance = evaluateGovernance({
    workspaceDir: config.workspaceDir,
    ticketContext: config.ticketContext,
    blastRadiusScore: finops.blastRadiusScore,
    maxBlastRadius: config.maxBlastRadius,
    changedFilesPaths: changedFiles.map((f) => f.filePath),
    impactedFiles,
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
    prunedEdges,
    impactedTests,
    quarantinedTests,
    shards,
    matrix,
    finops,
    governance,
  };
}

function printHelp(): void {
  console.log(`
⚡ GLASTOR® Core — Vortex v${VORTEX_VERSION}
AST-Driven Predictive CI Orchestrator, Symbol-Level Barrel Pruner, LPT Splitter & Governance Gatekeeper

Usage:
  deno task start [options]
  vortex [options]

Options:
  -c, --config <path>            Path to .vortex.yml config (default: .vortex.yml)
  -w, --workspace <dir>          Workspace root directory (default: current directory)
  -b, --base-ref <ref>           Base Git ref to diff against (default: HEAD~1)
  -h, --head-ref <ref>           Head Git ref to analyze (default: HEAD)
  -s, --shards <number>          Maximum parallel shards for LPT bin-packing (default: 4)
  --test-globs <csv>             Comma-separated test file globs
  --fail-safe-globs <csv>        Comma-separated fail-safe global trigger globs
  --symbol-pruning               Enable Symbol-Level AST Barrel Pruning (default: true)
  --no-symbol-pruning            Disable Symbol-Level AST Barrel Pruning
  --update-telemetry <path>      Ingest JUnit XML or JSON report into EWMA telemetry store
  --ewma-alpha <0.05..0.95>      EWMA learning rate alpha (default: 0.3)
  --flaky-quarantine             Enable automatic flaky test quarantine (default: true)
  --no-flaky-quarantine          Disable flaky test quarantine
  --flaky-threshold <0..1>       Flakiness rate threshold for quarantine (default: 0.35)
  --ignore-type-only             Ignore compile-time interface/type edits (default: false)
  --max-blast-radius <0..100>    Max allowed blast-radius score (default: 100)
  --fail-on-blast-radius         Exit with code 1 if blast-radius exceeds max-blast-radius
  --ticket-context <str>         Explicit branch/PR title context for Jira/Linear key extraction
  --emit-annotations             Emit native GitHub workflow annotations (default: true)
  --post-pr-comment              Post/update sticky PR report via GITHUB_TOKEN
  -o, --report-file <path>       JSON report output path (default: vortex-report.json)
  -v, --version                  Print version
  --help                         Show this help message
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
  const { summaryMarkdown, reportPath } = emitVortexReports(
    result,
    config.workspaceDir,
    config.reportFile,
    config.writeSummary,
    config.emitAnnotations,
  );

  if (config.postPrComment) {
    await postOrUpdateStickyPrComment(summaryMarkdown);
  }

  console.log(
    `   ├─ Execution Mode      : ${result.executionMode.toUpperCase()} (should-run=${result.shouldRun})`,
  );
  console.log(`   ├─ Reason              : ${result.modeReason}`);
  console.log(
    `   ├─ Mutated AST Symbols : ${result.mutatedSymbols.length} (${result.prunedEdges.length} barrel edge(s) pruned)`,
  );
  console.log(
    `   ├─ Test Suites         : ${result.finops.selectedTestsCount} selected / ${result.finops.skippedTestsCount} skipped / ${result.finops.quarantinedTestsCount} quarantined (Total: ${result.finops.totalTestsInRepo})`,
  );
  console.log(
    `   ├─ LPT Parallel Shards : ${result.shards.length} shard(s) (Makespan: ${
      formatDuration(result.finops.optimizedMakespanMs)
    } vs Baseline: ${formatDuration(result.finops.baselineDurationMs)})`,
  );
  console.log(
    `   ├─ Governance & Tickets: Blast Radius ${result.finops.blastRadiusScore}/${result.governance.maxBlastRadiusScore} (${
      result.governance.blastRadiusPassed ? "PASSED" : "EXCEEDED"
    }) | Tickets: ${result.governance.detectedTicketIds.join(", ") || "None"}`,
  );
  console.log(
    `   ├─ FinOps Savings      : -${result.finops.timeReductionPercent}% wall-clock time | $${
      result.finops.estimatedCostSavedUsd.toFixed(4)
    } USD | ${result.finops.estimatedCo2SavedGrams}g CO2e`,
  );
  console.log(`   └─ Completed in        : ${result.analysisDurationMs}ms (Report: ${reportPath})`);

  if (config.failOnBlastRadius && !result.governance.blastRadiusPassed) {
    console.error(
      `❌ [Vortex Gatekeeper] Blast-Radius Score (${result.finops.blastRadiusScore}) exceeded max-blast-radius (${result.governance.maxBlastRadiusScore}).`,
    );
    Deno.exit(1);
  }
}
