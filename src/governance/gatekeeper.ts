/**
 * @module governance/gatekeeper
 * @description Extracts Jira/Linear/GitHub issue keys from branches/commits, evaluates Blast-Radius
 *              Gatekeeper thresholds, and computes target file sets for `glastor-core/nemesis` (v1.1.0).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

import type { GovernanceMetadata } from "../types.ts";

/**
 * Extracts Jira/Linear style keys (`GLS-402`, `PROJ-123`) and GitHub issue references (`GH-88`, `#42`)
 * from branch names, commit messages, PR titles, or explicit context strings.
 */
export function extractTicketIds(sources: Array<string | undefined>): string[] {
  const found = new Set<string>();
  // Standard Jira / Linear / YouTrack issue key: 2-10 uppercase letters + hyphen + 1-7 digits
  const jiraLinearRegex = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;
  // GitHub `#123` issue/PR references
  const ghHashRegex = /(?:^|[\s(])#(\d{1,7})\b/g;

  const ignoredPrefixes = new Set(["UTF", "SHA", "ISO", "CWE", "CVE", "RFC", "HTTP", "NODE"]);

  for (const src of sources) {
    if (!src || !src.trim()) continue;

    let m: RegExpExecArray | null;
    while ((m = jiraLinearRegex.exec(src)) !== null) {
      const key = m[1];
      const prefix = key.split("-")[0];
      if (!ignoredPrefixes.has(prefix)) {
        found.add(key);
      }
    }

    while ((m = ghHashRegex.exec(src)) !== null) {
      found.add(`#${m[1]}`);
    }
  }

  return [...found];
}

/**
 * Reads current Git branch name and latest commit subject from the workspace when available.
 */
export function getGitContextStrings(workspaceDir: string): string[] {
  const results: string[] = [];

  const envSources = [
    Deno.env.get("GITHUB_HEAD_REF"),
    Deno.env.get("GITHUB_REF_NAME"),
    Deno.env.get("PR_TITLE"),
  ];
  for (const s of envSources) {
    if (s) results.push(s);
  }

  const runGit = (args: string[]): string => {
    try {
      const cmd = new Deno.Command("git", {
        args,
        cwd: workspaceDir,
        stdout: "piped",
        stderr: "piped",
      });
      const out = cmd.outputSync();
      if (out.code === 0) {
        return new TextDecoder().decode(out.stdout).trim();
      }
    } catch {
      // Ignore
    }
    return "";
  };

  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") results.push(branch);

  const commitMsg = runGit(["log", "-1", "--pretty=%B"]);
  if (commitMsg) results.push(commitMsg);

  return results;
}

/**
 * Evaluates Governance metadata: Ticket traceability, Blast-Radius Gatekeeper pass/fail,
 * and `glastor-core/nemesis` DevSecOps target files.
 */
export function evaluateGovernance(params: {
  workspaceDir: string;
  ticketContext?: string;
  blastRadiusScore: number;
  maxBlastRadius: number;
  changedFilesPaths: string[];
  impactedFiles: Set<string>;
}): GovernanceMetadata {
  const {
    workspaceDir,
    ticketContext,
    blastRadiusScore,
    maxBlastRadius,
    changedFilesPaths,
    impactedFiles,
  } = params;

  const contextStrings = [ticketContext, ...getGitContextStrings(workspaceDir)];
  const detectedTicketIds = extractTicketIds(contextStrings);
  const blastRadiusPassed = blastRadiusScore <= maxBlastRadius;

  const nemesisSet = new Set<string>([...changedFilesPaths, ...impactedFiles]);
  const nemesisTargetFiles = [...nemesisSet].sort();

  return {
    detectedTicketIds,
    maxBlastRadiusScore: maxBlastRadius,
    blastRadiusPassed,
    nemesisTargetFiles,
  };
}
