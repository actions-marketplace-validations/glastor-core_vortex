/**
 * @module tests/vortex.test
 * @description Comprehensive unit and integration test suite for Vortex AST Impact & LPT Engine.
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
  extractRawImportSpecifiers,
  matchesAnyGlob,
  resolveWorkspaceImport,
} from "../src/ast/analyzer.ts";
import { DependencyDag } from "../src/graph/dag.ts";
import { calculateFinOpsMetrics, scheduleShardsLpt } from "../src/scheduler/lpt-splitter.ts";
import { generateMarkdownSummary } from "../src/reporters/finops-reporter.ts";
import { runVortexAnalysis } from "../src/main.ts";
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

Deno.test("AstAnalyzer: extracts TS symbols with exact line ranges and resolves imports", () => {
  const sampleTs = [
    'import { helper } from "./utils/helper.ts";',
    "export interface UserDto {",
    "  id: string;",
    "  email: string;",
    "}",
    "",
    "export function calculateDiscount(price: number): number {",
    "  const factor = helper(price);",
    "  return price * factor;",
    "}",
    "",
    "export const VERSION = '1.0.0';",
  ].join("\n");

  const imports = extractRawImportSpecifiers(sampleTs, "typescript");
  assert.deepEqual(imports, ["./utils/helper.ts"]);

  const known = new Set(["src/service.ts", "src/utils/helper.ts"]);
  const resolved = resolveWorkspaceImport("src/service.ts", "./utils/helper.ts", known);
  assert.equal(resolved, "src/utils/helper.ts");

  const symbols = extractAstSymbols(sampleTs, "typescript");
  assert.equal(symbols.length, 3);

  assert.equal(symbols[0].name, "UserDto");
  assert.equal(symbols[0].kind, "interface");
  assert.equal(symbols[0].isTypeOnly, true);
  assert.equal(symbols[0].startLine, 2);
  assert.equal(symbols[0].endLine, 5);

  assert.equal(symbols[1].name, "calculateDiscount");
  assert.equal(symbols[1].kind, "function");
  assert.equal(symbols[1].isTypeOnly, false);
  assert.equal(symbols[1].startLine, 7);
  assert.equal(symbols[1].endLine, 10);

  assert.equal(symbols[2].name, "VERSION");
  assert.equal(symbols[2].kind, "const");
  assert.equal(symbols[2].startLine, 12);
});

Deno.test("AstAnalyzer: intersects Diff Hunks with AST Symbol boundaries accurately", () => {
  const modAst: ParsedModule = {
    filePath: "src/pricing.ts",
    language: "typescript",
    isTestFile: false,
    imports: [],
    lineCount: 20,
    testCaseCount: 0,
    symbols: [
      {
        name: "PriceConfig",
        kind: "interface",
        isExported: true,
        isTypeOnly: true,
        startLine: 1,
        endLine: 4,
      },
      {
        name: "computeTotal",
        kind: "function",
        isExported: true,
        isTypeOnly: false,
        startLine: 6,
        endLine: 14,
      },
    ],
  };

  const diff = parseUnifiedDiff(
    [
      "diff --git a/src/pricing.ts b/src/pricing.ts",
      "--- a/src/pricing.ts",
      "+++ b/src/pricing.ts",
      "@@ -8,1 +8,1 @@",
      "-  return subtotal;",
      "+  return subtotal * 1.21;",
    ].join("\n"),
  )[0];

  const mutated = detectMutatedSymbols(diff, modAst);
  assert.equal(mutated.length, 1);
  assert.equal(mutated[0].symbolName, "computeTotal");
  assert.equal(mutated[0].isTypeOnly, false);
});

Deno.test("DependencyDag: computes Reverse DAG transitive closure and shortest impact chain", () => {
  const dag = new DependencyDag();

  // Chain: db.ts <- repo.ts <- service.ts <- service.test.ts
  // Unrelated: utils.ts <- utils.test.ts
  dag.addModule({
    filePath: "src/db.ts",
    language: "typescript",
    isTestFile: false,
    imports: [],
    symbols: [],
    lineCount: 10,
    testCaseCount: 0,
  });
  dag.addModule({
    filePath: "src/repo.ts",
    language: "typescript",
    isTestFile: false,
    imports: ["src/db.ts"],
    symbols: [],
    lineCount: 20,
    testCaseCount: 0,
  });
  dag.addModule({
    filePath: "src/service.ts",
    language: "typescript",
    isTestFile: false,
    imports: ["src/repo.ts"],
    symbols: [],
    lineCount: 30,
    testCaseCount: 0,
  });
  dag.addModule({
    filePath: "tests/service.test.ts",
    language: "typescript",
    isTestFile: true,
    imports: ["src/service.ts"],
    symbols: [],
    lineCount: 40,
    testCaseCount: 4,
  });
  dag.addModule({
    filePath: "src/utils.ts",
    language: "typescript",
    isTestFile: false,
    imports: [],
    symbols: [],
    lineCount: 15,
    testCaseCount: 0,
  });
  dag.addModule({
    filePath: "tests/utils.test.ts",
    language: "typescript",
    isTestFile: true,
    imports: ["src/utils.ts"],
    symbols: [],
    lineCount: 25,
    testCaseCount: 2,
  });

  const impacted = dag.findImpactedTests(["src/db.ts"]);
  assert.equal(impacted.size, 1);
  assert.equal(impacted.has("tests/service.test.ts"), true);
  assert.equal(impacted.has("tests/utils.test.ts"), false);

  const info = impacted.get("tests/service.test.ts")!;
  assert.equal(info.depth, 3);
  assert.deepEqual(info.chain, [
    "src/db.ts",
    "src/repo.ts",
    "src/service.ts",
    "tests/service.test.ts",
  ]);
});

Deno.test("LptSplitter: balances test suites across parallel shards using Greedy LPT", () => {
  const tests: ImpactedTest[] = [
    {
      testFile: "tests/heavy.test.ts",
      impactChain: ["tests/heavy.test.ts"],
      depth: 0,
      estimatedDurationMs: 1000,
      flakinessScore: 0,
      quarantined: false,
    },
    {
      testFile: "tests/med1.test.ts",
      impactChain: ["tests/med1.test.ts"],
      depth: 0,
      estimatedDurationMs: 600,
      flakinessScore: 0,
      quarantined: false,
    },
    {
      testFile: "tests/med2.test.ts",
      impactChain: ["tests/med2.test.ts"],
      depth: 0,
      estimatedDurationMs: 500,
      flakinessScore: 0,
      quarantined: false,
    },
    {
      testFile: "tests/light.test.ts",
      impactChain: ["tests/light.test.ts"],
      depth: 0,
      estimatedDurationMs: 200,
      flakinessScore: 0,
      quarantined: false,
    },
  ];

  // With 2 shards:
  // Sorted: 1000, 600, 500, 200
  // Shard 1 gets 1000, then 200 => 1200ms
  // Shard 2 gets 600, then 500 => 1100ms
  // Optimal makespan = 1200ms (vs 2300ms sequential)
  const { shards, makespanMs } = scheduleShardsLpt(tests, 2);
  assert.equal(shards.length, 2);
  assert.equal(makespanMs, 1200);
  assert.deepEqual(shards[0].files, ["tests/heavy.test.ts", "tests/light.test.ts"]);
  assert.deepEqual(shards[1].files, ["tests/med1.test.ts", "tests/med2.test.ts"]);

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
      version: "1.0.0",
      tests: {
        "tests/heavy.test.ts": { durationMs: 1000, flakinessRate: 0 },
        "tests/med1.test.ts": { durationMs: 600, flakinessRate: 0 },
        "tests/med2.test.ts": { durationMs: 500, flakinessRate: 0 },
        "tests/light.test.ts": { durationMs: 200, flakinessRate: 0 },
      },
    },
    selectedTests: [tests[1]],
    quarantinedTests: [],
    makespanMs: 600,
    runnerCostPerMinUsd: 0.016,
    changedFilesCount: 1,
    totalModulesCount: 10,
    triggeredFailSafe: false,
  });

  assert.equal(finops.totalTestsInRepo, 4);
  assert.equal(finops.selectedTestsCount, 1);
  assert.equal(finops.skippedTestsCount, 3);
  assert.equal(finops.baselineDurationMs, 2300);
  assert.equal(finops.timeSavedMs, 1700);
  assert.equal(finops.timeReductionPercent > 70, true);
});

Deno.test("Config & Glob: parses .vortex.yml, CLI flags, and glob expressions", () => {
  const yaml = `
shards: 8
flaky-quarantine: true
flaky-threshold: 0.4
test-globs:
  - "**/*.test.ts"
  - "**/*.spec.ts"
