import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory) throw new Error("Pass the directory containing CodeQL SARIF reports.");
const files = readdirSync(directory).filter((file) => file.endsWith(".sarif"));
if (!files.length) throw new Error("CodeQL did not produce a SARIF report.");
let blocking = 0;
for (const file of files) {
  const report = JSON.parse(readFileSync(join(directory, file), "utf8"));
  if (!Array.isArray(report.runs)) throw new Error(`Invalid SARIF report: ${file}`);
  for (const run of report.runs) {
    const rules = run.tool?.driver?.rules || [];
    for (const result of run.results || []) {
      const rule = rules[result.ruleIndex] || rules.find((entry) => entry.id === result.ruleId);
      const severity = rule?.properties?.["security-severity"];
      if (severity !== undefined && (severity === null || severity === "" || !Number.isFinite(Number(severity))))
        throw new Error(`Invalid security severity for ${result.ruleId}.`);
      const highRisk = severity !== undefined ? Number(severity) >= 7 : result.level === "error";
      if (highRisk) {
        blocking++;
        console.error(`Blocking CodeQL finding: ${result.ruleId} (security severity ${severity ?? "error"})`);
      }
    }
  }
}
console.log(`Checked ${files.length} CodeQL report(s); ${blocking} high/critical finding(s).`);
if (blocking) process.exit(1);
