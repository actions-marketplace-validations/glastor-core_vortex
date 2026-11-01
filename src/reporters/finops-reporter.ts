/**
 * @module reporters/finops-reporter
 * @description Exports GitHub Actions `$GITHUB_OUTPUT`, `$GITHUB_STEP_SUMMARY` Markdown with
 *              Mermaid Blast-Radius DAG visualization, and JSON telemetry reports.
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { VortexAnalysisResult } from "../types.ts";

/**
 * Formats milliseconds into human-readable duration (`1.42s`, `340ms`).
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${mins}m ${remSec}s`;
}

/**
 * Generates a Mermaid flowchart (`flowchart LR`) visualizing the AST Blast-Radius DAG.
 */
export function buildMermaidImpactGraph(result: VortexAnalysisResult): string {
  if (result.changedFiles.length === 0) {
    return [
      "```mermaid",
      "flowchart LR",
      '  clean["✅ Working Tree Clean (0 Mutated AST Symbols)"]',
      "```",
    ].join("\n");
  }

  const lines: string[] = ["```mermaid", "flowchart LR"];
  const nodeIds = new Map<string, string>();
  const edges = new Set<string>();

  const getNodeId = (label: string, kind: "src" | "test" | "cfg"): string => {
    if (nodeIds.has(label)) return nodeIds.get(label)!;
    const id = `n${nodeIds.size + 1}`;
    const safeName = path.posix.basename(label);
    const prefix = kind === "test" ? "🧪 " : kind === "cfg" ? "⚙️ " : "⚡ ";
    lines.push(`  ${id}["${prefix}${safeName}"]`);
    nodeIds.set(label, id);
    return id;
  };

  for (const cfgFile of result.triggeredFailSafeFiles.slice(0, 6)) {
    const cfgId = getNodeId(cfgFile, "cfg");
    const suiteId = getNodeId("Full Test Suite (Fail-Safe)", "test");
    edges.add(`  ${cfgId} --> ${suiteId}`);
  }

  for (const test of result.impactedTests.slice(0, 15)) {
    const chain = test.impactChain;
    if (chain.length === 1) {
      getNodeId(chain[0], "test");
      continue;
    }
    for (let i = 0; i < chain.length - 1; i++) {
      const fromKind = i === 0 ? "src" : "src";
      const toKind = i === chain.length - 2 ? "test" : "src";
      const fromId = getNodeId(chain[i], fromKind);
      const toId = getNodeId(chain[i + 1], toKind);
      edges.add(`  ${fromId} --> ${toId}`);
    }
  }

  if (nodeIds.size === 0) {
    for (const f of result.changedFiles.slice(0, 5)) {
      const id = getNodeId(f.filePath, "src");
      const skipId = getNodeId("0 Runtime Impact (Skipped CI)", "test");
      edges.add(`  ${id} -.-> ${skipId}`);
    }
  }

  lines.push(...edges);
  lines.push("```");
  return lines.join("\n");
}

/**
 * Generates the Markdown report for `$GITHUB_STEP_SUMMARY` and PR comments.
 */
