/**
 * @module tests/vortex.test
 * @description Comprehensive unit and integration test suite for Vortex v1.1.0 AST Impact,
 *              Symbol-Level Barrel Pruning, Monorepo Aliases, and Governance Gatekeeper.
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, loadConfig, parseSimpleYaml } from "../src/config.ts";
import {
  evaluateHunkSemanticNoise,
  isCommentOrBlankLine,
  parseUnifiedDiff,
} from "../src/git/diff-parser.ts";
import {
  detectMutatedSymbols,
  extractAstSymbols,
  extractImportBindings,
  extractRawImportSpecifiers,
  loadWorkspacePathAliases,
  matchesAnyGlob,
  resolveWorkspaceImport,
} from "../src/ast/analyzer.ts";
import { DependencyDag } from "../src/graph/dag.ts";
import { calculateFinOpsMetrics, scheduleShardsLpt } from "../src/scheduler/lpt-splitter.ts";
import { extractTicketIds } from "../src/governance/gatekeeper.ts";
import {
  buildGitHubWorkflowAnnotations,
  generateMarkdownSummary,
} from "../src/reporters/finops-reporter.ts";
import { runVortexAnalysis } from "../src/main.ts";
import {
  escapeWorkflowCommandData,
  escapeWorkflowCommandProperty,
  isSafeGitHubApiUrl,
  isSafeRelativeFilePath,
  isValidGitRef,
  resolveSafeWorkspacePath,
  sanitizeGitHubOutputValue,
} from "../src/security.ts";
import type { ImpactedTest, ParsedModule } from "../src/types.ts";

Deno.test("DiffParser: parses unified=0 hunks and detects comment-only noise", () => {
  const rawDiff = [
    "diff --git a/src/math.ts b/src/math.ts",
    "index 1111111..2222222 100644",
    "--- a/src/math.ts",
    "+++ b/src/math.ts",
    "@@ -10,2 +10,3 @@",
    "-  return a + b;",
    "+  // Added validation",
    "+  return a + b + 1;",
    "diff --git a/src/docs-only.ts b/src/docs-only.ts",
    "index 3333333..4444444 100644",
    "--- a/src/docs-only.ts",
    "+++ b/src/docs-only.ts",
    "@@ -1,1 +1,2 @@",
    "-// Old comment",
    "+// New improved comment",
    "+// Second comment line",
  ].join("\n");

  const parsed = parseUnifiedDiff(rawDiff);
  assert.equal(parsed.length, 2);

  assert.equal(parsed[0].filePath, "src/math.ts");
  assert.equal(parsed[0].isCommentOrFormatOnly, false);
  assert.equal(parsed[0].hunks.length, 1);
  assert.equal(parsed[0].hunks[0].startLine, 10);
  assert.equal(parsed[0].hunks[0].endLine, 12);

  assert.equal(parsed[1].filePath, "src/docs-only.ts");
  assert.equal(parsed[1].isCommentOrFormatOnly, true);
  assert.equal(isCommentOrBlankLine("   // comment"), true);
  assert.equal(evaluateHunkSemanticNoise(["  const x = 1;"], ["const x=1;"]), true);
});

Deno.test("AstAnalyzer: extracts TS symbols, intra-module call references, and import bindings", () => {
  const sampleTs = [
    'import { helper, unusedHelper as uh } from "./utils/helper.ts";',
    "export interface UserDto {",
    "  id: string;",
    "  email: string;",
    "}",
    "",
    "export function baseRate(price: number): number {",
    "  return helper(price);",
    "}",
    "",
    "export function calculateDiscount(price: number): number {",
    "  const factor = baseRate(price);",
    "  return price * factor;",
    "}",
    "",
    "export const VERSION = '1.1.0';",
  ].join("\n");

  const imports = extractRawImportSpecifiers(sampleTs, "typescript");
  assert.deepEqual(imports, ["./utils/helper.ts"]);

  const known = new Set(["src/service.ts", "src/utils/helper.ts"]);
  const resolved = resolveWorkspaceImport("src/service.ts", "./utils/helper.ts", known);
  assert.equal(resolved, "src/utils/helper.ts");

  const bindings = extractImportBindings(sampleTs, "typescript", "src/service.ts", known);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].resolvedFilePath, "src/utils/helper.ts");
  assert.deepEqual(bindings[0].importedSymbols, ["helper", "unusedHelper"]);

  const symbols = extractAstSymbols(sampleTs, "typescript");
  assert.equal(symbols.length, 4);
  assert.equal(symbols[1].name, "baseRate");
  assert.equal(symbols[2].name, "calculateDiscount");
  assert.equal(symbols[2].referencedIdentifiers?.includes("baseRate"), true);
});

Deno.test("AstAnalyzer: expands intra-module callers when a helper symbol is mutated", () => {
  const modAst: ParsedModule = {
    filePath: "src/pricing.ts",
    language: "typescript",
    isTestFile: false,
    imports: [],
    lineCount: 25,
    testCaseCount: 0,
    symbols: [
      {
        name: "internalTaxRate",
        kind: "function",
        isExported: false,
        isTypeOnly: false,
        startLine: 1,
        endLine: 4,
        referencedIdentifiers: [],
      },
      {
        name: "computeTotal",
        kind: "function",
        isExported: true,
        isTypeOnly: false,
        startLine: 6,
        endLine: 12,
        referencedIdentifiers: ["internalTaxRate"],
      },
      {
        name: "formatCurrency",
        kind: "function",
        isExported: true,
        isTypeOnly: false,
        startLine: 14,
        endLine: 18,
        referencedIdentifiers: [],
      },
    ],
  };

  // Diff only touches line 2 inside `internalTaxRate`, which is called by `computeTotal`
  const diff = parseUnifiedDiff(
    [
      "diff --git a/src/pricing.ts b/src/pricing.ts",
      "--- a/src/pricing.ts",
      "+++ b/src/pricing.ts",
      "@@ -2,1 +2,1 @@",
      "-  return 0.19;",
      "+  return 0.21;",
    ].join("\n"),
  )[0];

  const mutated = detectMutatedSymbols(diff, modAst);
  const mutatedNames = mutated.map((m) => m.symbolName);
  assert.equal(mutatedNames.includes("internalTaxRate"), true);
  assert.equal(mutatedNames.includes("computeTotal"), true);
  assert.equal(mutatedNames.includes("formatCurrency"), false);
});

Deno.test("DependencyDag: performs Symbol-Level Barrel Pruning on shared utility modules", () => {
  const dag = new DependencyDag();

  // `src/utils.ts` exports `fnA` and `fnB`
  dag.addModule({
    filePath: "src/utils.ts",
    language: "typescript",
    isTestFile: false,
    imports: [],
    symbols: [
      {
        name: "fnA",
        kind: "function",
        isExported: true,
        isTypeOnly: false,
        startLine: 1,
        endLine: 3,
      },
      {
        name: "fnB",
        kind: "function",
        isExported: true,
        isTypeOnly: false,
        startLine: 5,
        endLine: 7,
      },
    ],
    lineCount: 8,
    testCaseCount: 0,
  });

  // `tests/a.test.ts` imports `{ fnA }`
  dag.addModule({
    filePath: "tests/a.test.ts",
    language: "typescript",
    isTestFile: true,
    imports: ["src/utils.ts"],
    importBindings: [
      {
        rawSpecifier: "../src/utils.ts",
        resolvedFilePath: "src/utils.ts",
        importedSymbols: ["fnA"],
        isReExport: false,
      },
    ],
    symbols: [],
    lineCount: 10,
    testCaseCount: 1,
  });

  // `tests/b.test.ts` ONLY imports `{ fnB }`
  dag.addModule({
    filePath: "tests/b.test.ts",
    language: "typescript",
    isTestFile: true,
    imports: ["src/utils.ts"],
    importBindings: [
      {
        rawSpecifier: "../src/utils.ts",
        resolvedFilePath: "src/utils.ts",
        importedSymbols: ["fnB"],
        isReExport: false,
      },
    ],
    symbols: [],
    lineCount: 10,
    testCaseCount: 1,
  });

  // Only `fnA` was mutated in `src/utils.ts`!
  const seedActiveSymbols = new Map<string, Set<string>>([
    ["src/utils.ts", new Set(["fnA"])],
  ]);

  const { impactedTests, prunedEdges } = dag.findImpactedTestsWithPruning(
    ["src/utils.ts"],
    {
      symbolLevelPruning: true,
      seedActiveSymbols,
    },
  );

  // `tests/a.test.ts` is impacted; `tests/b.test.ts` is surgically pruned!
  assert.equal(impactedTests.size, 1);
  assert.equal(impactedTests.has("tests/a.test.ts"), true);
  assert.equal(impactedTests.has("tests/b.test.ts"), false);
  assert.equal(prunedEdges.length, 1);
  assert.equal(prunedEdges[0].fromFile, "src/utils.ts");
  assert.equal(prunedEdges[0].toFile, "tests/b.test.ts");
});

Deno.test("LptSplitter: balances shards with Greedy LPT and orders intra-shard by Fail-Fast priority", () => {
  const tests: ImpactedTest[] = [
    {
      testFile: "tests/heavy-deep.test.ts",
      impactChain: ["src/a.ts", "src/b.ts", "src/c.ts", "tests/heavy-deep.test.ts"],
      depth: 3,
      estimatedDurationMs: 1000,
      flakinessScore: 0,
      quarantined: false,
    },
    {
      testFile: "tests/med1.test.ts",
      impactChain: ["src/a.ts", "tests/med1.test.ts"],
      depth: 1,
      estimatedDurationMs: 600,
      flakinessScore: 0,
      quarantined: false,
    },
    {
      testFile: "tests/med2.test.ts",
      impactChain: ["src/a.ts", "tests/med2.test.ts"],
      depth: 1,
      estimatedDurationMs: 500,
      flakinessScore: 0,
      quarantined: false,
    },
    {
      testFile: "tests/direct-fast.test.ts",
      impactChain: ["tests/direct-fast.test.ts"],
      depth: 0,
      estimatedDurationMs: 200,
      flakinessScore: 0.2,
      quarantined: false,
    },
  ];

  // Shard 1 receives `heavy-deep.test.ts` (1000ms, depth 3) and `direct-fast.test.ts` (200ms, depth 0).
  // Fail-Fast Intra-Shard ordering MUST place `direct-fast.test.ts` BEFORE `heavy-deep.test.ts`!
  const { shards, makespanMs } = scheduleShardsLpt(tests, 2);
  assert.equal(shards.length, 2);
  assert.equal(makespanMs, 1200);
  assert.deepEqual(shards[0].files, ["tests/direct-fast.test.ts", "tests/heavy-deep.test.ts"]);
  assert.deepEqual(shards[1].files, ["tests/med2.test.ts", "tests/med1.test.ts"]);

  const finops = calculateFinOpsMetrics({
    allTestModules: tests.map((t) => ({
      filePath: t.testFile,
      language: "typescript",
      isTestFile: true,
      imports: [],
      symbols: [],
      lineCount: 50,
      testCaseCount: 3,
    })),
    telemetryStore: {
      version: "1.1.0",
      tests: {
        "tests/heavy-deep.test.ts": { durationMs: 1000, flakinessRate: 0 },
        "tests/med1.test.ts": { durationMs: 600, flakinessRate: 0 },
        "tests/med2.test.ts": { durationMs: 500, flakinessRate: 0 },
        "tests/direct-fast.test.ts": { durationMs: 200, flakinessRate: 0.2 },
      },
    },
    selectedTests: [tests[1]],
    quarantinedTests: [],
    prunedBarrelEdgesCount: 2,
    makespanMs: 600,
    runnerCostPerMinUsd: 0.016,
    changedFilesCount: 1,
    totalModulesCount: 10,
    triggeredFailSafe: false,
  });

  assert.equal(finops.prunedBarrelEdgesCount, 2);
  assert.equal(finops.timeReductionPercent > 70, true);
});

Deno.test("Governance & Config: extracts Jira/Linear/GitHub issue IDs and parses .vortex.yml", () => {
  const tickets = extractTicketIds([
    "feat/GLS-402-ast-barrel-pruning",
    "fix(core): resolve PROJ-99 and closes #42 (SHA-256 UTF-8 ignored)",
  ]);
  assert.deepEqual(tickets, ["GLS-402", "PROJ-99", "#42"]);

  const yaml = `
shards: 8
symbol-pruning: true
max-blast-radius: 75
test-globs:
  - "**/*.test.ts"
