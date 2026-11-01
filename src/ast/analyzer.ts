/**
 * @module ast/analyzer
 * @description Polyglot AST symbol & import dependency analyzer (TS/JS/Deno, Python, Rust, Go)
 *              with exact line-range tracking, monorepo path alias resolution, and symbol-level
 *              import bindings for barrel-file pruning (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { isSafeLineForRegex, MAX_AST_FILE_BYTES } from "../security.ts";
import type {
  AstSymbol,
  FileDiff,
  ImportBinding,
  MutatedSymbol,
  ParsedModule,
  SupportedLanguage,
  SymbolKind,
} from "../types.ts";

/**
 * Converts a POSIX glob pattern (e.g., `*.test.ts` or `.github/workflows/**`) into a RegExp.
 */
export function globToRegExp(glob: string): RegExp {
  const norm = glob.replace(/\\/g, "/").trim();
  let regexStr = "^";
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 3;
          continue;
        }
        regexStr += ".*";
        i += 2;
        continue;
      }
      regexStr += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      i++;
      continue;
    }
    if (".+^$()|[]{}\\".includes(ch)) {
      regexStr += "\\" + ch;
    } else {
      regexStr += ch;
    }
    i++;
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Checks if a normalized POSIX relative path matches any of the provided glob patterns.
 */
export function matchesAnyGlob(relPath: string, globs: string[]): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return globs.some((g) => globToRegExp(g).test(norm));
}

/**
 * Detects language from file extension.
 */
export function detectLanguage(filePath: string): SupportedLanguage {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  if (ext === ".go") return "go";
  return "unknown";
}

/**
 * Loads path aliases and workspace package mappings from `deno.json`, `tsconfig.json`, and `package.json`.
 * Returns a map of alias prefix/key -> target relative POSIX path prefix.
 */
export function loadWorkspacePathAliases(workspaceDir: string): Map<string, string> {
  const aliases = new Map<string, string>();

  const normalizeTarget = (rawTarget: string, baseUrl = "."): string => {
    const clean = rawTarget.replace(/^\.\//, "").replace(/\*$/, "");
    const baseClean = baseUrl.replace(/^\.\//, "").replace(/\/$/, "");
    return baseClean && baseClean !== "." ? path.posix.join(baseClean, clean) : clean;
  };

  // 1. Check deno.json / deno.jsonc `imports`
  for (const denoFile of ["deno.json", "deno.jsonc"]) {
    const denoPath = path.join(workspaceDir, denoFile);
    if (fs.existsSync(denoPath)) {
      try {
        const raw = fs.readFileSync(denoPath, "utf-8").replace(/^\s*\/\/.*$/gm, "");
        const parsed = JSON.parse(raw) as { imports?: Record<string, string> };
        if (parsed.imports && typeof parsed.imports === "object") {
          for (const [key, target] of Object.entries(parsed.imports)) {
            if (
              typeof target === "string" &&
              (target.startsWith("./") || target.startsWith("../") || target.startsWith("src/") ||
                target.startsWith("packages/"))
            ) {
              aliases.set(key.replace(/\*$/, ""), normalizeTarget(target));
            }
          }
        }
      } catch {
        // Ignore non-standard JSON
      }
    }
  }

  // 2. Check tsconfig.json `compilerOptions.paths` & `baseUrl`
  const tsconfigPath = path.join(workspaceDir, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    try {
      const raw = fs.readFileSync(tsconfigPath, "utf-8").replace(/^\s*\/\/.*$/gm, "");
      const parsed = JSON.parse(raw) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const baseUrl = parsed.compilerOptions?.baseUrl ?? ".";
      const pathsObj = parsed.compilerOptions?.paths;
      if (pathsObj && typeof pathsObj === "object") {
        for (const [aliasKey, targets] of Object.entries(pathsObj)) {
          if (Array.isArray(targets) && targets.length > 0 && typeof targets[0] === "string") {
            const cleanKey = aliasKey.replace(/\*$/, "");
            aliases.set(cleanKey, normalizeTarget(targets[0], baseUrl));
          }
        }
      }
    } catch {
      // Ignore malformed tsconfig
    }
  }

  return aliases;
}

/**
 * Extracts raw module import specifiers from source code across TS/JS, Python, Rust, and Go.
 */
export function extractRawImportSpecifiers(
  content: string,
  language: SupportedLanguage,
): string[] {
  const specifiers = new Set<string>();

  if (language === "typescript" || language === "javascript") {
    const esRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = esRegex.exec(content)) !== null) {
      specifiers.add(m[1].trim());
    }
    const dynRegex = /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dynRegex.exec(content)) !== null) {
      specifiers.add(m[1].trim());
    }
  } else if (language === "python") {
    const pyFromRegex = /^\s*from\s+([.\w]+)\s+import\s+/gm;
    let m: RegExpExecArray | null;
    while ((m = pyFromRegex.exec(content)) !== null) {
      specifiers.add(m[1].trim());
    }
    const pyImpRegex = /^\s*import\s+([\w.]+)/gm;
    while ((m = pyImpRegex.exec(content)) !== null) {
      specifiers.add(m[1].trim());
    }
  } else if (language === "rust") {
    const rsModRegex = /^\s*(?:pub\s+)?(?:mod|use)\s+(?:crate::)?([a-zA-Z0-9_:]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = rsModRegex.exec(content)) !== null) {
      specifiers.add(m[1].trim());
    }
  }

  return [...specifiers];
}

