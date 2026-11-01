/**
 * @module types
 * @description Core domain types for Vortex AST-Driven Predictive CI & Impact Graph Engine (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

/** Execution strategy determined by Vortex impact analysis. */
export type ExecutionMode = "skip" | "surgical" | "full-fail-safe";

/** Supported programming languages for AST symbol & import analysis. */
export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "unknown";

/** Line-level modification range extracted from `git diff --unified=0`. */
export interface DiffHunk {
  /** Starting line number in the new/head file (1-indexed). */
  startLine: number;
  /** Number of lines in the new/head hunk. */
  lineCount: number;
  /** Ending line number in the new/head file (inclusive, 1-indexed). */
  endLine: number;
  /** Raw added lines in this hunk (without leading `+`). */
  addedLines: string[];
  /** Raw removed lines in this hunk (without leading `-`). */
  removedLines: string[];
  /** True if the hunk only modifies comments, whitespace, or blank lines. */
  isSemanticNoise: boolean;
}

/** Diff summary for a single repository file. */
export interface FileDiff {
  /** Normalized POSIX relative path from workspace root (e.g., `src/graph/dag.ts`). */
  filePath: string;
  /** Change status (`A` added, `M` modified, `D` deleted, `R` renamed). */
  status: "A" | "M" | "D" | "R";
  /** Individual line-range hunks modified in the file. */
  hunks: DiffHunk[];
  /** True if all hunks in this file are non-functional noise (comments/formatting). */
  isCommentOrFormatOnly: boolean;
}

/** Kind of top-level AST symbol declaration. */
export type SymbolKind =
  | "function"
  | "class"
  | "const"
  | "variable"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "method";

/** Top-level AST declaration boundary inside a source module. */
export interface AstSymbol {
  /** Identifier name of the symbol. */
  name: string;
  /** Symbol category. */
  kind: SymbolKind;
  /** Whether the symbol is exported/public across modules. */
  isExported: boolean;
  /** Whether the symbol only exists at compile-time (`interface` / `type`). */
  isTypeOnly: boolean;
  /** Starting line number (1-indexed). */
  startLine: number;
  /** Ending line number (1-indexed, inclusive). */
  endLine: number;
  /** Other top-level symbols or imported identifiers referenced inside this declaration's body. */
  referencedIdentifiers?: string[];
}

/** Fine-grained symbol-level import binding (`import { fnA, fnB } from "./utils.ts"`). */
export interface ImportBinding {
  /** Raw module specifier as written in source code (`./utils.ts`, `@core/db`). */
  rawSpecifier: string;
  /** Resolved POSIX workspace file path (`src/utils.ts`). */
  resolvedFilePath: string;
  /** Specific exported symbol names imported, or `["*"]` for namespace/default/side-effect imports. */
  importedSymbols: string[];
  /** True if this is a re-export (`export { fnA } from "./utils.ts"` or `export * from "./utils.ts"`). */
  isReExport: boolean;
}

/** Parsed AST representation for a single file in the workspace. */
export interface ParsedModule {
  /** Normalized POSIX relative path. */
  filePath: string;
  /** Detected source language. */
  language: SupportedLanguage;
  /** Whether this file is a test suite (`*.test.ts`, `*.spec.ts`, etc.). */
  isTestFile: boolean;
  /** Resolved POSIX relative paths of workspace modules imported by this file. */
  imports: string[];
  /** Fine-grained symbol-level import bindings for barrel-file pruning. */
  importBindings?: ImportBinding[];
  /** Top-level declared symbols with exact line ranges. */
  symbols: AstSymbol[];
  /** Approximate line count of the module. */
  lineCount: number;
  /** Number of test cases (`Deno.test`, `it(`, `test(`, `def test_`, `#[test]`) found. */
  testCaseCount: number;
}

/** Mutated symbol detected by intersecting Git Diff Hunks with AST Symbol boundaries. */
export interface MutatedSymbol {
  /** File where the symbol resides. */
  filePath: string;
  /** Name of the mutated symbol (`<module-scope>` if top-level side-effect). */
  symbolName: string;
  /** Symbol category. */
  kind: SymbolKind | "module-scope";
  /** True if only compile-time types were touched. */
  isTypeOnly: boolean;
  /** Line range of the symbol. */
  lineRange: [number, number];
}

