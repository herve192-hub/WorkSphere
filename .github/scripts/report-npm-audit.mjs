import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Pass the npm audit JSON report path.");
let report;
try {
  report = JSON.parse(readFileSync(file, "utf8"));
} catch {
  console.error("npm audit report is missing or invalid JSON. Check the npm error above and the uploaded report.");
  process.exit(1);
}
if (!report || typeof report !== "object" || Array.isArray(report)) {
  console.error("npm audit did not return a report object.");
  process.exit(1);
}

if (report.error) {
  console.error("npm audit failed before returning vulnerability findings. Check the npm error above and the uploaded report.");
  process.exitCode = 1;
} else {
  const counts = report.metadata?.vulnerabilities;
  const severities = ["critical", "high", "moderate", "low", "info"];
  if (!counts || severities.some((severity) => !Number.isInteger(counts[severity]) || counts[severity] < 0)) {
    throw new Error("npm audit did not return valid vulnerability counts.");
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)) {
    throw new Error("npm audit did not return vulnerability details.");
  }

  console.log(`npm audit: ${severities.map((severity) => `${counts[severity]} ${severity}`).join(", ")}.`);
  const blocking = Object.entries(report.vulnerabilities)
    .filter(([, finding]) => ["high", "critical"].includes(finding.severity))
    .sort(([a, x], [b, y]) => Number(y.severity === "critical") - Number(x.severity === "critical") || a.localeCompare(b));
  for (const [name, finding] of blocking) {
    console.log(`${finding.severity.toUpperCase()}: ${name} (${finding.range})`);
    for (const advisory of finding.via || []) {
      if (typeof advisory === "object" && ["high", "critical"].includes(advisory.severity)) {
        console.log(`  ${advisory.title}: ${advisory.url}`);
      }
    }
  }
  if (blocking.length) {
    console.log("High/critical findings block CI. Review the full artifact for dependency paths and remediation details.");
  } else {
    console.log("No high/critical findings.");
  }
}