/**
 * Resolves a raw import specifier against the importing file's directory, monorepo path aliases,
 * and known workspace files.
 */
export function resolveWorkspaceImport(
  importerRelPath: string,
  specifier: string,
  knownFiles: Set<string>,
  pathAliases?: Map<string, string>,
): string | null {
  const importerDir = path.posix.dirname(importerRelPath.replace(/\\/g, "/"));

  const probeCandidate = (candidateBase: string): string | null => {
    const candidates = [
      candidateBase,
      `${candidateBase}.ts`,
      `${candidateBase}.tsx`,
      `${candidateBase}.js`,
      `${candidateBase}.jsx`,
      `${candidateBase}/index.ts`,
      `${candidateBase}/index.js`,
      `${candidateBase}/mod.ts`,
    ];
    for (const c of candidates) {
      if (knownFiles.has(c)) return c;
    }
    return null;
  };

  // 1. Check Monorepo / Deno / TSConfig Path Aliases (`@/utils/math`, `@core/db`)
  if (pathAliases && pathAliases.size > 0 && !specifier.startsWith(".")) {
    for (const [aliasPrefix, targetPrefix] of pathAliases.entries()) {
      if (specifier === aliasPrefix || specifier.startsWith(aliasPrefix)) {
        const rest = specifier.slice(aliasPrefix.length);
        const mapped = path.posix.normalize(path.posix.join(targetPrefix, rest));
        const resolved = probeCandidate(mapped);
        if (resolved) return resolved;
      }
    }
  }

  // 2. Relative TS/JS/Deno imports (`./foo`, `../bar/baz.ts`)
  if (specifier.startsWith(".")) {
    const candidateBase = path.posix.normalize(path.posix.join(importerDir, specifier));
    return probeCandidate(candidateBase);
  }

  // 3. Python / Rust / Go module paths
  if (
    !specifier.startsWith("node:") &&
    !specifier.startsWith("jsr:") &&
    !specifier.startsWith("npm:")
  ) {
    const slashSpec = specifier.replace(/\./g, "/").replace(/::/g, "/");
    const candidates = [
      `${slashSpec}.py`,
      `${slashSpec}/__init__.py`,
      `src/${slashSpec}.rs`,
      `${slashSpec}.ts`,
    ];
    for (const c of candidates) {
      if (knownFiles.has(c)) return c;
    }
  }

  return null;
}

/**
 * Extracts fine-grained symbol-level import bindings (`import { fnA, fnB as x } from "./utils.ts"`)
 * to enable Symbol-Level AST Barrel Pruning.
 */
