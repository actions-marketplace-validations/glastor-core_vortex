# Changelog

All notable changes to **`@glastor-core/vortex`** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Tree-sitter WASM optional plugins for C++ and Java AST symbol granularity.

## [1.1.0] - 2026-11-01

### Added

- **Symbol-Level AST Barrel Pruning (`src/ast/analyzer.ts`, `src/graph/dag.ts`)**: Extracts fine-grained named import bindings (`import { fnB } from "./utils.ts"`) and intra-module call references (`expandIntraModuleMutatedSymbols`), pruning dependency edges when a consumer only imports unmutated symbols from a shared barrel or utility module.
- **EWMA Telemetry Auto-Learner (`src/scheduler/lpt-splitter.ts`)**: Added `parseTestReportObservations` and `updateTelemetryStoreEwma` (`--update-telemetry`) supporting both JUnit XML and JSON test reports to update historical durations and flakiness rates via Exponentially Weighted Moving Average ($\alpha = 0.3$).
- **Monorepo & Path Alias Resolution (`src/ast/analyzer.ts`)**: Added `loadWorkspacePathAliases` to automatically resolve `deno.json` `imports` and `tsconfig.json` `compilerOptions.paths` (`@/`, `@core/*`) across workspace packages.
- **Predictive Fail-Fast Intra-Shard Ordering (`src/scheduler/lpt-splitter.ts`)**: Added `computeFailFastPriorityScore` to order tests inside each LPT-balanced shard by shortest DAG hop distance (`depth`), instability propensity, and fastest execution time so regressions fail within the first seconds.
- **Native GitHub Workflow Annotations & Sticky PR Comments (`src/reporters/finops-reporter.ts`)**: Added `buildGitHubWorkflowAnnotations` (`::notice`, `::warning`, `::error` on exact file/line ranges) and idempotent `postOrUpdateStickyPrComment`.
- **Blast-Radius Gatekeeper, Ticket Traceability & `nemesis` Bridge (`src/governance/gatekeeper.ts`)**: Automatically extracts Jira/Linear/GitHub issue keys (`GLS-402`, `PROJ-123`, `#42`), enforces `max-blast-radius` policy thresholds, and outputs `nemesis-target-files` for surgical DevSecOps auditing.

## [1.0.0] - 2026-11-01

### Added

- **Stage 1 — Surgical Git Diff Hunk Parser (`src/git/diff-parser.ts`)**: Line-level `git diff --unified=0` parser with semantic noise filtering for comments, docstrings, and whitespace-only edits.
- **Stage 2 — Polyglot AST Symbol & Import Analyzer (`src/ast/analyzer.ts`)**: Extracts top-level symbol boundaries (`function`, `class`, `const`, `interface`, `type`, `enum`) and resolves module import graphs across TypeScript/JavaScript/Deno, Python, Rust, and Go.
- **Stage 3 — Reverse Dependency DAG & BFS Reachability (`src/graph/dag.ts`)**: Computes transitive blast radius (`impactChain` and hop depth) and enforces fail-safe global triggers (`deno.json`, `package.json`, `.github/workflows/**`).
- **Stage 4 — LPT Bin-Packing Scheduler & Flaky Quarantine (`src/scheduler/lpt-splitter.ts`)**: Greedy Longest Processing Time (LPT) multi-way partitioning into balanced GitHub Actions `strategy.matrix` shards, plus automatic quarantine of unstable tests exceeding `flaky-threshold`.
- **Stage 5 — FinOps, Green-CI & Mermaid Step Summary Reporter (`src/reporters/finops-reporter.ts`)**: Exports GitHub Actions outputs (`$GITHUB_OUTPUT`), JSON telemetry report, and `$GITHUB_STEP_SUMMARY` with Mermaid Blast-Radius DAG visualization, USD cost savings, and $\text{CO}_2\text{e}$ reduction metrics.
- **GitHub Marketplace Action (`action.yml`)**: Zero-external-dependency composite action isolated via `--config`.
