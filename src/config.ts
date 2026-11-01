/**
 * @module config
 * @description Configuration loader for Vortex CLI, GitHub Action inputs, and `.vortex.yml` (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import { parseArgs } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import type { VortexConfig } from "./types.ts";

export const VORTEX_VERSION = "1.1.0";

export const DEFAULT_CONFIG: VortexConfig = {
  workspaceDir: Deno.cwd(),
  baseRef: "HEAD~1",
  headRef: "HEAD",
  shards: 4,
  testGlobs: [
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*_test.ts",
    "**/*.test.js",
    "**/*.spec.js",
    "**/*_test.py",
    "**/test_*.py",
    "**/*_test.go",
  ],
  failSafeGlobs: [
    "deno.json",
    "deno.jsonc",
    "deno.lock",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "Cargo.toml",
    "pyproject.toml",
    ".vortex.yml",
    ".github/workflows/**",
  ],
  ignoreDirs: [
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    "target",
    "__pycache__",
    ".venv",
    "vendor",
  ],
  telemetryPath: ".vortex/telemetry.json",
  ewmaAlpha: 0.3,
  flakyQuarantine: true,
  flakyThreshold: 0.35,
  ignoreTypeOnlyChanges: false,
  symbolLevelPruning: true,
  maxBlastRadius: 100,
  failOnBlastRadius: false,
  emitAnnotations: true,
  postPrComment: false,
  runnerCostPerMinUsd: 0.016,
  reportFile: "vortex-report.json",
  writeSummary: true,
};

/**
 * Lightweight zero-dependency YAML parser for `.vortex.yml` configuration files.
 * Supports key-value scalars, booleans, numbers, inline arrays (`[a, b]`), and block lists (`- item`).
 */
