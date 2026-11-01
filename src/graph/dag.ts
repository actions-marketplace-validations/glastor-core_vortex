/**
 * @module graph/dag
 * @description Reverse Dependency Directed Acyclic Graph (DAG), Symbol-Level AST Barrel Pruning,
 *              and BFS Transitive Reachability Engine (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileDiff, MutatedSymbol, ParsedModule, PrunedDependencyEdge } from "../types.ts";
import {
  detectLanguage,
  detectMutatedSymbols,
  loadWorkspacePathAliases,
  matchesAnyGlob,
  parseWorkspaceFile,
} from "../ast/analyzer.ts";

/**
 * Recursively scans the workspace directory for all source and test files, excluding `ignoreDirs`.
 */
export function scanWorkspaceFiles(workspaceDir: string, ignoreDirs: string[]): string[] {
  const ignoreSet = new Set(ignoreDirs);
  const discovered: string[] = [];

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignoreSet.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = path.relative(workspaceDir, path.join(dir, entry.name)).replace(/\\/g, "/");
        discovered.push(rel);
      }
    }
  };

  walk(workspaceDir);
  return discovered.sort();
}

/**
 * Directed Dependency Graph storing both forward (`A imports B`) and reverse (`B is imported by A`) edges,
 * with support for fine-grained Symbol-Level AST Barrel Pruning.
 */
export class DependencyDag {
  private readonly modules = new Map<string, ParsedModule>();
  /** Reverse adjacency list: `targetFile -> Set<importerFile>` */
  private readonly reverseEdges = new Map<string, Set<string>>();

  /**
   * Registers a parsed module and indexes its import edges.
   */
  public addModule(mod: ParsedModule): void {
    this.modules.set(mod.filePath, mod);
    if (!this.reverseEdges.has(mod.filePath)) {
      this.reverseEdges.set(mod.filePath, new Set());
    }
    for (const importedPath of mod.imports) {
      if (!this.reverseEdges.has(importedPath)) {
        this.reverseEdges.set(importedPath, new Set());
      }
      this.reverseEdges.get(importedPath)!.add(mod.filePath);
    }
  }

  public getModule(filePath: string): ParsedModule | undefined {
    return this.modules.get(filePath);
  }

  public getAllModules(): ParsedModule[] {
    return [...this.modules.values()];
  }

  public getAllTestModules(): ParsedModule[] {
    return [...this.modules.values()].filter((m) => m.isTestFile);
  }

  public getDirectDependents(filePath: string): string[] {
    return [...(this.reverseEdges.get(filePath) ?? [])];
  }

  /**
   * Executes Breadth-First Search (BFS) from a set of seed modified files across the Reverse DAG
   * to find all transitively impacted test files, applying Symbol-Level AST Barrel Pruning when enabled.
   */
  public findImpactedTests(
    seedFiles: string[],
    options?: {
      symbolLevelPruning?: boolean;
      seedActiveSymbols?: Map<string, Set<string>>;
    },
  ): Map<string, { chain: string[]; depth: number }> {
    return this.findImpactedTestsWithPruning(seedFiles, options).impactedTests;
  }

  /**
   * Full BFS reachability returning impacted tests, all impacted source files, and pruned barrel edges.
   */
  public findImpactedTestsWithPruning(
    seedFiles: string[],
    options?: {
      symbolLevelPruning?: boolean;
      seedActiveSymbols?: Map<string, Set<string>>;
    },
  ): {
    impactedTests: Map<string, { chain: string[]; depth: number }>;
    impactedFiles: Set<string>;
    prunedEdges: PrunedDependencyEdge[];
  } {
    const symbolLevelPruning = options?.symbolLevelPruning ?? false;
    const seedActiveSymbols = options?.seedActiveSymbols;

    const impactedTests = new Map<string, { chain: string[]; depth: number }>();
    const impactedFiles = new Set<string>();
    const prunedEdges: PrunedDependencyEdge[] = [];

    const activeSymbolsByFile = new Map<string, Set<string>>();
    const queue: Array<{ current: string; chain: string[]; depth: number }> = [];

    for (const seed of seedFiles) {
      const initialSyms = seedActiveSymbols?.get(seed) ?? new Set(["*"]);
      activeSymbolsByFile.set(seed, new Set(initialSyms));
      impactedFiles.add(seed);
      queue.push({ current: seed, chain: [seed], depth: 0 });
    }

    while (queue.length > 0) {
      const item = queue.shift()!;
      const mod = this.modules.get(item.current);
      const currentActiveSyms = activeSymbolsByFile.get(item.current) ?? new Set(["*"]);

      if (mod && mod.isTestFile) {
        if (!impactedTests.has(mod.filePath)) {
          impactedTests.set(mod.filePath, {
            chain: item.chain,
            depth: item.depth,
          });
        }
      }

      const dependents = this.reverseEdges.get(item.current);
      if (!dependents) continue;

      const isWildcardActive = currentActiveSyms.has("*") ||
        currentActiveSyms.has("<module-scope>");

      for (const dep of dependents) {
        const depMod = this.modules.get(dep);
        let nextActiveSyms = new Set<string>(["*"]);

        if (
          symbolLevelPruning &&
          !isWildcardActive &&
          depMod &&
          depMod.importBindings &&
          depMod.importBindings.length > 0
        ) {
          const bindingsForCurrent = depMod.importBindings.filter(
            (b) => b.resolvedFilePath === item.current,
          );

          if (bindingsForCurrent.length > 0) {
            const importedNames = new Set<string>();
            let hasReExport = false;
            for (const b of bindingsForCurrent) {
              if (b.isReExport) hasReExport = true;
              for (const s of b.importedSymbols) {
                importedNames.add(s);
              }
            }

            if (!importedNames.has("*")) {
              const matched = [...importedNames].filter((s) => currentActiveSyms.has(s));
              if (matched.length === 0) {
                prunedEdges.push({
                  fromFile: item.current,
                  toFile: dep,
                  importedSymbols: [...importedNames],
                  mutatedSymbolsInSource: [...currentActiveSyms],
                });
                continue;
              }

              // Compute which symbols inside `depMod` are activated by `matched`
              if (!depMod.isTestFile && depMod.symbols.length > 0) {
                const depActive = new Set<string>();
                if (hasReExport) {
                  for (const m of matched) depActive.add(m);
                }
                for (const sym of depMod.symbols) {
                  const refs = sym.referencedIdentifiers ?? [];
                  if (refs.some((r) => matched.includes(r))) {
                    depActive.add(sym.name);
                  }
                }
                // Propagate intra-module callers inside `depMod`
                let expanded = true;
                while (expanded) {
                  expanded = false;
                  for (const sym of depMod.symbols) {
                    if (depActive.has(sym.name)) continue;
                    const refs = sym.referencedIdentifiers ?? [];
                    if (refs.some((r) => depActive.has(r))) {
                      depActive.add(sym.name);
                      expanded = true;
                    }
                  }
                }
                nextActiveSyms = depActive.size > 0 ? depActive : new Set(["*"]);
              }
            }
          }
        }

        const existingSyms = activeSymbolsByFile.get(dep);
        if (!existingSyms) {
          activeSymbolsByFile.set(dep, nextActiveSyms);
          impactedFiles.add(dep);
          queue.push({
            current: dep,
            chain: [...item.chain, dep],
            depth: item.depth + 1,
          });
        } else {
          // If newly discovered symbols expand the active set on `dep`, re-propagate
          let addedNew = false;
          for (const s of nextActiveSyms) {
            if (!existingSyms.has(s) && !existingSyms.has("*")) {
              existingSyms.add(s);
              addedNew = true;
            }
          }
          if (addedNew) {
            queue.push({
              current: dep,
              chain: [...item.chain, dep],
              depth: item.depth + 1,
            });
          }
        }
      }
    }

    return { impactedTests, impactedFiles, prunedEdges };
  }
}

