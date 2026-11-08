#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=deno
/**
 * @module scripts/generate_docs
 * @description Automated API Reference (`docs/reference.md`), `llms.txt`, and `llms-full.txt`
 *              generator powered by the GLASTOR® Core Zerho Engine (`glastor-core/zerho` v1.8.0)
 *              and native `deno doc --json`.
 * @see https://github.com/glastor-core/zerho
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface DenoDocLocation {
  filename: string;
  line: number;
  col: number;
}

interface DenoDocParam {
  kind: string;
  name?: string;
  optional?: boolean;
  tsType?: unknown;
  left?: {
    kind?: string;
    name?: string;
    optional?: boolean;
    tsType?: unknown;
  };
  right?: string;
  arg?: {
    name?: string;
    tsType?: unknown;
  };
}

interface DenoDocMethod {
  name: string;
  isStatic?: boolean;
  functionDef?: {
    params?: DenoDocParam[];
    returnType?: { repr?: string };
  };
  jsDoc?: {
    doc?: string;
    tags?: Array<{ kind: string; name?: string; doc?: string }>;
  };
}

interface DenoDocProperty {
  name: string;
  accessibility?: string;
  optional?: boolean;
  tsType?: unknown;
  jsDoc?: { doc?: string };
}

interface DenoDocDeclaration {
  kind: "function" | "class" | "interface" | "typeAlias" | "variable" | "enum";
  declarationKind: string;
  location: DenoDocLocation;
  jsDoc?: {
    doc?: string;
    tags?: Array<{ kind: string; name?: string; doc?: string }>;
  };
  def?: {
    properties?: DenoDocProperty[];
    methods?: DenoDocMethod[];
    params?: DenoDocParam[];
    returnType?: { repr?: string };
    typeParams?: Array<{ name: string }>;
    tsType?: unknown;
  };
}

interface DenoDocSymbol {
  name: string;
  modulePath: string;
  declarations: DenoDocDeclaration[];
}

interface ExtractedParam {
  name: string;
  type: string;
  optional: boolean;
  defaultVal?: string;
}

const ENTRYPOINTS = [
  "src/main.ts",
  "src/types.ts",
  "src/config.ts",
  "src/security.ts",
  "src/git/diff-parser.ts",
  "src/ast/analyzer.ts",
  "src/graph/dag.ts",
  "src/scheduler/lpt-splitter.ts",
  "src/governance/gatekeeper.ts",
  "src/reporters/finops-reporter.ts",
];

/**
 * Formats Deno Doc AST type nodes into readable TypeScript representations (Zerho Docgen Engine).
 */
export function formatTsType(t: unknown): string {
  if (!t || typeof t !== "object") return "unknown";
  const typeObj = t as Record<string, unknown>;

  if (typeObj.kind === "array" && typeObj.value) {
    return `${formatTsType(typeObj.value)}[]`;
  }

  if (typeObj.kind === "union" && Array.isArray(typeObj.value)) {
    return typeObj.value.map(formatTsType).join(" | ");
  }

  if (typeObj.kind === "typeRef") {
    const val = typeObj.value as { typeName?: string; typeParams?: unknown[] } | undefined;
    const typeName = (typeObj.repr as string) || val?.typeName || "unknown";
    if (val?.typeParams && val.typeParams.length > 0) {
      return `${typeName}<${val.typeParams.map(formatTsType).join(", ")}>`;
    }
    return typeName;
  }

  if (typeObj.kind === "literal") {
    if (typeObj.repr) return typeObj.repr as string;
    const val = typeObj.value as { kind?: string; string?: string } | undefined;
    if (val?.kind === "string" && typeof val.string === "string") {
      return JSON.stringify(val.string);
    }
    return String(typeObj.value);
  }

  if (typeof typeObj.repr === "string" && typeObj.repr) {
    return typeObj.repr;
  }

  return "unknown";
}

/**
 * Extracts normalized parameter metadata handling assignments, defaults, and rest parameters.
 */
export function extractParamInfo(p: DenoDocParam | undefined): ExtractedParam {
  if (!p) return { name: "arg", type: "unknown", optional: false };

  if (p.kind === "assign" && p.left) {
    const rawType = formatTsType(p.left.tsType);
    let defaultRaw = p.right === "[UNSUPPORTED]" ? "{}" : (p.right || "");
    if (
      rawType === "string" &&
      !defaultRaw.startsWith('"') &&
      !defaultRaw.startsWith("'") &&
      defaultRaw !== "{}"
    ) {
      defaultRaw = JSON.stringify(defaultRaw);
    }
    return {
      name: p.left.name || "arg",
      type: rawType,
      optional: true,
      defaultVal: defaultRaw,
    };
  }

  if (p.kind === "rest") {
    return {
      name: `...${p.arg?.name || "args"}`,
      type: formatTsType(p.arg?.tsType),
      optional: true,
    };
  }

  return {
    name: p.name || "arg",
    type: formatTsType(p.tsType),
    optional: Boolean(p.optional),
  };
}