export function generateMarkdownSummary(result: VortexAnalysisResult): string {
  const modeBadge = result.executionMode === "skip"
    ? "🟢 **SKIP CI (0 Runtime Impact)**"
    : result.executionMode === "surgical"
    ? "⚡ **SURGICAL AST EXECUTION**"
    : "🛡️ **FULL SUITE (FAIL-SAFE TRIGGERED)**";

  const md: string[] = [
    `## ⚡ Vortex — AST-Driven Predictive CI & Impact Graph Report`,
    "",
    `> **Execution Strategy:** ${modeBadge} — _${result.modeReason}_`,
    "",
    `### 📊 FinOps & Pipeline Acceleration Telemetry`,
    "",
    `| Metric | Baseline (Full Suite) | Vortex Optimized | Impact / Savings |`,
    `| :--- | :---: | :---: | :---: |`,
    `| **Executable Test Suites** | \`${result.finops.totalTestsInRepo}\` | \`${result.finops.selectedTestsCount}\` | **\`${result.finops.skippedTestsCount}\` safely skipped** |`,
    `| **Pipeline Wall-Clock (Makespan)** | \`${
      formatDuration(result.finops.baselineDurationMs)
    }\` | \`${
      formatDuration(result.finops.optimizedMakespanMs)
    }\` | **-${result.finops.timeReductionPercent}% (${
      formatDuration(result.finops.timeSavedMs)
    } saved)** |`,
    `| **AST Blast-Radius Score** | \`100 / 100\` | \`${result.finops.blastRadiusScore} / 100\` | \`${result.mutatedSymbols.length}\` mutated AST symbols |`,
    `| **Flaky Tests Quarantined** | \`0\` | \`${result.finops.quarantinedTestsCount}\` | Zero false-positive blocks |`,
    `| **FinOps & Green-CI Savings** | — | \`$${
      result.finops.estimatedCostSavedUsd.toFixed(4)
    } USD\` | \`${result.finops.estimatedCo2SavedGrams}g CO2e\` avoided |`,
    "",
    `### 🕸️ AST Reverse Dependency Blast-Radius Graph`,
    "",
    buildMermaidImpactGraph(result),
    "",
  ];

  if (result.mutatedSymbols.length > 0) {
    md.push(
      `### 🧬 Mutated AST Symbols (\`git diff\` ∩ AST Declarations)`,
      "",
      `| Source File | Symbol | Kind | Lines | Runtime Impact |`,
      `| :--- | :--- | :---: | :---: | :---: |`,
    );
    for (const sym of result.mutatedSymbols.slice(0, 20)) {
      const impactLabel = sym.isTypeOnly ? "Compile-Time Only" : "Runtime Active";
      md.push(
        `| \`${sym.filePath}\` | \`${sym.symbolName}\` | \`${sym.kind}\` | \`L${
          sym.lineRange[0]
        }-L${sym.lineRange[1]}\` | ${impactLabel} |`,
      );
    }
    md.push("");
  }

  if (result.shards.length > 0) {
    md.push(
      `### ⚖️ LPT Dynamic Matrix Shards (\`strategy.matrix\`)`,
      "",
      `| Shard ID | Assigned Test Suites | Est. Makespan | CLI Command |`,
      `| :---: | :--- | :---: | :--- |`,
    );
    for (const s of result.shards) {
      md.push(
        `| **Shard #${s.shard_id}** | \`${s.files.join("`, `")}\` | \`${
          formatDuration(s.estimated_ms)
        }\` | \`deno test ${s.test_files}\` |`,
      );
    }
    md.push("");
  }

  if (result.quarantinedTests.length > 0) {
    md.push(
      `### 🧪 Quarantined Flaky Tests`,
      "",
      `| Test Suite | Flakiness Score | Impact Chain |`,
      `| :--- | :---: | :--- |`,
    );
    for (const q of result.quarantinedTests) {
      md.push(
        `| \`${q.testFile}\` | \`${(q.flakinessScore * 100).toFixed(0)}%\` | \`${
          q.impactChain.join(" → ")
        }\` |`,
      );
    }
    md.push("");
  }

  md.push(
    "---",
    `*Generated in **${result.analysisDurationMs}ms** by [GLASTOR® Core — Vortex v${result.version}](https://github.com/glastor-core/vortex) • [glastor.es](https://glastor.es)*`,
  );

  return md.join("\n");
}

/**
 * Writes analysis outputs to `$GITHUB_OUTPUT`, `$GITHUB_STEP_SUMMARY`, and the JSON report file.
 */
export function emitVortexReports(
  result: VortexAnalysisResult,
  workspaceDir: string,
  reportFile: string,
  writeSummary: boolean,
): { summaryMarkdown: string; reportPath: string } {
  const summaryMarkdown = generateMarkdownSummary(result);
  const reportPath = path.resolve(workspaceDir, reportFile);

  try {
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf-8");
  } catch {
    // Non-fatal if read-only filesystem
  }

  // Write GitHub Actions $GITHUB_OUTPUT
  const githubOutput = Deno.env.get("GITHUB_OUTPUT");
  if (githubOutput) {
    const affectedList = result.impactedTests.map((t) => t.testFile).join(" ");
    const quarantinedList = result.quarantinedTests.map((t) => t.testFile).join(" ");
    const timeSavedSec = Math.round(result.finops.timeSavedMs / 100) / 10;

    const kvLines = [
      `should-run=${result.shouldRun}`,
      `execution-mode=${result.executionMode}`,
      `affected-tests=${affectedList}`,
      `affected-count=${result.finops.selectedTestsCount}`,
      `skipped-count=${result.finops.skippedTestsCount}`,
      `quarantined-tests=${quarantinedList}`,
      `time-saved-seconds=${timeSavedSec}`,
      `savings-percent=${result.finops.timeReductionPercent}`,
      `blast-radius-score=${result.finops.blastRadiusScore}`,
      `matrix=${JSON.stringify(result.matrix)}`,
      `report-path=${reportPath}`,
    ];
    try {
      fs.appendFileSync(githubOutput, kvLines.join("\n") + "\n", "utf-8");
    } catch {
      // Ignore if path unavailable
    }
  }

  // Write GitHub Actions $GITHUB_STEP_SUMMARY
  const stepSummary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (writeSummary && stepSummary) {
    try {
      fs.appendFileSync(stepSummary, summaryMarkdown + "\n", "utf-8");
    } catch {
      // Ignore if path unavailable
    }
  }

  return { summaryMarkdown, reportPath };
}