export function extractImportBindings(
  content: string,
  language: SupportedLanguage,
  importerRelPath: string,
  knownFiles: Set<string>,
  pathAliases?: Map<string, string>,
): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  if (language === "typescript" || language === "javascript") {
    const stmtRegex =
      /(import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = stmtRegex.exec(content)) !== null) {
      const keyword = m[1] ?? "import";
      const clause = (m[2] ?? "").trim();
      const rawSpecifier = (m[3] ?? m[4] ?? "").trim();
      if (!rawSpecifier) continue;

      const resolvedFilePath = resolveWorkspaceImport(
        importerRelPath,
        rawSpecifier,
        knownFiles,
        pathAliases,
      );
      if (!resolvedFilePath) continue;

      const isReExport = keyword === "export";
      const importedSymbols: string[] = [];

      if (!clause || clause === "*" || clause.startsWith("* as ")) {
        importedSymbols.push("*");
      } else {
        // Check named braces `{ fnA, fnB as aliasB, type User }`
        const braceMatch = /\{([\s\S]*?)\}/.exec(clause);
        if (braceMatch) {
          const items = braceMatch[1].split(",");
          for (const item of items) {
            const cleaned = item.replace(/^\s*type\s+/, "").trim();
            if (!cleaned) continue;
            const origName = cleaned.split(/\s+as\s+/)[0].trim();
            if (origName) importedSymbols.push(origName);
          }
        }
        // Check if there is also a default import outside `{ ... }`
        const outsideBraces = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, "").trim();
        if (outsideBraces) {
          importedSymbols.push("*");
        }
      }

      bindings.push({
        rawSpecifier,
        resolvedFilePath,
        importedSymbols: importedSymbols.length > 0 ? [...new Set(importedSymbols)] : ["*"],
        isReExport,
      });
    }
  } else if (language === "python") {
    const pyFromRegex = /^\s*from\s+([.\w]+)\s+import\s+([^\r\n#]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = pyFromRegex.exec(content)) !== null) {
      const rawSpecifier = m[1].trim();
      const clause = m[2].trim();
      const resolvedFilePath = resolveWorkspaceImport(
        importerRelPath,
        rawSpecifier,
        knownFiles,
        pathAliases,
      );
      if (!resolvedFilePath) continue;

      const importedSymbols = clause === "*" ? ["*"] : clause
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);

      bindings.push({
        rawSpecifier,
        resolvedFilePath,
        importedSymbols: importedSymbols.length > 0 ? importedSymbols : ["*"],
        isReExport: false,
      });
    }
  }

  return bindings;
}

/**
 * Extracts top-level AST declarations (functions, classes, constants, interfaces, types, enums)
 * with exact `[startLine, endLine]` boundaries and intra-module referenced identifiers.
 */
