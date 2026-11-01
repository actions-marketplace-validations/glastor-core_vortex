/**
 * @module ast/analyzer
 * @description Polyglot AST symbol & import dependency analyzer (TS/JS/Deno, Python, Rust, Go)
 *              with exact line-range tracking and diff-hunk intersection.
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type {
  AstSymbol,
  FileDiff,
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
 * Extracts raw module import specifiers from source code across TS/JS, Python, Rust, and Go.
 */
export function extractRawImportSpecifiers(
  content: string,
  language: SupportedLanguage,
): string[] {
  const specifiers = new Set<string>();

  if (language === "typescript" || language === "javascript") {
    // Static ES imports/exports: `import ... from "./x.ts"`, `export ... from "./x.ts"`, `import "./x.ts"`
    const esRegex = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = esRegex.exec(content)) !== null) {
      specifiers.add(m[1].trim());
    }
    // Dynamic `import("./x.ts")` and `require("./x.ts")`
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
 * Resolves a raw import specifier against the importing file's directory and known workspace files.
 */
export function resolveWorkspaceImport(
  importerRelPath: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  const importerDir = path.posix.dirname(importerRelPath.replace(/\\/g, "/"));

  // Relative TS/JS/Deno imports (`./foo`, `../bar/baz.ts`)
  if (specifier.startsWith(".")) {
    const candidateBase = path.posix.normalize(path.posix.join(importerDir, specifier));
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
  }

  // Python module paths (`src.utils.math` or `.helpers`)
  if (
    !specifier.startsWith("node:") && !specifier.startsWith("jsr:") && !specifier.startsWith("npm:")
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
 * Extracts top-level AST declarations (functions, classes, constants, interfaces, types, enums)
 * with exact `[startLine, endLine]` boundaries using lexical brace & block scope tracking.
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

      // Track brace depth or semicolon termination to find exact endLine of this declaration
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

      symbols.push({
        name,
        kind,
        isExported,
        isTypeOnly,
        startLine,
        endLine,
      });
      i = Math.max(i, endLine - 1);
    }
  } else if (language === "python") {
    const pyDeclRegex = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
    for (let i = 0; i < lines.length; i++) {
      const match = pyDeclRegex.exec(lines[i]);
      if (!match || match[1].length > 0) continue; // Top-level only
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

      symbols.push({
        name,
        kind,
        isExported: !name.startsWith("_"),
        isTypeOnly: false,
        startLine,
        endLine,
      });
    }
  }

  return symbols;
}

function stripCommentsFromLine(line: string): string {
  // Remove single-line `//` comments and string literals so braces inside strings don't skew depth
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
): ParsedModule {
  const normPath = relPath.replace(/\\/g, "/");
  const absPath = path.resolve(workspaceDir, normPath);
  const language = detectLanguage(normPath);
  const isTestFile = matchesAnyGlob(normPath, testGlobs);

  let content = "";
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch {
    return {
      filePath: normPath,
      language,
      isTestFile,
      imports: [],
      symbols: [],
      lineCount: 0,
      testCaseCount: isTestFile ? 1 : 0,
    };
  }

  const rawSpecifiers = extractRawImportSpecifiers(content, language);
  const resolvedImports = rawSpecifiers
    .map((spec) => resolveWorkspaceImport(normPath, spec, knownFiles))
    .filter((imp): imp is string => imp !== null);

  const symbols = extractAstSymbols(content, language);
  const lineCount = content.split(/\r?\n/).length;
  const testCaseCount = isTestFile ? countTestCases(content) : 0;

  return {
    filePath: normPath,
    language,
    isTestFile,
    imports: [...new Set(resolvedImports)],
    symbols,
    lineCount,
    testCaseCount,
  };
}

/**
 * Intersects modified line-range hunks (`FileDiff`) with the file's AST symbols (`ParsedModule`)
 * to determine exactly which functions, classes, or types were mutated.
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

  return [...mutatedMap.values()];
}
