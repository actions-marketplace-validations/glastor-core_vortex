# Security Policy & Zero-Trust AppSec Architecture

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | :white_check_mark: |
| 1.0.x   | :white_check_mark: |

## 🛡️ Built-in AppSec & DevSecOps Controls (`src/security.ts`)

**Vortex (`glastor-core/vortex`)** is engineered under a strict **Zero-Trust AppSec posture** aligned with OWASP Top 10, CWE/SANS Top 25, and GitHub Actions Security Hardening guidelines:

1. **Zero External Dependencies (Supply-Chain Immunity):** Executes 100% on native Deno 2 runtime modules (`node:util`, `node:fs`, `node:path`, `node:assert/strict`) with `0` third-party npm or JSR packages, eliminating transitive supply-chain poisoning risks.
2. **CWE-88 (Git Argument Injection Prevention):** `isValidGitRef` strictly validates `base-ref` and `head-ref` against flag injection (rejecting leading `-` such as `--output=` or `--ext-diff`) and passes `--` path delimiters to `git diff`.
3. **CWE-22 (Path Traversal Containment):** `resolveSafeWorkspacePath` and `isSafeRelativeFilePath` enforce strict lexical containment inside `workspaceDir` for `report-file`, `telemetry-path`, `update-telemetry`, and parsed diff file paths.
4. **CWE-78 / CWE-93 (GitHub Actions Workflow Command & `$GITHUB_OUTPUT` Injection Prevention):** `escapeWorkflowCommandData`, `escapeWorkflowCommandProperty`, and `sanitizeGitHubOutputValue` encode `%`, `\r`, `\n`, `:`, and `,` per official GitHub Actions runner specifications.
5. **CWE-918 (SSRF & Credential Protection):** `isSafeGitHubApiUrl` enforces `https://` transport and a strict `5000ms` `AbortSignal.timeout` when posting sticky PR comments via `GITHUB_TOKEN`.
6. **Composite Action Isolation:** `action.yml` executes Deno with `--config "${{ github.action_path }}/deno.json"` to prevent untrusted repository configuration files from hijacking module resolution.

## Reporting a Vulnerability

If you discover a security vulnerability within **Vortex**, please report it privately to the **GLASTOR® Core Security Team**:

- **Email:** [ventas@glastor.es](mailto:ventas@glastor.es)
- **Website:** [https://glastor.es](https://glastor.es)
- **Lead Maintainer:** [@glastor-dev](https://github.com/glastor-dev) (GitHub Developer Program Member)

We respond to all security reports within 24 hours and release patches within 72 hours of verification.
