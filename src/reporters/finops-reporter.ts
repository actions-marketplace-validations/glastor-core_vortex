/**
 * @module reporters/finops-reporter
 * @description Exports GitHub Actions `$GITHUB_OUTPUT`, `$GITHUB_STEP_SUMMARY` Markdown with
 *              Mermaid Blast-Radius DAG visualization, Native GitHub Workflow Annotations,
 *              Sticky PR Comments, and JSON telemetry reports (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  escapeWorkflowCommandData,
  escapeWorkflowCommandProperty,
  isSafeGitHubApiUrl,
  resolveSafeWorkspacePath,
  sanitizeGitHubOutputValue,
} from "../security.ts";
import type { VortexAnalysisResult } from "../types.ts";

export const STICKY_COMMENT_MARKER = "<!-- glastor-core-vortex-sticky-comment -->";

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
 * Generates native GitHub Actions Workflow Command annotations (`::notice`, `::warning`, `::error`)
 * that render inline inside the Pull Request "Files changed" tab and Check summary.
 */
export function buildGitHubWorkflowAnnotations(result: VortexAnalysisResult): string[] {
  const annotations: string[] = [];

  // 1. Notice annotation for overall FinOps acceleration
  annotations.push(
    `::notice title=${
      escapeWorkflowCommandProperty(`Vortex Predictive CI (${result.executionMode.toUpperCase()})`)
    }::${
      escapeWorkflowCommandData(
        `Selected ${result.finops.selectedTestsCount}/${result.finops.totalTestsInRepo} test suites (-${result.finops.timeReductionPercent}% wall-clock time, ${result.finops.prunedBarrelEdgesCount} barrel edges pruned).`,
      )
    }`,
  );

  // 2. Inline file/line annotations for mutated AST symbols
  for (const sym of result.mutatedSymbols.slice(0, 10)) {
    if (sym.symbolName === "<module-scope>") continue;
    annotations.push(
      `::notice file=${escapeWorkflowCommandProperty(sym.filePath)},line=${
        sym.lineRange[0]
      },endLine=${sym.lineRange[1]},title=Vortex Mutated AST Symbol::${
        escapeWorkflowCommandData(
          `Symbol '${sym.symbolName}' (${sym.kind}) modified [L${sym.lineRange[0]}-L${
            sym.lineRange[1]
          }].`,
        )
      }`,
    );
  }

  // 3. Warning annotations for quarantined flaky test suites
  for (const q of result.quarantinedTests) {
    annotations.push(
      `::warning file=${
        escapeWorkflowCommandProperty(q.testFile)
      },line=1,title=Vortex Flaky Test Quarantine::${
        escapeWorkflowCommandData(
          `Isolated unstable test suite '${q.testFile}' (flakiness rate ${
            (q.flakinessScore * 100).toFixed(0)
          }%).`,
        )
      }`,
    );
  }

  // 4. Error annotation if Blast-Radius Gatekeeper threshold was exceeded
  if (!result.governance.blastRadiusPassed) {
    annotations.push(
      `::error title=Vortex Blast-Radius Gatekeeper::${
        escapeWorkflowCommandData(
          `AST Blast-Radius Score (${result.finops.blastRadiusScore}/100) exceeds policy threshold (${result.governance.maxBlastRadiusScore}/100).`,
        )
      }`,
    );
  }

  return annotations;
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

  const getNodeId = (label: string, kind: "src" | "test" | "cfg" | "pruned"): string => {
    if (nodeIds.has(label)) return nodeIds.get(label)!;
    const id = `n${nodeIds.size + 1}`;
    const safeName = path.posix.basename(label);
    const prefix = kind === "test"
      ? "🧪 "
      : kind === "cfg"
      ? "⚙️ "
      : kind === "pruned"
      ? "✂️ "
      : "⚡ ";
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
      const fromId = getNodeId(chain[i], "src");
      const toKind = i === chain.length - 2 ? "test" : "src";
      const toId = getNodeId(chain[i + 1], toKind);
      edges.add(`  ${fromId} --> ${toId}`);
    }
  }

  for (const pruned of result.prunedEdges.slice(0, 5)) {
    const fromId = getNodeId(pruned.fromFile, "src");
    const toId = getNodeId(pruned.toFile, "pruned");
    edges.add(`  ${fromId} -. "pruned (${pruned.importedSymbols.join(",")})" .-> ${toId}`);
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

  const gateBadge = result.governance.blastRadiusPassed
    ? `✅ Passed (\`${result.finops.blastRadiusScore} <= ${result.governance.maxBlastRadiusScore}\`)`
    : `❌ Exceeded (\`${result.finops.blastRadiusScore} > ${result.governance.maxBlastRadiusScore}\`)`;

  const ticketList = result.governance.detectedTicketIds.length > 0
    ? `\`${result.governance.detectedTicketIds.join("`, `")}\``
    : "_None detected_";

  const md: string[] = [
    STICKY_COMMENT_MARKER,
    `## ⚡ Vortex — AST-Driven Predictive CI & Impact Graph Report`,
    "",
    `> **Execution Strategy:** ${modeBadge} — _${result.modeReason}_`,
    "",
    `### 📊 FinOps, Symbol Pruning & Governance Telemetry`,
    "",
    `| Metric | Baseline (Full Suite) | Vortex Optimized | Impact / Savings |`,
    `| :--- | :---: | :---: | :---: |`,
    `| **Executable Test Suites** | \`${result.finops.totalTestsInRepo}\` | \`${result.finops.selectedTestsCount}\` | **\`${result.finops.skippedTestsCount}\` safely skipped** |`,
    `| **Symbol-Level Barrel Pruning** | \`0\` | \`${result.finops.prunedBarrelEdgesCount} edge(s)\` | Unrelated symbol imports pruned |`,
    `| **Pipeline Wall-Clock (Makespan)** | \`${
      formatDuration(result.finops.baselineDurationMs)
    }\` | \`${
      formatDuration(result.finops.optimizedMakespanMs)
    }\` | **-${result.finops.timeReductionPercent}% (${
      formatDuration(result.finops.timeSavedMs)
    } saved)** |`,
    `| **Blast-Radius Gatekeeper** | \`100 / 100\` | \`${result.finops.blastRadiusScore} / 100\` | ${gateBadge} |`,
    `| **Linked Ticket / Issue IDs** | — | ${ticketList} | DevSecOps Target Files: \`${result.governance.nemesisTargetFiles.length}\` |`,
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

  if (result.prunedEdges.length > 0) {
    md.push(
      `### ✂️ Symbol-Level Pruned Barrel Edges`,
      "",
      `| Modified Source | Consumer File | Imported Symbols | Mutated in Source |`,
      `| :--- | :--- | :---: | :---: |`,
    );
    for (const p of result.prunedEdges.slice(0, 15)) {
      md.push(
        `| \`${p.fromFile}\` | \`${p.toFile}\` | \`${p.importedSymbols.join(", ")}\` | \`${
          p.mutatedSymbolsInSource.join(", ")
        }\` |`,
      );
    }
    md.push("");
  }

  if (result.shards.length > 0) {
    md.push(
      `### ⚖️ LPT Dynamic Matrix Shards (Fail-Fast Ordered)`,
      "",
      `| Shard ID | Assigned Test Suites (Fail-Fast Order) | Est. Makespan | CLI Command |`,
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
 * Posts or updates an idempotent sticky Pull Request comment on GitHub when `GITHUB_TOKEN`
 * and PR context (`GITHUB_EVENT_PATH`) are available.
 */
export async function postOrUpdateStickyPrComment(summaryMarkdown: string): Promise<boolean> {
  const token = Deno.env.get("GITHUB_TOKEN");
  const repo = Deno.env.get("GITHUB_REPOSITORY");
  const eventPath = Deno.env.get("GITHUB_EVENT_PATH");
  const apiUrl = Deno.env.get("GITHUB_API_URL") || "https://api.github.com";

  if (
    !token ||
    !repo ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    !isSafeGitHubApiUrl(apiUrl) ||
    !eventPath ||
    !fs.existsSync(eventPath)
  ) {
    return false;
  }

  try {
    const eventPayload = JSON.parse(fs.readFileSync(eventPath, "utf-8"));
    const prNumber = Number(eventPayload?.pull_request?.number ?? eventPayload?.issue?.number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return false;

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const commentsUrl = `${
      apiUrl.replace(/\/$/, "")
    }/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
    const listRes = await fetch(commentsUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!listRes.ok) return false;

    const comments = (await listRes.json()) as Array<{ id: number; body?: string }>;
    const existing = comments.find((c) => c.body && c.body.includes(STICKY_COMMENT_MARKER));

    if (existing) {
      const patchRes = await fetch(
        `${apiUrl.replace(/\/$/, "")}/repos/${repo}/issues/comments/${existing.id}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ body: summaryMarkdown }),
          signal: AbortSignal.timeout(5000),
        },
      );
      return patchRes.ok;
    } else {
      const postRes = await fetch(
        `${apiUrl.replace(/\/$/, "")}/repos/${repo}/issues/${prNumber}/comments`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ body: summaryMarkdown }),
          signal: AbortSignal.timeout(5000),
        },
      );
      return postRes.ok;
    }
  } catch {
    return false;
  }
}