/**
 * Builds the workspace Reverse Dependency DAG and evaluates the blast radius of a Git diff.
 */
export function buildDagAndEvaluateImpact(params: {
  workspaceDir: string;
  changedFiles: FileDiff[];
  testGlobs: string[];
  failSafeGlobs: string[];
  ignoreDirs: string[];
  ignoreTypeOnlyChanges: boolean;
  symbolLevelPruning?: boolean;
}): {
  dag: DependencyDag;
  triggeredFailSafeFiles: string[];
  mutatedSymbols: MutatedSymbol[];
  prunedEdges: PrunedDependencyEdge[];
  impactedFiles: Set<string>;
  reachableTests: Map<string, { chain: string[]; depth: number }>;
  allChangesAreSemanticNoise: boolean;
} {
  const {
    workspaceDir,
    changedFiles,
    testGlobs,
    failSafeGlobs,
    ignoreDirs,
    ignoreTypeOnlyChanges,
    symbolLevelPruning = true,
  } = params;

  const allFiles = scanWorkspaceFiles(workspaceDir, ignoreDirs);
  const knownFiles = new Set(allFiles);
  const pathAliases = loadWorkspacePathAliases(workspaceDir);
  const dag = new DependencyDag();

  for (const relPath of allFiles) {
    const lang = detectLanguage(relPath);
    const isTest = matchesAnyGlob(relPath, testGlobs);
    if (lang !== "unknown" || isTest) {
      const parsed = parseWorkspaceFile(workspaceDir, relPath, testGlobs, knownFiles, pathAliases);
      dag.addModule(parsed);
    }
  }

  const triggeredFailSafeFiles: string[] = [];
  const mutatedSymbols: MutatedSymbol[] = [];
  const activeSeedFiles: string[] = [];
  const seedActiveSymbols = new Map<string, Set<string>>();

  for (const diff of changedFiles) {
    if (matchesAnyGlob(diff.filePath, failSafeGlobs)) {
      triggeredFailSafeFiles.push(diff.filePath);
    }

    if (diff.isCommentOrFormatOnly) {
      continue;
    }

    const modAst = dag.getModule(diff.filePath);
    const fileSymbols = detectMutatedSymbols(diff, modAst);

    const effectiveSymbols = ignoreTypeOnlyChanges
      ? fileSymbols.filter((s) => !s.isTypeOnly)
      : fileSymbols;

    mutatedSymbols.push(...effectiveSymbols);

    if (effectiveSymbols.length > 0 && (modAst || matchesAnyGlob(diff.filePath, testGlobs))) {
      activeSeedFiles.push(diff.filePath);
      seedActiveSymbols.set(
        diff.filePath,
        new Set(effectiveSymbols.map((s) => s.symbolName)),
      );
    }
  }

  const allChangesAreSemanticNoise = changedFiles.length === 0 ||
    (triggeredFailSafeFiles.length === 0 && activeSeedFiles.length === 0);

  const { impactedTests: reachableTests, impactedFiles, prunedEdges } = dag
    .findImpactedTestsWithPruning(activeSeedFiles, {
      symbolLevelPruning,
      seedActiveSymbols,
    });

  return {
    dag,
    triggeredFailSafeFiles,
    mutatedSymbols,
    prunedEdges,
    impactedFiles,
    reachableTests,
    allChangesAreSemanticNoise,
  };
}
