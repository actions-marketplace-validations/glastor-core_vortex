# Changelog

All notable changes to **`@glastor-core/vortex`** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Tree-sitter WASM optional plugins for C++ and Java AST symbol granularity.
- GitHub Checks API native annotations for flaky test quarantine history.

## [1.0.0] - 2026-11-01

### Added

- **Stage 1 — Surgical Git Diff Hunk Parser (`src/git/diff-parser.ts`)**: Line-level `git diff --unified=0` parser with semantic noise filtering for comments, docstrings, and whitespace-only edits.
- **Stage 2 — Polyglot AST Symbol & Import Analyzer (`src/ast/analyzer.ts`)**: Extracts top-level symbol boundaries (`function`, `class`, `const`, `interface`, `type`, `enum`) and resolves module import graphs across TypeScript/JavaScript/Deno, Python, Rust, and Go.
- **Stage 3 — Reverse Dependency DAG & BFS Reachability (`src/graph/dag.ts`)**: Computes transitive blast radius (`impactChain` and hop depth) and enforces fail-safe global triggers (`deno.json`, `package.json`, `.github/workflows/**`).
- **Stage 4 — LPT Bin-Packing Scheduler & Flaky Quarantine (`src/scheduler/lpt-splitter.ts`)**: Greedy Longest Processing Time (LPT) multi-way partitioning into balanced GitHub Actions `strategy.matrix` shards, plus automatic quarantine of unstable tests exceeding `flaky-threshold`.
- **Stage 5 — FinOps, Green-CI & Mermaid Step Summary Reporter (`src/reporters/finops-reporter.ts`)**: Exports 11 GitHub Actions outputs (`$GITHUB_OUTPUT`), JSON telemetry report, and `$GITHUB_STEP_SUMMARY` with Mermaid Blast-Radius DAG visualization, USD cost savings, and $\text{CO}_2\text{e}$ reduction metrics.
- **GitHub Marketplace Action (`action.yml`)**: Zero-external-dependency composite action isolated via `--config`.
