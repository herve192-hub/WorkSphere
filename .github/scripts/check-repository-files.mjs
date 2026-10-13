import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(args, input) {
  const result = spawnSync("git", args, { input, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

const files = git(["ls-files", "-z", "--cached"]);
if (files.status !== 0) throw new Error(files.stderr || "Cannot inspect tracked files.");
const paths = files.stdout.split("\0").filter(Boolean);
const tracked = new Set(paths);
const problems = new Set();

// --no-index checks tracked files too; Git normally skips them when ignoring.
// Verbose NUL records distinguish ignored paths from explicit ! exceptions.
const ignored = git([
  "check-ignore", "--no-index", "--stdin", "-z", "--verbose", "--non-matching",
], files.stdout);
if (ignored.status !== 0 && ignored.status !== 1) {
  throw new Error(ignored.stderr || "Cannot inspect ignore rules.");
}
const records = ignored.stdout.split("\0");
records.pop();
if (records.length % 4 !== 0) throw new Error("Invalid Git ignore results.");
for (let i = 0; i < records.length; i += 4) {
  const pattern = records[i + 2];
  const path = records[i + 3];
  if (pattern && !pattern.startsWith("!")) {
    problems.add(`Tracked file matches an ignore rule: ${JSON.stringify(path)}`);
  }
}

const templates = new Set(["backend/.env.example", "frontend/.env.example"]);
for (const path of paths) {
  const name = path.split("/").at(-1);
  if ((/^\.env/i.test(name) || /\.env(?:\.|$)/i.test(name)) && !templates.has(path)) {
    problems.add(`Environment file must stay local: ${JSON.stringify(path)}`);
  }
}

for (const path of ["backend/.npmrc", "frontend/.npmrc"]) {
  if (tracked.has(path) && readFileSync(path, "utf8").trim() !== "save-exact=true") {
    problems.add(`Shared npm configuration may contain only save-exact=true: ${JSON.stringify(path)}`);
  }
}

if (problems.size) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log(`Repository file policy passed for ${paths.length} tracked files.`);
}
