/**
 * @module scripts/pre-push
 * @description Shift-Left Push Protection Guard for `@glastor-core/vortex`:
 *              Verifies strict type safety, full test suite, and Vortex AST Blast-Radius Gatekeeper
 *              before allowing `git push` to remote.
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

function runStep(label: string, args: string[]): void {
  console.log(`🛡️ [Vortex pre-push] ${label}...`);
  const cmd = new Deno.Command("deno", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });
  const out = cmd.outputSync();
  if (out.code !== 0) {
    console.error(`❌ [Vortex pre-push] Push blocked at step: ${label}`);
    Deno.exit(out.code);
  }
}

if (import.meta.main) {
  const start = performance.now();
  runStep("1/3 Strict TypeScript Check", ["task", "check"]);
  runStep("2/3 Full Test & AppSec Suite", ["task", "test"]);
  runStep("3/3 Vortex AST Self-Audit & Blast-Radius Gatekeeper", [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-run=git",
    "src/main.ts",
    "--report-file",
    ".vortex/cache/pre-push-report.json",
  ]);
  const elapsed = Math.round(performance.now() - start);
  console.log(`✅ [Vortex pre-push] Push Protection verified in ${elapsed}ms.`);
}
