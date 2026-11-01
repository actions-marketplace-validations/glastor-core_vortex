/**
 * @module scripts/pre-commit
 * @description Shift-Left Pre-Commit Guard for `@glastor-core/vortex`:
 *              Verifies formatting (`deno fmt --check`), linter (`deno lint`),
 *              strict TypeScript types (`deno task check`), and the AppSec test suite (`deno task test`).
 * @author GLASTOR® Core (@glastor-dev) <ventas@glastor.es>
 * @license MIT
 */

function runStep(label: string, args: string[]): void {
  console.log(`⚡ [Vortex pre-commit] ${label}...`);
  const cmd = new Deno.Command("deno", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });
  const out = cmd.outputSync();
  if (out.code !== 0) {
    console.error(`❌ [Vortex pre-commit] Failed at step: ${label}`);
    Deno.exit(out.code);
  }
}

if (import.meta.main) {
  const start = performance.now();
  runStep("1/4 Formatting Verification (deno fmt --check)", ["fmt", "--check"]);
  runStep("2/4 Static Linter Verification (deno lint)", ["lint"]);
  runStep("3/4 Strict TypeScript Check (deno task check)", ["task", "check"]);
  runStep("4/4 Unit, E2E & AppSec CWE Test Suite (deno task test)", ["task", "test"]);
  const elapsed = Math.round(performance.now() - start);
  console.log(`✅ [Vortex pre-commit] All Shift-Left checks passed in ${elapsed}ms.`);
}