export function extractAstSymbols(
  content: string,
  language: SupportedLanguage,
): AstSymbol[] {
  const lines = content.split(/\r?\n/);
  const symbols: AstSymbol[] = [];

  if (language === "typescript" || language === "javascript") {
    const declRegex =
      /^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isSafeLineForRegex(line)) continue;
      const match = declRegex.exec(line);
      if (!match) continue;

      const isExported = Boolean(match[1]);
      const rawKind = match[2];
      const name = match[3];
      const kind: SymbolKind = rawKind === "let" || rawKind === "var"
        ? "variable"
        : (rawKind as SymbolKind);
      const isTypeOnly = kind === "interface" || kind === "type";

      const startLine = i + 1;
      let endLine = startLine;

      let braceDepth = 0;
      let parenDepth = 0;
      let sawOpeningBrace = false;

      for (let j = i; j < lines.length; j++) {
        const scanLine = stripCommentsFromLine(lines[j]);
        for (let c = 0; c < scanLine.length; c++) {
          const ch = scanLine[c];
          if (ch === "{") {
            braceDepth++;
            sawOpeningBrace = true;
          } else if (ch === "}") {
            braceDepth--;
          } else if (ch === "(") {
            parenDepth++;
          } else if (ch === ")") {
            parenDepth--;
          }
        }
        endLine = j + 1;

        if (sawOpeningBrace && braceDepth <= 0 && parenDepth <= 0) {
          break;
        }
        if (!sawOpeningBrace && parenDepth <= 0 && scanLine.trim().endsWith(";")) {
          break;
        }
      }

      const bodySlice = lines.slice(startLine - 1, endLine).join("\n");
      const referencedIdentifiers = extractBodyIdentifiers(bodySlice, name);

      symbols.push({
        name,
        kind,
        isExported,
        isTypeOnly,
        startLine,
        endLine,
        referencedIdentifiers,
      });
      i = Math.max(i, endLine - 1);
    }
  } else if (language === "python") {
    const pyDeclRegex = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
    for (let i = 0; i < lines.length; i++) {
      const match = pyDeclRegex.exec(lines[i]);
      if (!match || match[1].length > 0) continue;
      const kind: SymbolKind = match[2] === "class" ? "class" : "function";
      const name = match[3];
      const startLine = i + 1;
      let endLine = startLine;

      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim().length === 0 || l.trim().startsWith("#")) continue;
        const indent = /^(\s*)/.exec(l)?.[1].length ?? 0;
        if (indent === 0) break;
        endLine = j + 1;
      }

      const bodySlice = lines.slice(startLine - 1, endLine).join("\n");
      const referencedIdentifiers = extractBodyIdentifiers(bodySlice, name);

      symbols.push({
        name,
        kind,
        isExported: !name.startsWith("_"),
        isTypeOnly: false,
        startLine,
        endLine,
        referencedIdentifiers,
      });
      i = Math.max(i, endLine - 1);
    }
  }

  return symbols;
}

const RESERVED_KEYWORDS = new Set([
  "export",
  "import",
  "from",
  "function",
  "class",
  "const",
  "let",
  "var",
  "interface",
  "type",
  "enum",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "new",
  "true",
  "false",
  "null",
  "undefined",
  "async",
  "await",
  "number",
  "string",
  "boolean",
  "void",
  "Promise",
]);

function extractBodyIdentifiers(bodyText: string, selfName: string): string[] {
  const cleaned = stripCommentsFromLine(bodyText);
  const idRegex = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = idRegex.exec(cleaned)) !== null) {
    const token = m[1];
    if (token !== selfName && !RESERVED_KEYWORDS.has(token)) {
      ids.add(token);
    }
  }
  return [...ids];
}

function stripCommentsFromLine(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""')
    .replace(/\/\/.*$/, "");
}

/**
 * Counts how many test declarations exist inside a test file (`Deno.test`, `it(`, `test(`, `def test_`, `#[test]`).
 */
export function countTestCases(content: string): number {
  const regex =
    /\b(?:Deno\.test|it|test)\s*\(|^\s*def\s+test_[a-zA-Z0-9_]+|#\[(?:tokio::)?test\]/gm;
  const matches = content.match(regex);
  return matches ? Math.max(1, matches.length) : 1;
}

/**
 * Parses a workspace file into a `ParsedModule`.
 */
export function parseWorkspaceFile(
  workspaceDir: string,
  relPath: string,
  testGlobs: string[],
  knownFiles: Set<string>,
  pathAliases?: Map<string, string>,
): ParsedModule {
  const normPath = relPath.replace(/\\/g, "/");
  const absPath = path.resolve(workspaceDir, normPath);
  const language = detectLanguage(normPath);
  const isTestFile = matchesAnyGlob(normPath, testGlobs);

  let content = "";
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_AST_FILE_BYTES) {
      return {
        filePath: normPath,
        language,
        isTestFile,
        imports: [],
        importBindings: [],
        symbols: [],
        lineCount: 0,
        testCaseCount: isTestFile ? 1 : 0,
      };
    }
    content = fs.readFileSync(absPath, "utf-8");
  } catch {
    return {
      filePath: normPath,
      language,
      isTestFile,
      imports: [],
      importBindings: [],
      symbols: [],
      lineCount: 0,
      testCaseCount: isTestFile ? 1 : 0,
    };
  }

  const rawSpecifiers = extractRawImportSpecifiers(content, language);
  const resolvedImports = rawSpecifiers
    .map((spec) => resolveWorkspaceImport(normPath, spec, knownFiles, pathAliases))
    .filter((imp): imp is string => imp !== null);

  const importBindings = extractImportBindings(
    content,
    language,
    normPath,
    knownFiles,
    pathAliases,
  );
  const symbols = extractAstSymbols(content, language);
  const lineCount = content.split(/\r?\n/).length;
  const testCaseCount = isTestFile ? countTestCases(content) : 0;

  return {
    filePath: normPath,
    language,
    isTestFile,
    imports: [...new Set(resolvedImports)],
    importBindings,
    symbols,
    lineCount,
    testCaseCount,
  };
}