export function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let currentListKey: string | null = null;
  let currentList: string[] = [];

  const flushList = () => {
    if (currentListKey !== null) {
      result[currentListKey] = currentList;
      currentListKey = null;
      currentList = [];
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed.startsWith("- ") && currentListKey !== null) {
      const itemVal = stripQuotes(trimmed.slice(2).split(/\s+#/)[0].trim());
      if (itemVal) currentList.push(itemVal);
      continue;
    }

    flushList();

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawVal = trimmed.slice(colonIdx + 1).split(/\s+#/)[0].trim();

    if (!rawVal) {
      currentListKey = key;
      currentList = [];
      continue;
    }

    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      const inner = rawVal.slice(1, -1).trim();
      result[key] = inner ? inner.split(",").map((s) => stripQuotes(s.trim())).filter(Boolean) : [];
    } else if (rawVal === "true" || rawVal === "false") {
      result[key] = rawVal === "true";
    } else if (!Number.isNaN(Number(rawVal)) && rawVal !== "") {
      result[key] = Number(rawVal);
    } else {
      result[key] = stripQuotes(rawVal);
    }
  }

  flushList();
  return result;
}

function stripQuotes(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

function parseCommaList(val: string | undefined, fallback: string[]): string[] {
  if (!val || !val.trim()) return fallback;
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseBool(val: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const norm = val.trim().toLowerCase();
    if (norm === "true" || norm === "1" || norm === "yes") return true;
    if (norm === "false" || norm === "0" || norm === "no") return false;
  }
  return fallback;
}

/**
 * Loads and merges Vortex configuration from defaults, `.vortex.yml`, GitHub Action `INPUT_*` env vars, and CLI flags.
 */
export function loadConfig(cliArgs: string[] = Deno.args): {
  config: VortexConfig;
  helpRequested: boolean;
  versionRequested: boolean;
} {
  const parsed = parseArgs({
    args: cliArgs,
    options: {
      config: { type: "string", short: "c", default: ".vortex.yml" },
      workspace: { type: "string", short: "w" },
      "base-ref": { type: "string", short: "b" },
      "head-ref": { type: "string", short: "h" },
      shards: { type: "string", short: "s" },
      "test-globs": { type: "string" },
      "fail-safe-globs": { type: "string" },
      "telemetry-path": { type: "string" },
      "update-telemetry": { type: "string" },
      "ewma-alpha": { type: "string" },
      "flaky-quarantine": { type: "boolean", default: true },
      "no-flaky-quarantine": { type: "boolean", default: false },
      "flaky-threshold": { type: "string" },
      "ignore-type-only": { type: "boolean", default: false },
      "symbol-pruning": { type: "boolean", default: true },
      "no-symbol-pruning": { type: "boolean", default: false },
      "max-blast-radius": { type: "string" },
      "fail-on-blast-radius": { type: "boolean", default: false },
      "ticket-context": { type: "string" },
      "emit-annotations": { type: "boolean", default: true },
      "no-emit-annotations": { type: "boolean", default: false },
      "post-pr-comment": { type: "boolean", default: false },
      "runner-cost": { type: "string" },
      "report-file": { type: "string", short: "o" },
      "write-summary": { type: "boolean", default: true },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    strict: false,
  });

  const workspaceDir = path.resolve(
    (parsed.values.workspace as string | undefined) ||
      Deno.env.get("INPUT_WORKSPACE") ||
      Deno.env.get("GITHUB_WORKSPACE") ||
      DEFAULT_CONFIG.workspaceDir,
  );

  const configPath = path.resolve(
    workspaceDir,
    (parsed.values.config as string | undefined) ||
      Deno.env.get("INPUT_CONFIG_PATH") ||
      ".vortex.yml",
  );

  let fileCfg: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const rawYaml = fs.readFileSync(configPath, "utf-8");
      fileCfg = parseSimpleYaml(rawYaml);
    } catch {
      // Ignore malformed optional config file and use defaults
    }
  }

  const baseRef = (parsed.values["base-ref"] as string | undefined) ||
    Deno.env.get("INPUT_BASE_REF") ||
    (fileCfg["base-ref"] as string | undefined) ||
    DEFAULT_CONFIG.baseRef;

  const headRef = (parsed.values["head-ref"] as string | undefined) ||
    Deno.env.get("INPUT_HEAD_REF") ||
    (fileCfg["head-ref"] as string | undefined) ||
    DEFAULT_CONFIG.headRef;

  const rawShards = (parsed.values.shards as string | undefined) ||
    Deno.env.get("INPUT_SHARDS") ||
    String(fileCfg.shards ?? DEFAULT_CONFIG.shards);
  const shards = Math.max(
    1,
    Math.min(64, Number.parseInt(rawShards, 10) || DEFAULT_CONFIG.shards),
  );

  const testGlobs = parsed.values["test-globs"]
    ? parseCommaList(parsed.values["test-globs"] as string, DEFAULT_CONFIG.testGlobs)
    : Deno.env.get("INPUT_TEST_GLOBS")
    ? parseCommaList(Deno.env.get("INPUT_TEST_GLOBS"), DEFAULT_CONFIG.testGlobs)
    : Array.isArray(fileCfg["test-globs"])
    ? (fileCfg["test-globs"] as string[])
    : DEFAULT_CONFIG.testGlobs;

  const failSafeGlobs = parsed.values["fail-safe-globs"]
    ? parseCommaList(parsed.values["fail-safe-globs"] as string, DEFAULT_CONFIG.failSafeGlobs)
    : Deno.env.get("INPUT_FAIL_SAFE_GLOBS")
    ? parseCommaList(Deno.env.get("INPUT_FAIL_SAFE_GLOBS"), DEFAULT_CONFIG.failSafeGlobs)
    : Array.isArray(fileCfg["fail-safe-globs"])
    ? (fileCfg["fail-safe-globs"] as string[])
    : DEFAULT_CONFIG.failSafeGlobs;

  const ignoreDirs = Array.isArray(fileCfg["ignore-dirs"])
    ? (fileCfg["ignore-dirs"] as string[])
    : DEFAULT_CONFIG.ignoreDirs;

  const telemetryPath = (parsed.values["telemetry-path"] as string | undefined) ||
    Deno.env.get("INPUT_TELEMETRY_PATH") ||
    (fileCfg["telemetry-path"] as string | undefined) ||
    DEFAULT_CONFIG.telemetryPath;

  const updateTelemetryFromReport = (parsed.values["update-telemetry"] as string | undefined) ||
    Deno.env.get("INPUT_UPDATE_TELEMETRY") ||
    (fileCfg["update-telemetry"] as string | undefined);

  const rawAlpha = (parsed.values["ewma-alpha"] as string | undefined) ||
    Deno.env.get("INPUT_EWMA_ALPHA") ||
    String(fileCfg["ewma-alpha"] ?? DEFAULT_CONFIG.ewmaAlpha);
  const ewmaAlpha = Math.max(
    0.05,
    Math.min(0.95, Number.parseFloat(rawAlpha) || DEFAULT_CONFIG.ewmaAlpha),
  );

  let flakyQuarantine = parseBool(
    Deno.env.get("INPUT_FLAKY_QUARANTINE") ??
      (fileCfg["flaky-quarantine"] as boolean | string | undefined),
    DEFAULT_CONFIG.flakyQuarantine,
  );
  if (parsed.values["no-flaky-quarantine"] === true) {
    flakyQuarantine = false;
  } else if (cliArgs.includes("--flaky-quarantine")) {
    flakyQuarantine = true;
  }

  const rawThreshold = (parsed.values["flaky-threshold"] as string | undefined) ||
    Deno.env.get("INPUT_FLAKY_THRESHOLD") ||
    String(fileCfg["flaky-threshold"] ?? DEFAULT_CONFIG.flakyThreshold);
  const flakyThreshold = Math.max(
    0.05,
    Math.min(1.0, Number.parseFloat(rawThreshold) || DEFAULT_CONFIG.flakyThreshold),
  );

  const ignoreTypeOnlyChanges = cliArgs.includes("--ignore-type-only") ? true : parseBool(
    Deno.env.get("INPUT_IGNORE_TYPE_ONLY") ??
      (fileCfg["ignore-type-only"] as boolean | string | undefined),
    DEFAULT_CONFIG.ignoreTypeOnlyChanges,
  );

  let symbolLevelPruning = parseBool(
    Deno.env.get("INPUT_SYMBOL_PRUNING") ??
      (fileCfg["symbol-pruning"] as boolean | string | undefined),
    DEFAULT_CONFIG.symbolLevelPruning,
  );
  if (parsed.values["no-symbol-pruning"] === true) {
    symbolLevelPruning = false;
  } else if (cliArgs.includes("--symbol-pruning")) {
    symbolLevelPruning = true;
  }

  const rawMaxBlast = (parsed.values["max-blast-radius"] as string | undefined) ||
    Deno.env.get("INPUT_MAX_BLAST_RADIUS") ||
    String(fileCfg["max-blast-radius"] ?? DEFAULT_CONFIG.maxBlastRadius);
  const maxBlastRadius = Math.max(
    0,
    Math.min(
      100,
      Number.isNaN(Number.parseInt(rawMaxBlast, 10))
        ? DEFAULT_CONFIG.maxBlastRadius
        : Number.parseInt(rawMaxBlast, 10),
    ),
  );

  const failOnBlastRadius = cliArgs.includes("--fail-on-blast-radius") ? true : parseBool(
    Deno.env.get("INPUT_FAIL_ON_BLAST_RADIUS") ??
      (fileCfg["fail-on-blast-radius"] as boolean | string | undefined),
    DEFAULT_CONFIG.failOnBlastRadius,
  );

  const ticketContext = (parsed.values["ticket-context"] as string | undefined) ||
    Deno.env.get("INPUT_TICKET_CONTEXT") ||
    (fileCfg["ticket-context"] as string | undefined);

  let emitAnnotations = parseBool(
    Deno.env.get("INPUT_EMIT_ANNOTATIONS") ??
      (fileCfg["emit-annotations"] as boolean | string | undefined),
    DEFAULT_CONFIG.emitAnnotations,
  );
  if (parsed.values["no-emit-annotations"] === true) {
    emitAnnotations = false;
  } else if (cliArgs.includes("--emit-annotations")) {
    emitAnnotations = true;
  }

  const postPrComment = cliArgs.includes("--post-pr-comment") ? true : parseBool(
    Deno.env.get("INPUT_POST_PR_COMMENT") ??
      (fileCfg["post-pr-comment"] as boolean | string | undefined),
    DEFAULT_CONFIG.postPrComment,
  );

  const rawCost = (parsed.values["runner-cost"] as string | undefined) ||
    Deno.env.get("INPUT_RUNNER_COST_PER_MIN") ||
    String(fileCfg["runner-cost-per-min"] ?? DEFAULT_CONFIG.runnerCostPerMinUsd);
  const runnerCostPerMinUsd = Math.max(
    0.001,
    Number.parseFloat(rawCost) || DEFAULT_CONFIG.runnerCostPerMinUsd,
  );

  const reportFile = (parsed.values["report-file"] as string | undefined) ||
    Deno.env.get("INPUT_REPORT_FILE") ||
    (fileCfg["report-file"] as string | undefined) ||
    DEFAULT_CONFIG.reportFile;

  const writeSummary = parseBool(
    Deno.env.get("INPUT_WRITE_SUMMARY") ?? (parsed.values["write-summary"] as boolean),
    DEFAULT_CONFIG.writeSummary,
  );

  return {
    config: {
      workspaceDir,
      baseRef,
      headRef,
      shards,
      testGlobs,
      failSafeGlobs,
      ignoreDirs,
      telemetryPath,
      updateTelemetryFromReport,
      ewmaAlpha,
      flakyQuarantine,
      flakyThreshold,
      ignoreTypeOnlyChanges,
      symbolLevelPruning,
      maxBlastRadius,
      failOnBlastRadius,
      ticketContext,
      emitAnnotations,
      postPrComment,
      runnerCostPerMinUsd,
      reportFile,
      writeSummary,
    },
    helpRequested: Boolean(parsed.values.help),
    versionRequested: Boolean(parsed.values.version),
  };
}