/** Dependency edge pruned by Symbol-Level AST Barrel Pruning. */
export interface PrunedDependencyEdge {
  /** Modified dependency file (`src/utils.ts`). */
  fromFile: string;
  /** Consumer file that imports `fromFile` (`tests/payment.test.ts`). */
  toFile: string;
  /** Symbols imported by `toFile` (`["fnB"]`). */
  importedSymbols: string[];
  /** Symbols actually mutated in `fromFile` (`["fnA"]`). */
  mutatedSymbolsInSource: string[];
}

/** Impacted test file with its shortest dependency chain from the mutated source. */
export interface ImpactedTest {
  /** Normalized POSIX path of the test file. */
  testFile: string;
  /** Dependency path from modified file to this test (`["src/a.ts", "src/b.ts", "tests/b.test.ts"]`). */
  impactChain: string[];
  /** Hop distance in the Reverse Dependency DAG (`0` if the test itself was modified). */
  depth: number;
  /** Estimated or historical execution time in milliseconds. */
  estimatedDurationMs: number;
  /** Historical flakiness score between `0.0` (stable) and `1.0` (highly flaky). */
  flakinessScore: number;
  /** Whether this test was quarantined due to exceeding the flakiness threshold. */
  quarantined: boolean;
  /** Computed Fail-Fast priority score (higher runs earlier inside its assigned shard). */
  failFastPriorityScore?: number;
}

/** Single parallel execution shard generated by the LPT Bin-Packing Scheduler. */
export interface TestShard {
  /** 1-indexed shard identifier (`1` .. `N`). */
  shard_id: number;
  /** Space-separated list of test file paths ordered by Fail-Fast priority (`deno test ${{ matrix.test_files }}`). */
  test_files: string;
  /** Array of test file paths assigned to this shard (ordered by Fail-Fast priority). */
  files: string[];
  /** Total estimated execution time for this shard in milliseconds. */
  estimated_ms: number;
}

/** GitHub Actions dynamic matrix payload (`strategy.matrix`). */
export interface GitHubMatrixPayload {
  include: TestShard[];
}

/** Historical telemetry entry for a single test file stored in `.vortex/telemetry.json`. */
export interface TestTelemetryRecord {
  /** Average execution time in milliseconds (EWMA). */
  durationMs: number;
  /** Flakiness rate (`0.0` to `1.0`) observed across recent runs (EWMA). */
  flakinessRate: number;
  /** Total number of recorded executions. */
  runsCount?: number;
  /** ISO-8601 timestamp of last recorded run. */
  lastUpdated?: string;
}

/** Historical telemetry file structure. */
export interface TelemetryStore {
  version: string;
  tests: Record<string, TestTelemetryRecord>;
}

/** Single test execution observation used to update EWMA telemetry. */
export interface TestRunObservation {
  /** Normalized POSIX path of the test file. */
  testFile: string;
  /** Observed execution time in milliseconds. */
  durationMs: number;
  /** Whether the test passed without retries. */
  passed: boolean;
  /** True if the test failed initially and passed on retry (or exhibited flaky behavior). */
  flakyOrRetried?: boolean;
}

/** Governance, Ticket Traceability & DevSecOps Gatekeeper metadata. */
export interface GovernanceMetadata {
  /** Extracted Jira / Linear / GitHub Issue identifiers (e.g. `["GLS-402", "PROJ-101"]`). */
  detectedTicketIds: string[];
  /** Configured maximum allowed blast-radius score (`0` - `100`). */
  maxBlastRadiusScore: number;
  /** Whether the blast radius is within the allowed threshold. */
  blastRadiusPassed: boolean;
  /** Space-separated list of modified and transitively impacted source files for `glastor-core/nemesis`. */
  nemesisTargetFiles: string[];
}

/** FinOps and Green-CI efficiency metrics calculated for the current run. */
export interface FinOpsMetrics {
  /** Total test files discovered in the workspace. */
  totalTestsInRepo: number;
  /** Number of test files selected for execution. */
  selectedTestsCount: number;
  /** Number of unaffected test files safely skipped. */
  skippedTestsCount: number;
  /** Number of flaky test files isolated in quarantine. */
  quarantinedTestsCount: number;
  /** Number of false-positive dependency edges eliminated via Symbol-Level Barrel Pruning. */
  prunedBarrelEdgesCount: number;
  /** Estimated full-suite sequential duration in milliseconds. */
  baselineDurationMs: number;
  /** Estimated parallel makespan (slowest shard duration) in milliseconds. */
  optimizedMakespanMs: number;
  /** Total runner compute time saved in milliseconds. */
  timeSavedMs: number;
  /** Percentage of CI execution wall-clock time saved (`0` - `100`). */
  timeReductionPercent: number;
  /** Estimated cloud CI cost saved per run in USD (based on runner cost/min). */
  estimatedCostSavedUsd: number;
  /** Estimated carbon footprint saved in grams of CO2e. */
  estimatedCo2SavedGrams: number;
  /** Blast-radius severity score (`0` - `100`). */
  blastRadiusScore: number;
}

