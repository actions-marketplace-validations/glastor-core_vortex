/**
 * @module git/diff-parser
 * @description Surgical `git diff --unified=0` parser extracting modified files, exact line-range hunks,
 *              and semantic noise filtering (comments/whitespace-only modifications).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import type { FileDiff } from "../types.ts";
import { isSafeRelativeFilePath, isValidGitRef } from "../security.ts";

/**
 * Checks whether a single code line is purely blank or a single-line comment across TS/JS/Py/Rust/Go.
 */
export function isCommentOrBlankLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("*/") ||
    trimmed.startsWith("<!--")
  ) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether a diff hunk only touches comments, whitespace, or formatting without changing logic.
 */
export function evaluateHunkSemanticNoise(addedLines: string[], removedLines: string[]): boolean {
  const allLines = [...addedLines, ...removedLines];
  if (allLines.length === 0) return true;

  // 1. All added & removed lines are comments or blank lines
  if (allLines.every((line) => isCommentOrBlankLine(line))) {
    return true;
  }

  // 2. Pure whitespace / indentation / formatting change (normalized code tokens are identical)
  const normalizeCode = (lines: string[]) =>
    lines
      .filter((l) => !isCommentOrBlankLine(l))
      .join(" ")
      .replace(/\s+/g, "");

  const normAdded = normalizeCode(addedLines);
  const normRemoved = normalizeCode(removedLines);
  if (normAdded.length > 0 && normAdded === normRemoved) {
    return true;
  }

  return false;
}

/**
 * Parses a raw unified diff output (`git diff --unified=0`) into structured `FileDiff` entries.
 */
export function parseUnifiedDiff(rawDiff: string): FileDiff[] {
  const files: FileDiff[] = [];
  if (!rawDiff || !rawDiff.trim()) return files;

  const lines = rawDiff.split(/\r?\n/);
  let currentFile: FileDiff | null = null;
  let currentHunk: {
    startLine: number;
    lineCount: number;
    addedLines: string[];
    removedLines: string[];
  } | null = null;

  const flushHunk = () => {
    if (currentFile && currentHunk) {
      const endLine = currentHunk.lineCount > 0
        ? currentHunk.startLine + currentHunk.lineCount - 1
        : currentHunk.startLine;
      const isSemanticNoise = evaluateHunkSemanticNoise(
        currentHunk.addedLines,
        currentHunk.removedLines,
      );
      currentFile.hunks.push({
        startLine: currentHunk.startLine,
        lineCount: currentHunk.lineCount,
        endLine,
        addedLines: currentHunk.addedLines,
        removedLines: currentHunk.removedLines,
        isSemanticNoise,
      });
      currentHunk = null;
    }
  };

  const flushFile = () => {
    flushHunk();
    if (currentFile && isSafeRelativeFilePath(currentFile.filePath)) {
      currentFile.isCommentOrFormatOnly = currentFile.hunks.length > 0 &&
        currentFile.hunks.every((h) => h.isSemanticNoise);
      files.push(currentFile);
    }
    currentFile = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      // Extract b/<path> from `diff --git a/foo.ts b/foo.ts`
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const filePath = (match ? match[2] : line.slice(11)).replace(/\\/g, "/").trim();
      currentFile = {
        filePath,
        status: "M",
        hunks: [],
        isCommentOrFormatOnly: false,
      };
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("new file mode ")) {
      currentFile.status = "A";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.status = "D";
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      currentFile.status = "R";
      if (line.startsWith("rename to ")) {
        currentFile.filePath = line.slice("rename to ".length).replace(/\\/g, "/").trim();
      }
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ")) {
      continue;
    }

    // Parse unified=0 hunk header: `@@ -oldStart,oldCount +newStart,newCount @@`
    if (line.startsWith("@@ ")) {
      flushHunk();
      const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunkMatch) {
        const startLine = Number.parseInt(hunkMatch[1], 10);
        const lineCount = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
        currentHunk = {
          startLine: Math.max(1, startLine),
          lineCount,
          addedLines: [],
          removedLines: [],
        };
      }
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentHunk.addedLines.push(line.slice(1));
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        currentHunk.removedLines.push(line.slice(1));
      }
    }
  }

  flushFile();
  return files;
}

/**
 * Executes `git diff --unified=0` in the target workspace to obtain line-level hunks.
 * Gracefully falls back to working-tree diff or `git status --porcelain` if the repo has a single commit.
 */
export function getWorkspaceGitDiff(
  workspaceDir: string,
  baseRef: string,
  headRef: string,
): FileDiff[] {
  const runGit = (args: string[]): { success: boolean; stdout: string } => {
    try {
      const cmd = new Deno.Command("git", {
        args,
        cwd: workspaceDir,
        stdout: "piped",
        stderr: "piped",
      });
      const out = cmd.outputSync();
      return {
        success: out.code === 0,
        stdout: new TextDecoder().decode(out.stdout),
      };
    } catch {
      return { success: false, stdout: "" };
    }
  };

  const safeBase = isValidGitRef(baseRef) ? baseRef.trim() : "HEAD~1";
  const safeHead = isValidGitRef(headRef) ? headRef.trim() : "HEAD";

  // 1. Try explicit range `safeBase...safeHead`
  let res = runGit(["diff", "--unified=0", `${safeBase}...${safeHead}`, "--"]);
  if (res.success && res.stdout.trim().length > 0) {
    return parseUnifiedDiff(res.stdout);
  }

  // 2. Fallback: working tree + staged changes against HEAD
  res = runGit(["diff", "--unified=0", "HEAD", "--"]);
  if (res.success && res.stdout.trim().length > 0) {
    return parseUnifiedDiff(res.stdout);
  }

  // 3. Fallback: latest commit diff (`git show --format= --unified=0 HEAD`)
  res = runGit(["show", "--format=", "--unified=0", "HEAD", "--"]);
  if (res.success && res.stdout.trim().length > 0) {
    return parseUnifiedDiff(res.stdout);
  }

  return [];
}
