/**
 * @module security
 * @description Zero-Trust AppSec & DevSecOps security guards for Vortex:
 *              - CWE-88 Git Argument Injection prevention
 *              - CWE-22 Path Traversal containment within workspace root
 *              - CWE-78 / CWE-93 GitHub Actions Workflow Command & Output Injection sanitization
 *              - CWE-918 SSRF HTTPS validation for GitHub API endpoints
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import * as path from "node:path";

/**
 * Validates a Git revision reference (`base-ref` / `head-ref`) to prevent CWE-88 Argument Injection.
 * Rejects strings starting with `-`, containing whitespace, control characters, or shell metacharacters.
 */
export function isValidGitRef(ref: string): boolean {
  if (!ref || typeof ref !== "string") return false;
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  // Must never start with `-` (prevents flag injection like `--output=...` or `--ext-diff`)
  if (trimmed.startsWith("-")) return false;
  // Disallow Git range/traversal abuse (`..` is handled by Vortex itself, not inside single ref)
  if (trimmed.includes("..") || trimmed.includes("@{") || trimmed.includes("\\")) return false;
  // Allow only safe Git ref characters (alphanumeric, slash, dot, underscore, tilde, caret, hyphen)
  return /^[A-Za-z0-9._/~^-]+$/.test(trimmed);
}

/**
 * Validates that a relative file path from the repository contains no traversal (`..`),
 * null bytes, control characters, or shell metacharacters.
 */
export function isSafeRelativeFilePath(relPath: string): boolean {
  if (!relPath || typeof relPath !== "string") return false;
  const norm = relPath.replace(/\\/g, "/").trim();
  if (norm.length === 0 || norm.length > 512) return false;
  if (norm.startsWith("/") || norm.startsWith("-")) return false;
  const segments = norm.split("/");
  if (segments.some((s) => s === ".." || s === "")) return false;
  // Reject control characters and shell/injection metacharacters
  if (/[\0\r\n;|&$`><'"{}[\]()]/.test(norm)) return false;
  return true;
}

/**
 * Resolves a target path against `workspaceDir` and strictly verifies that the resolved path
 * remains lexically contained inside `workspaceDir` (prevents CWE-22 Arbitrary File Read/Write).
 */
export function resolveSafeWorkspacePath(workspaceDir: string, targetPath: string): string {
  const absWorkspace = path.resolve(workspaceDir);
  const absTarget = path.resolve(absWorkspace, targetPath);
  const rel = path.relative(absWorkspace, absTarget);

  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `[Vortex Security CWE-22] Path traversal blocked: '${targetPath}' resolves outside workspace '${absWorkspace}'.`,
    );
  }
  return absTarget;
}

/**
 * Escapes message data for GitHub Actions Workflow Commands (`::notice`, `::warning`, `::error`)
 * per official GitHub runner specification (`%` -> `%25`, `\r` -> `%0D`, `\n` -> `%0A`).
 */
export function escapeWorkflowCommandData(val: string): string {
  return String(val)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * Escapes property values (`file=...`, `title=...`) inside GitHub Actions Workflow Commands
 * per official GitHub runner specification (`%`, `\r`, `\n`, `:`, `,`).
 */
export function escapeWorkflowCommandProperty(val: string): string {
  return String(val)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/**
 * Sanitizes a single-line value before writing `key=value` to `$GITHUB_OUTPUT`
 * to prevent CWE-93 newline output injection.
 */
export function sanitizeGitHubOutputValue(val: string | number | boolean): string {
  return String(val).replace(/[\r\n\0]+/g, " ").trim();
}

/**
 * Validates that a GitHub API base URL uses HTTPS (or localhost in tests) to prevent CWE-918 SSRF / credential leakage.
 */
export function isSafeGitHubApiUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "https:") return true;
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
