/**
 * @module graph/dag
 * @description Reverse Dependency Directed Acyclic Graph (DAG) & BFS Transitive Reachability Engine.
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileDiff, MutatedSymbol, ParsedModule } from "../types.ts";
import {
  detectLanguage,
  detectMutatedSymbols,
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
 * Directed Dependency Graph storing both forward (`A imports B`) and reverse (`B is imported by A`) edges.
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
   * to find all transitively impacted test files and their shortest dependency chain (`impactChain`).
   */
  public findImpactedTests(seedFiles: string[]): Map<string, { chain: string[]; depth: number }> {
    const impactedTests = new Map<string, { chain: string[]; depth: number }>();
    const visited = new Set<string>();
    const queue: Array<{ current: string; chain: string[]; depth: number }> = [];

    for (const seed of seedFiles) {
      visited.add(seed);
      queue.push({ current: seed, chain: [seed], depth: 0 });
    }

    while (queue.length > 0) {
      const item = queue.shift()!;
      const mod = this.modules.get(item.current);

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

      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push({
            current: dep,
            chain: [...item.chain, dep],
            depth: item.depth + 1,
          });
        }
      }
    }

    return impactedTests;
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
}): {
  dag: DependencyDag;
  triggeredFailSafeFiles: string[];
  mutatedSymbols: MutatedSymbol[];
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
  } = params;

  const allFiles = scanWorkspaceFiles(workspaceDir, ignoreDirs);
  const knownFiles = new Set(allFiles);
  const dag = new DependencyDag();

  for (const relPath of allFiles) {
    const lang = detectLanguage(relPath);
    const isTest = matchesAnyGlob(relPath, testGlobs);
    if (lang !== "unknown" || isTest) {
      const parsed = parseWorkspaceFile(workspaceDir, relPath, testGlobs, knownFiles);
      dag.addModule(parsed);
    }
  }

  const triggeredFailSafeFiles: string[] = [];
  const mutatedSymbols: MutatedSymbol[] = [];
  const activeSeedFiles: string[] = [];

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

    // If a source or test file has runtime-relevant symbol changes, add it as a BFS seed
    if (effectiveSymbols.length > 0 && (modAst || matchesAnyGlob(diff.filePath, testGlobs))) {
      activeSeedFiles.push(diff.filePath);
    }
  }

  const allChangesAreSemanticNoise = changedFiles.length === 0 ||
    (triggeredFailSafeFiles.length === 0 && activeSeedFiles.length === 0);

  const reachableTests = dag.findImpactedTests(activeSeedFiles);

  return {
    dag,
    triggeredFailSafeFiles,
    mutatedSymbols,
    reachableTests,
    allChangesAreSemanticNoise,
  };
}
