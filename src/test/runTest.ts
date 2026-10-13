import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

/**
 * Launches a real VS Code Extension Development Host for the smoke test.
 * The VS Code build is pinned to the engines minimum so results are reproducible.
 * Use `npm run test:extension` (on Linux without a display, run it under xvfb-run).
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const testWorkspace = path.resolve(__dirname, "../../test-fixtures/empty-workspace");
  const cacheRoot = path.join(os.homedir(), ".cache", "patchpilot-vscode-test");

  await runTests({
    version: "1.105.0",
    cachePath: cacheRoot,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      testWorkspace,
      `--user-data-dir=${path.join(cacheRoot, "user-data")}`,
      `--extensions-dir=${path.join(cacheRoot, "extensions")}`,
      "--disable-extensions",
      "--skip-welcome",
      "--skip-release-notes"
    ]
  });
}

main().catch((error: unknown) => {
  console.error("Extension smoke test failed to run:", error);
  process.exit(1);
});