/** Complete output produced by the Vortex Engine. */
export interface VortexAnalysisResult {
  /** Engine semantic version. */
  version: string;
  /** Timestamp of analysis. */
  timestamp: string;
  /** Analysis execution wall-clock time in milliseconds. */
  analysisDurationMs: number;
  /** Base Git ref compared against. */
  baseRef: string;
  /** Head Git ref analyzed. */
  headRef: string;
  /** Chosen execution strategy. */
  executionMode: ExecutionMode;
  /** Reason explaining why this execution mode was selected. */
  modeReason: string;
  /** Whether downstream CI test jobs should execute (`true` or `false`). */
  shouldRun: boolean;
  /** Files modified in the Git diff. */
  changedFiles: FileDiff[];
  /** Global fail-safe files that triggered a full suite run (if any). */
  triggeredFailSafeFiles: string[];
  /** AST symbols mutated by the diff. */
  mutatedSymbols: MutatedSymbol[];
  /** Dependency edges pruned by Symbol-Level AST Barrel Pruning. */
  prunedEdges: PrunedDependencyEdge[];
  /** Impacted test files discovered via Reverse DAG reachability. */
  impactedTests: ImpactedTest[];
  /** Quarantined flaky test files. */
  quarantinedTests: ImpactedTest[];
  /** LPT-balanced parallel shards for GitHub Actions matrix. */
  shards: TestShard[];
  /** Ready-to-use GitHub Actions `strategy.matrix` object. */
  matrix: GitHubMatrixPayload;
  /** FinOps and compute savings metrics. */
  finops: FinOpsMetrics;
  /** Governance, ticket traceability, and `nemesis` DevSecOps bridge data. */
  governance: GovernanceMetadata;
}

/** Runtime configuration for Vortex. */
export interface VortexConfig {
  /** Workspace root directory. */
  workspaceDir: string;
  /** Base Git revision or branch (`origin/main`, `HEAD~1`, etc.). */
  baseRef: string;
  /** Head Git revision (`HEAD`). */
  headRef: string;
  /** Maximum number of parallel shards to generate (`1` - `64`). */
  shards: number;
  /** Glob patterns identifying test files. */
  testGlobs: string[];
  /** Glob patterns that force full test suite execution when modified. */
  failSafeGlobs: string[];
  /** Directory names to ignore when scanning workspace AST. */
  ignoreDirs: string[];
  /** Path to historical test timing telemetry JSON file. */
  telemetryPath: string;
  /** Optional path to a JUnit XML or JSON test report to ingest via EWMA telemetry learning. */
  updateTelemetryFromReport?: string;
  /** EWMA smoothing factor alpha (`0.05` - `0.95`, default `0.3`). */
  ewmaAlpha: number;
  /** Whether to quarantine tests exceeding `flakyThreshold`. */
  flakyQuarantine: boolean;
  /** Flakiness score threshold (`0.0` - `1.0`) above which a test is quarantined. */
  flakyThreshold: number;
  /** Whether type-only AST edits (`interface` / `type`) should be ignored for runtime test execution. */
  ignoreTypeOnlyChanges: boolean;
  /** Enable Symbol-Level AST Barrel Pruning (`import { fnB }` vs mutated `fnA`). */
  symbolLevelPruning: boolean;
  /** Maximum allowed blast-radius score (`0` - `100`) before Gatekeeper flags/blocks. */
  maxBlastRadius: number;
  /** Fail with exit code 1 if blast radius exceeds `maxBlastRadius`. */
  failOnBlastRadius: boolean;
  /** Optional explicit ticket/issue IDs or branch name for traceability. */
  ticketContext?: string;
  /** Emit native GitHub Actions workflow annotations (`::notice`, `::warning`, `::error`). */
  emitAnnotations: boolean;
  /** Post or update an idempotent sticky PR comment when `GITHUB_TOKEN` is available. */
  postPrComment: boolean;
  /** Runner cost in USD per minute for FinOps calculations. */
  runnerCostPerMinUsd: number;
  /** Path to export full JSON report. */
  reportFile: string;
  /** Whether to write summary to `$GITHUB_STEP_SUMMARY`. */
  writeSummary: boolean;
  /** Optional raw unified diff string (used for unit testing or piped diffs). */
  rawDiffOverride?: string;
}