`;
  const parsed = parseSimpleYaml(yaml);
  assert.equal(parsed.shards, 8);
  assert.equal(parsed["symbol-pruning"], true);
  assert.equal(parsed["max-blast-radius"], 75);

  assert.equal(matchesAnyGlob("tests/unit/auth.test.ts", ["**/*.test.ts"]), true);

  const { config } = loadConfig([
    "--shards",
    "6",
    "--ignore-type-only",
    "--max-blast-radius",
    "80",
  ]);
  assert.equal(config.shards, 6);
  assert.equal(config.ignoreTypeOnlyChanges, true);
  assert.equal(config.maxBlastRadius, 80);
});

Deno.test("End-to-End Engine: executes Monorepo Alias resolution, Barrel Pruning, and Annotations", () => {
  const tmpDir = fs.mkdtempSync(path.join(Deno.cwd(), ".vortex-test-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".vortex"), { recursive: true });

    // Configure path alias `@core/* -> src/*` in tsconfig.json
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@core/*": ["src/*"],
          },
        },
      }),
    );

    const aliases = loadWorkspacePathAliases(tmpDir);
    assert.equal(aliases.get("@core/"), "src/");

    // `src/barrel.ts` has `computeA` (L1-L3) and `computeB` (L5-L7)
    fs.writeFileSync(
      path.join(tmpDir, "src", "barrel.ts"),
      [
        "export function computeA(x: number): number {",
        "  return x * 2;",
        "}",
        "",
        "export function computeB(x: number): number {",
        "  return x + 10;",
        "}",
      ].join("\n"),
    );

    // `tests/A.test.ts` imports `computeA` via `@core/barrel.ts` alias
    fs.writeFileSync(
      path.join(tmpDir, "tests", "A.test.ts"),
      'import { computeA } from "@core/barrel.ts";\nDeno.test("A", () => { computeA(2); });\n',
    );
    // `tests/B.test.ts` imports ONLY `computeB` from `../src/barrel.ts`
    fs.writeFileSync(
      path.join(tmpDir, "tests", "B.test.ts"),
      'import { computeB } from "../src/barrel.ts";\nDeno.test("B", () => { computeB(2); });\n',
    );
    // `tests/flaky.test.ts` imports `computeA` but is flaky
    fs.writeFileSync(
      path.join(tmpDir, "tests", "flaky.test.ts"),
      'import { computeA } from "../src/barrel.ts";\nDeno.test("flaky", () => { computeA(1); });\n',
    );

    fs.writeFileSync(
      path.join(tmpDir, ".vortex", "telemetry.json"),
      JSON.stringify({
        version: "1.1.0",
        tests: {
          "tests/A.test.ts": { durationMs: 300, flakinessRate: 0.0 },
          "tests/B.test.ts": { durationMs: 900, flakinessRate: 0.0 },
          "tests/flaky.test.ts": { durationMs: 500, flakinessRate: 0.65 },
        },
      }),
    );

    // Diff ONLY modifies `computeA` on line 2 of `src/barrel.ts`!
    const simulatedDiff = [
      "diff --git a/src/barrel.ts b/src/barrel.ts",
      "--- a/src/barrel.ts",
      "+++ b/src/barrel.ts",
      "@@ -2,1 +2,1 @@",
      "-  return x * 2;",
      "+  return x * 3;",
    ].join("\n");

    const result = runVortexAnalysis({
      ...DEFAULT_CONFIG,
      workspaceDir: tmpDir,
      shards: 2,
      symbolLevelPruning: true,
      maxBlastRadius: 85,
      ticketContext: "feat/GLS-777-smart-pruning",
      rawDiffOverride: simulatedDiff,
    });

    assert.equal(result.executionMode, "surgical");
    assert.equal(result.shouldRun, true);
    assert.equal(result.mutatedSymbols.length, 1);
    assert.equal(result.mutatedSymbols[0].symbolName, "computeA");

    // `tests/B.test.ts` imported `src/barrel.ts`, but ONLY `computeB` -> Pruned by Symbol-Level Pruning!
    assert.equal(result.prunedEdges.length, 1);
    assert.equal(result.prunedEdges[0].toFile, "tests/B.test.ts");
    assert.equal(result.impactedTests.length, 1);
    assert.equal(result.impactedTests[0].testFile, "tests/A.test.ts");
    assert.equal(result.quarantinedTests.length, 1);
    assert.equal(result.quarantinedTests[0].testFile, "tests/flaky.test.ts");
    assert.deepEqual(result.governance.detectedTicketIds, ["GLS-777"]);
    assert.equal(result.governance.blastRadiusPassed, true);

    const annotations = buildGitHubWorkflowAnnotations(result);
    assert.equal(annotations.some((a) => a.includes("::notice file=src/barrel.ts")), true);
    assert.equal(annotations.some((a) => a.includes("::warning file=tests/flaky.test.ts")), true);

    const summary = generateMarkdownSummary(result);
    assert.equal(summary.includes("Symbol-Level Pruned Barrel Edges"), true);
    assert.equal(summary.includes("GLS-777"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

Deno.test("AppSec Zero-Trust Guards: blocks CWE-88, CWE-22, CWE-78, CWE-93, and CWE-918 vectors", () => {
  // CWE-88 Git Argument Injection
  assert.equal(isValidGitRef("HEAD~1"), true);
  assert.equal(isValidGitRef("origin/main"), true);
  assert.equal(isValidGitRef("--output=/tmp/pwn"), false);
  assert.equal(isValidGitRef("-c"), false);
  assert.equal(isValidGitRef("main;rm -rf /"), false);

  // CWE-22 & CWE-78 Relative File Path Validation
  assert.equal(isSafeRelativeFilePath("src/graph/dag.ts"), true);
  assert.equal(isSafeRelativeFilePath("../etc/passwd"), false);
  assert.equal(isSafeRelativeFilePath("src/../../secret.ts"), false);
  assert.equal(isSafeRelativeFilePath("tests/foo;id.test.ts"), false);
  assert.equal(isSafeRelativeFilePath("tests/foo\nbar.test.ts"), false);

  // CWE-22 Workspace Containment
  const root = Deno.cwd();
  assert.equal(resolveSafeWorkspacePath(root, "vortex-report.json").startsWith(root), true);
  assert.throws(() => resolveSafeWorkspacePath(root, "../../outside.json"), /CWE-22/);

  // CWE-93 Workflow Command & GITHUB_OUTPUT Injection Escaping
  assert.equal(escapeWorkflowCommandData("line1\n::error::injected"), "line1%0A::error::injected");
  assert.equal(escapeWorkflowCommandProperty("a,b:c\n"), "a%2Cb%3Ac%0A");
  assert.equal(sanitizeGitHubOutputValue("true\nshould-run=false"), "true should-run=false");

  // CWE-918 SSRF HTTPS Enforcement
  assert.equal(isSafeGitHubApiUrl("https://api.github.com"), true);
  assert.equal(isSafeGitHubApiUrl("http://169.254.169.254/latest/meta-data"), false);
  assert.equal(isSafeGitHubApiUrl("file:///etc/passwd"), false);
});
