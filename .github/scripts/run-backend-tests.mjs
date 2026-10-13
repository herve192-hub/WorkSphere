import { mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const suite = process.argv[2];
if (!["unit", "integration"].includes(suite)) {
  console.error("Usage: node .github/scripts/run-backend-tests.mjs <unit|integration>");
  process.exit(2);
}
const backend = fileURLToPath(new URL("../../backend/", import.meta.url));
const unitFiles = new Set(["employee-validation.test.js", "error-handler.test.js"]);
const testFiles = readdirSync(`${backend}/tests`).filter((file) => file.endsWith(".test.js")).sort();
// New tests default to integration so CI cannot silently omit a new test file.
const selected = testFiles.filter((file) => unitFiles.has(file) === (suite === "unit"));
if (!selected.length || [...unitFiles].some((file) => !testFiles.includes(file))) {
  console.error("Test suite is empty or a declared unit test file is missing.");
  process.exit(1);
}
mkdirSync(`${backend}/reports`, { recursive: true });
const result = spawnSync(process.execPath, [
  "--test", "--experimental-test-coverage",
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=junit", `--test-reporter-destination=reports/${suite}-junit.xml`,
  "--test-reporter=lcov", `--test-reporter-destination=reports/${suite}-lcov.info`,
  ...selected.map((file) => `tests/${file}`),
], { cwd: backend, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
