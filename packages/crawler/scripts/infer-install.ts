import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInstallInference } from "../src/installInference.js";

async function main(): Promise<void> {
  const report = await runInstallInference();

  console.log("");
  console.log(`attempted:              ${report.attempted}`);
  console.log(`resolved via npm:       ${report.resolvedNpm}`);
  console.log(`resolved via pypi:      ${report.resolvedPypi}`);
  console.log(`package.json, no bin:   ${report.packageJsonNoBin}`);
  console.log(`pyproject, no scripts:  ${report.pyprojectNoScripts}`);
  console.log(`not found (404/404):    ${report.notFound}`);
  console.log(`registry check failed:  ${report.registryCheckFailed}`);

  const outPath = path.join("data", "install-inference-report.json");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("");
  console.log(`wrote ${outPath}`);
}

main().catch((e: unknown) => {
  console.error("crawl:infer-install: failed —", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