/**
 * Runs `deno doc --json` across all entrypoints and extracts public symbols.
 */
async function extractDenoDocSymbols(entrypoints: string[]): Promise<DenoDocSymbol[]> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", ...entrypoints],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const errText = new TextDecoder().decode(output.stderr);
    throw new Error(`[Zerho Docgen] deno doc --json failed: ${errText}`);
  }

  const data = JSON.parse(new TextDecoder().decode(output.stdout));
  if (!data.nodes || typeof data.nodes !== "object") return [];

  const seen = new Set<string>();
  const symbols: DenoDocSymbol[] = [];

  for (const fileKey of Object.keys(data.nodes)) {
    const moduleNode = data.nodes[fileKey];
    const relModule = fileKey.includes("/src/") ? `src/${fileKey.split("/src/")[1]}` : fileKey;
    if (moduleNode && Array.isArray(moduleNode.symbols)) {
      for (
        const sym of moduleNode.symbols as Array<
          { name: string; declarations: DenoDocDeclaration[] }
        >
      ) {
        if (!sym.name || sym.name === "default") continue;
        const dedupKey = `${relModule}::${sym.name}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        symbols.push({
          name: sym.name,
          modulePath: relModule,
          declarations: sym.declarations || [],
        });
      }
    }
  }

  return symbols;
}

/**
 * Renders the Zerho Markdown API Reference document (`docs/reference.md`).
 */
function renderZerhoReferenceMarkdown(symbols: DenoDocSymbol[]): string {
  const lines: string[] = [
    "---",
    "title: Vortex v1.1.0 — API Reference (Zerho Docgen)",
    "description: Automated TypeScript & AST Engine API Reference generated via glastor-core/zerho and deno doc",
    "layout: doc",
    "---",
    "",
    "# 🌪️ Vortex `v1.1.0` — Technical API Reference",
    "",
    "> Automatically compiled from source code AST & JSDoc signatures using **[GLASTOR® Core — Zerho](https://github.com/glastor-core/zerho)** (`deno doc --json`).",
    "",
    "---",
    "",
    "## Symbol Index",
    "",
  ];

  for (const sym of symbols) {
    const decl = sym.declarations[0];
    const kind = decl?.kind || "symbol";
    const slug = sym.name.toLowerCase();
    lines.push(`- [**\`${sym.name}\`**](#${slug}) (\`${kind}\` in \`${sym.modulePath}\`)`);
  }

  lines.push("", "---", "");

  for (const sym of symbols) {
    const decl = sym.declarations[0];
    if (!decl) continue;

    const kind = decl.kind;
    const docText = (decl.jsDoc?.doc || "Exported symbol in Vortex core engine.").trim();

    const paramDocs = new Map<string, string>();
    let returnDoc = "";
    if (decl.jsDoc?.tags) {
      for (const tag of decl.jsDoc.tags) {
        if (tag.kind === "param" && tag.name) {
          paramDocs.set(tag.name, (tag.doc || "").trim());
        } else if (tag.kind === "return") {
          returnDoc = (tag.doc || "").trim();
        }
      }
    }

    lines.push(`## ${sym.name}`, "");
    lines.push(
      `**Kind:** \`${kind}\` | **Module:** \`${sym.modulePath}:${decl.location.line}\``,
      "",
      docText,
      "",
    );

    if (kind === "interface" && decl.def?.properties && decl.def.properties.length > 0) {
      lines.push(
        "### Properties",
        "",
        "| Property | Type | Optional | Description |",
        "| :--- | :--- | :---: | :--- |",
      );
      for (const prop of decl.def.properties) {
        const typeRepr = formatTsType(prop.tsType).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
        const isOpt = prop.optional ? "Yes" : "No";
        const desc = (prop.jsDoc?.doc || "—").replace(/\r?\n/g, " ").trim();
        lines.push(`| \`${prop.name}\` | \`${typeRepr}\` | ${isOpt} | ${desc} |`);
      }
      lines.push("");
    } else if (kind === "class") {
      if (decl.def?.methods && decl.def.methods.length > 0) {
        lines.push("### Methods", "");
        for (const method of decl.def.methods) {
          const methodParams = (method.functionDef?.params || []).map(extractParamInfo);
          const sigParams = methodParams
            .map((p) =>
              p.defaultVal
                ? `${p.name} = ${p.defaultVal}`
                : p.optional
                ? `${p.name}?: ${p.type}`
                : `${p.name}: ${p.type}`
            )
            .join(", ");
          const retType = formatTsType(method.functionDef?.returnType);
          const methodDesc = (method.jsDoc?.doc || "").trim();
          const staticPrefix = method.isStatic ? "static " : "";

          lines.push(`#### \`${staticPrefix}${method.name}(${sigParams}): ${retType}\``, "");
          if (methodDesc) lines.push(methodDesc, "");
        }
      }
    } else if (kind === "function") {
      const params = (decl.def?.params || []).map(extractParamInfo);
      const sigParams = params
        .map((p) =>
          p.defaultVal
            ? `${p.name} = ${p.defaultVal}`
            : p.optional
            ? `${p.name}?: ${p.type}`
            : `${p.name}: ${p.type}`
        )
        .join(", ");
      const retType = formatTsType(decl.def?.returnType);

      lines.push(
        "```typescript",
        `function ${sym.name}(${sigParams}): ${retType};`,
        "```",
        "",
      );

      if (returnDoc) {
        lines.push(`**Returns:** \`${retType}\` — ${returnDoc}`, "");
      }

      if (params.length > 0) {
        lines.push(
          "### Parameters",
          "",
          "| Parameter | Type | Optional | Default | Description |",
          "| :--- | :--- | :---: | :---: | :--- |",
        );
        for (const p of params) {
          const typeRepr = p.type.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
          const optStr = p.optional ? "Yes" : "No";
          const defStr = p.defaultVal ? `\`${p.defaultVal}\`` : "—";
          const doc = (paramDocs.get(p.name) || "—").replace(/\r?\n/g, " ");
          lines.push(`| \`${p.name}\` | \`${typeRepr}\` | ${optStr} | ${defStr} | ${doc} |`);
        }
        lines.push("");
      }
    }

    lines.push("---", "");
  }

  return lines.join("\n");
}

/**
 * Generates `/llms.txt` following the Zerho & llmstxt.org specification.
 */
function renderZerhoLlmsTxt(symbolsCount: number): string {
  return `# GLASTOR® Core — Vortex (v1.1.0)

> AST-Driven Predictive CI Orchestrator, Symbol-Level Barrel Pruner, Reverse Dependency DAG Analyzer, LPT Dynamic Test Splitter, EWMA Telemetry Auto-Learner, and FinOps Gatekeeper for GitHub Actions.

Vortex (\`@glastor-core/vortex\`) is a zero-dependency Deno 2 & TypeScript engine that maps Git diff hunks to mutated AST declarations (\`[startLine, endLine]\`), prunes unused barrel re-exports (\`index.ts\` / \`mod.ts\`), computes the minimal transitive set of impacted test suites via a Reverse Dependency DAG, balances parallel GitHub Actions runners using Longest Processing Time First (LPT), and enforces FinOps & Blast-Radius governance.

## Core Documentation & Architecture

- [README & Architecture Overview](https://github.com/glastor-core/vortex/blob/main/README.md): Complete 5-stage pipeline guide, GitHub Action inputs/outputs, CLI flags, and YAML schema.
- [API Reference (Zerho Docgen)](https://github.com/glastor-core/vortex/blob/main/docs/reference.md): Auto-generated TypeScript API reference covering ${symbolsCount} exported symbols across 10 core modules.
- [GitHub Action Manifest](https://github.com/glastor-core/vortex/blob/main/action.yml): Official GitHub Marketplace Action definition (22 inputs, 15 outputs).
- [Security & AppSec Policy](https://github.com/glastor-core/vortex/blob/main/.github/SECURITY.md): Zero-Trust mitigations for CWE-88, CWE-22, CWE-78, CWE-93, CWE-918, and CWE-1333.
- [Changelog](https://github.com/glastor-core/vortex/blob/main/CHANGELOG.md): Release history for v1.0.0 and v1.1.0.

## Key Engine Modules

- \`src/main.ts\`: 5-stage CLI & GitHub Action orchestrator (\`runVortexEngine\`, \`main\`).
- \`src/security.ts\`: AppSec validation & sanitization guards (\`isValidGitRef\`, \`isSafeRelativeFilePath\`, \`resolveSafeWorkspacePath\`, \`escapeWorkflowCommandData\`, \`isSafeGitHubApiUrl\`, \`isSafeLineForRegex\`).
- \`src/git/diff-parser.ts\`: Git unified=0 hunk parser & semantic noise filter (\`parseUnifiedZeroDiff\`, \`evaluateHunkSemanticNoise\`).
- \`src/ast/analyzer.ts\`: Polyglot AST symbol extractor, intra-module caller expander, and monorepo alias resolver (\`extractAstSymbols\`, \`extractImportBindings\`, \`expandIntraModuleMutatedSymbols\`, \`loadWorkspacePathAliases\`).
- \`src/graph/dag.ts\`: Reverse Dependency DAG & Symbol-Level Barrel Pruner (\`DependencyDag\`, \`findImpactedTestsWithPruning\`).
- \`src/scheduler/lpt-splitter.ts\`: Greedy LPT test splitter, Fail-Fast intra-shard priority scorer, and EWMA telemetry learner (\`scheduleShardsLpt\`, \`updateTelemetryStoreEwma\`, \`calculateFinOpsMetrics\`).
- \`src/governance/gatekeeper.ts\`: Issue ticket extractor, Blast-Radius gatekeeper, and Nemesis target emitter (\`evaluateGovernanceGate\`, \`extractTicketIds\`).
- \`src/reporters/finops-reporter.ts\`: GitHub Step Summary Mermaid builder, workflow annotations, and sticky PR comment publisher (\`publishGitHubActionOutputs\`, \`buildStepSummaryMarkdown\`, \`postOrUpdateStickyPrComment\`).

## Full Context for LLMs & Agents

- [Consolidated LLM Context (/llms-full.txt)](https://github.com/glastor-core/vortex/blob/main/llms-full.txt): Complete merged architecture guide and API reference generated by \`glastor-core/zerho\`.
`;
}

/**
 * Generates `/llms-full.txt` merging `README.md` and `docs/reference.md` for direct LLM ingestion.
 */
function renderZerhoLlmsFullTxt(readmeContent: string, referenceContent: string): string {
  const cleanRef = referenceContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  return `# GLASTOR® Core — Vortex (v1.1.0) — Complete LLM Technical Specification

> Generated automatically by GLASTOR® Core Zerho (\`glastor-core/zerho\`) for AI coding assistants, autonomous agents, and RAG pipelines.

---

${readmeContent.trim()}

---

${cleanRef}
`;
}

async function main(): Promise<void> {
  const isCheck = Deno.args.includes("--check");
  console.log("⚡ [Zerho Docgen] Extracting AST & JSDoc symbols via `deno doc --json`...");

  const symbols = await extractDenoDocSymbols(ENTRYPOINTS);
  const referenceMd = renderZerhoReferenceMarkdown(symbols);
  const llmsTxt = renderZerhoLlmsTxt(symbols.length);
  const readmeContent = fs.readFileSync(path.resolve("README.md"), "utf-8");
  const llmsFullTxt = renderZerhoLlmsFullTxt(readmeContent, referenceMd);

  const targets: Array<{ relPath: string; content: string }> = [
    { relPath: "docs/reference.md", content: referenceMd },
    { relPath: "llms.txt", content: llmsTxt },
    { relPath: "llms-full.txt", content: llmsFullTxt },
  ];

  if (isCheck) {
    let outOfSync = false;
    for (const target of targets) {
      const abs = path.resolve(target.relPath);
      if (!fs.existsSync(abs)) {
        console.error(`❌ [Zerho Docgen] Missing generated file: ${target.relPath}`);
        outOfSync = true;
        continue;
      }
      const current = fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n");
      const expected = target.content.replace(/\r\n/g, "\n");
      if (current !== expected) {
        console.error(
          `❌ [Zerho Docgen] ${target.relPath} is out of sync. Run 'deno task docs' to update.`,
        );
        outOfSync = true;
      }
    }
    if (outOfSync) {
      Deno.exit(1);
    }
    console.log(
      `✅ [Zerho Docgen] All documentation artifacts (${symbols.length} symbols, llms.txt, llms-full.txt) are in sync.`,
    );
    return;
  }

  fs.mkdirSync(path.resolve("docs"), { recursive: true });
  for (const target of targets) {
    fs.writeFileSync(path.resolve(target.relPath), target.content, "utf-8");
    console.log(`   ├─ Generated ${target.relPath}`);
  }
  console.log(
    `✅ [Zerho Docgen] Documented ${symbols.length} symbols across ${ENTRYPOINTS.length} modules.`,
  );
}

if (import.meta.main) {
  await main();
}