/**
 * Writes analysis outputs to `$GITHUB_OUTPUT`, `$GITHUB_STEP_SUMMARY`, workflow annotations, and the JSON report file.
 */
export function emitVortexReports(
  result: VortexAnalysisResult,
  workspaceDir: string,
  reportFile: string,
  writeSummary: boolean,
  emitAnnotations = false,
): { summaryMarkdown: string; reportPath: string; annotations: string[] } {
  const summaryMarkdown = generateMarkdownSummary(result);
  let reportPath = path.resolve(workspaceDir, "vortex-report.json");

  try {
    reportPath = resolveSafeWorkspacePath(workspaceDir, reportFile);
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf-8");
  } catch {
    // Non-fatal if read-only filesystem or blocked path traversal
  }

  const annotations = buildGitHubWorkflowAnnotations(result);
  if (emitAnnotations && Deno.env.get("GITHUB_ACTIONS") === "true") {
    for (const line of annotations) {
      console.log(line);
    }
  }

  const githubOutput = Deno.env.get("GITHUB_OUTPUT");
  if (githubOutput) {
    const affectedList = sanitizeGitHubOutputValue(
      result.impactedTests.map((t) => t.testFile).join(" "),
    );
    const quarantinedList = sanitizeGitHubOutputValue(
      result.quarantinedTests.map((t) => t.testFile).join(" "),
    );
    const timeSavedSec = Math.round(result.finops.timeSavedMs / 100) / 10;
    const ticketIdsStr = sanitizeGitHubOutputValue(result.governance.detectedTicketIds.join(","));
    const nemesisFilesStr = sanitizeGitHubOutputValue(
      result.governance.nemesisTargetFiles.join(" "),
    );

    const kvLines = [
      `should-run=${sanitizeGitHubOutputValue(result.shouldRun)}`,
      `execution-mode=${sanitizeGitHubOutputValue(result.executionMode)}`,
      `affected-tests=${affectedList}`,
      `affected-count=${sanitizeGitHubOutputValue(result.finops.selectedTestsCount)}`,
      `skipped-count=${sanitizeGitHubOutputValue(result.finops.skippedTestsCount)}`,
      `pruned-edges-count=${sanitizeGitHubOutputValue(result.finops.prunedBarrelEdgesCount)}`,
      `quarantined-tests=${quarantinedList}`,
      `time-saved-seconds=${sanitizeGitHubOutputValue(timeSavedSec)}`,
      `savings-percent=${sanitizeGitHubOutputValue(result.finops.timeReductionPercent)}`,
      `blast-radius-score=${sanitizeGitHubOutputValue(result.finops.blastRadiusScore)}`,
      `blast-radius-passed=${sanitizeGitHubOutputValue(result.governance.blastRadiusPassed)}`,
      `ticket-ids=${ticketIdsStr}`,
      `nemesis-target-files=${nemesisFilesStr}`,
      `matrix=${sanitizeGitHubOutputValue(JSON.stringify(result.matrix))}`,
      `report-path=${sanitizeGitHubOutputValue(reportPath)}`,
    ];
    try {
      fs.appendFileSync(githubOutput, kvLines.join("\n") + "\n", "utf-8");
    } catch {
      // Ignore if path unavailable
    }
  }

  const stepSummary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (writeSummary && stepSummary) {
    try {
      fs.appendFileSync(stepSummary, summaryMarkdown + "\n", "utf-8");
    } catch {
      // Ignore if path unavailable
    }
  }

  return { summaryMarkdown, reportPath, annotations };
}
