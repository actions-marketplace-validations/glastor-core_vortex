/**
 * @module scripts/verify-commit
 * @description Validates Git commit messages against `.github/COMMIT_CONVENTION.md`
 *              (Conventional Commits specification for `@glastor-core/vortex`).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as fs from "node:fs";
import { resolveSafeWorkspacePath } from "../src/security.ts";

export const COMMIT_MSG_REGEX =
  /^(?:Merge\b|Revert\b|revert:\s)|^(feat|fix|polish|docs|style|refactor|perf|test|workflow|ci|chore|types|sec)(\([\w.-]+\))?!?: .{3,100}$/;

/**
 * Validates a commit message header against the Vortex Conventional Commits standard.
 */
export function validateCommitMessage(rawMessage: string): {
  valid: boolean;
  header: string;
  reason?: string;
} {
  const lines = rawMessage
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const header = lines[0] ?? "";
  if (!header) {
    return {
      valid: false,
      header: "",
      reason: "Commit message is empty.",
    };
  }

  if (!COMMIT_MSG_REGEX.test(header)) {
    return {
      valid: false,
      header,
      reason:
        "Header does not match Conventional Commits format: <type>(<optional-scope>): <subject> (3-100 chars).",
    };
  }

  return { valid: true, header };
}

if (import.meta.main) {
  const msgFileArg = Deno.args[0] || ".git/COMMIT_EDITMSG";
  let rawMsg = "";

  try {
    const safePath = resolveSafeWorkspacePath(Deno.cwd(), msgFileArg);
    rawMsg = fs.readFileSync(safePath, "utf-8");
  } catch (err) {
    console.error(
      `❌ [Vortex commit-msg] Could not read commit message file '${msgFileArg}':`,
      err,
    );
    Deno.exit(1);
  }

  const result = validateCommitMessage(rawMsg);
  if (!result.valid) {
    console.error(`
❌ [Vortex Commit Guard] Invalid commit message header:
   "${result.header}"

   Reason: ${result.reason}
   Allowed types : feat, fix, perf, sec, refactor, docs, test, ci, workflow, chore, style, types, polish
   Example scopes: ast, dag, scheduler, governance, reporters, appsec, hooks, ci
   Valid example : feat(ast): add symbol-level barrel pruning for re-exports
   Reference     : .github/COMMIT_CONVENTION.md
`);
    Deno.exit(1);
  }

  console.log(`✅ [Vortex Commit Guard] Conventional Commit verified: "${result.header}"`);
}