`;
  const parsed = parseSimpleYaml(yaml);
  assert.equal(parsed.shards, 8);
  assert.equal(parsed["flaky-quarantine"], true);
  assert.deepEqual(parsed["test-globs"], ["**/*.test.ts", "**/*.spec.ts"]);

  assert.equal(matchesAnyGlob("tests/unit/auth.test.ts", ["**/*.test.ts"]), true);
  assert.equal(matchesAnyGlob("src/main.ts", ["**/*.test.ts"]), false);
  assert.equal(matchesAnyGlob(".github/workflows/ci.yml", [".github/workflows/**"]), true);

  const { config } = loadConfig(["--shards", "6", "--ignore-type-only"]);
  assert.equal(config.shards, 6);
  assert.equal(config.ignoreTypeOnlyChanges, true);
  assert.equal(config.flakyQuarantine, true);
});

Deno.test("End-to-End Engine: executes surgical AST analysis, flaky quarantine, and summary generation", () => {
  const tmpDir = fs.mkdtempSync(path.join(Deno.cwd(), ".vortex-test-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".vortex"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, "src", "A.ts"),
      "export function computeA(x: number): number {\n  return x * 2;\n}\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "B.ts"),
      "export function computeB(x: number): number {\n  return x + 10;\n}\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, "tests", "A.test.ts"),
      'import { computeA } from "../src/A.ts";\nDeno.test("A", () => { computeA(2); });\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, "tests", "B.test.ts"),
      'import { computeB } from "../src/B.ts";\nDeno.test("B", () => { computeB(2); });\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, "tests", "flaky.test.ts"),
      'import { computeA } from "../src/A.ts";\nDeno.test("flaky", () => { computeA(1); });\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, ".vortex", "telemetry.json"),
      JSON.stringify({
        version: "1.0.0",
        tests: {
          "tests/A.test.ts": { durationMs: 300, flakinessRate: 0.0 },
          "tests/B.test.ts": { durationMs: 900, flakinessRate: 0.0 },
          "tests/flaky.test.ts": { durationMs: 500, flakinessRate: 0.65 },
        },
      }),
    );

    const simulatedDiff = [
      "diff --git a/src/A.ts b/src/A.ts",
      "--- a/src/A.ts",
      "+++ b/src/A.ts",
      "@@ -2,1 +2,1 @@",
      "-  return x * 2;",
      "+  return x * 3;",
    ].join("\n");

    const result = runVortexAnalysis({
      ...DEFAULT_CONFIG,
      workspaceDir: tmpDir,
      shards: 2,
      rawDiffOverride: simulatedDiff,
    });

    assert.equal(result.executionMode, "surgical");
    assert.equal(result.shouldRun, true);
    assert.equal(result.mutatedSymbols.length, 1);
    assert.equal(result.mutatedSymbols[0].symbolName, "computeA");
    // Only tests/A.test.ts should run; tests/B.test.ts is unaffected; tests/flaky.test.ts is quarantined
    assert.equal(result.impactedTests.length, 1);
    assert.equal(result.impactedTests[0].testFile, "tests/A.test.ts");
    assert.equal(result.quarantinedTests.length, 1);
    assert.equal(result.quarantinedTests[0].testFile, "tests/flaky.test.ts");
    assert.equal(result.finops.skippedTestsCount, 1);

    const summary = generateMarkdownSummary(result);
    assert.equal(summary.includes("SURGICAL AST EXECUTION"), true);
    assert.equal(summary.includes("computeA"), true);
    assert.equal(summary.includes("```mermaid"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