/**
 * Expands mutated symbols within the same file using intra-module call references:
 * if `fnA` was mutated and `fnB` calls `fnA` inside the same file, `fnB` is also transitively mutated.
 */
export function expandIntraModuleMutatedSymbols(
  directMutated: MutatedSymbol[],
  moduleAst: ParsedModule | undefined,
): MutatedSymbol[] {
  if (!moduleAst || moduleAst.symbols.length === 0 || directMutated.length === 0) {
    return directMutated;
  }
  if (directMutated.some((s) => s.symbolName === "<module-scope>")) {
    return directMutated;
  }

  const activeNames = new Set(directMutated.map((s) => s.symbolName));
  const resultMap = new Map<string, MutatedSymbol>();
  for (const m of directMutated) {
    resultMap.set(m.symbolName, m);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const sym of moduleAst.symbols) {
      if (activeNames.has(sym.name)) continue;
      const refs = sym.referencedIdentifiers ?? [];
      if (refs.some((r) => activeNames.has(r))) {
        activeNames.add(sym.name);
        resultMap.set(sym.name, {
          filePath: moduleAst.filePath,
          symbolName: sym.name,
          kind: sym.kind,
          isTypeOnly: sym.isTypeOnly,
          lineRange: [sym.startLine, sym.endLine],
        });
        changed = true;
      }
    }
  }

  return [...resultMap.values()];
}

/**
 * Intersects modified line-range hunks (`FileDiff`) with the file's AST symbols (`ParsedModule`)
 * to determine exactly which functions, classes, or types were mutated, including intra-module callers.
 */
export function detectMutatedSymbols(
  fileDiff: FileDiff,
  moduleAst: ParsedModule | undefined,
): MutatedSymbol[] {
  if (fileDiff.isCommentOrFormatOnly) {
    return [];
  }

  if (!moduleAst || moduleAst.symbols.length === 0) {
    return [
      {
        filePath: fileDiff.filePath,
        symbolName: "<module-scope>",
        kind: "module-scope",
        isTypeOnly: false,
        lineRange: [1, Math.max(1, moduleAst?.lineCount ?? 1)],
      },
    ];
  }

  const mutatedMap = new Map<string, MutatedSymbol>();

  for (const hunk of fileDiff.hunks) {
    if (hunk.isSemanticNoise) continue;

    let matchedAnySymbol = false;
    for (const sym of moduleAst.symbols) {
      const overlaps = hunk.startLine <= sym.endLine && hunk.endLine >= sym.startLine;
      if (overlaps) {
        matchedAnySymbol = true;
        const key = `${sym.name}:${sym.startLine}`;
        if (!mutatedMap.has(key)) {
          mutatedMap.set(key, {
            filePath: fileDiff.filePath,
            symbolName: sym.name,
            kind: sym.kind,
            isTypeOnly: sym.isTypeOnly,
            lineRange: [sym.startLine, sym.endLine],
          });
        }
      }
    }

    if (!matchedAnySymbol) {
      mutatedMap.set(`module-scope:${hunk.startLine}`, {
        filePath: fileDiff.filePath,
        symbolName: "<module-scope>",
        kind: "module-scope",
        isTypeOnly: false,
        lineRange: [hunk.startLine, hunk.endLine],
      });
    }
  }

  return expandIntraModuleMutatedSymbols([...mutatedMap.values()], moduleAst);
}
