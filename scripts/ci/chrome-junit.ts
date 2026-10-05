#!/usr/bin/env node
/** Jenkins report adapter for the existing built-extension Chromium harness. */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Suite = "discovery" | "acquisition";

export function junitForChrome(suite: Suite, output: string, exitCode: number): { xml: string; cases: number } {
  const names = [...new Set([...output.matchAll(/^\[chrome-(?:discovery|acquisition)\] ([a-z0-9-]+)\b/gm)]
    .map((match) => match[1]))];
  const failed = exitCode !== 0 || names.length === 0;
  const cases = names.map((name) => `<testcase name="${name}"/>`).join("");
  const failure = failed
    ? `<testcase name="${suite}-harness"><failure message="browser harness failed or emitted no cases"/></testcase>`
    : "";
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="chrome-${suite}" tests="${names.length + Number(failed)}" failures="${Number(failed)}">${cases}${failure}</testsuite></testsuites>\n`,
    cases: names.length,
  };
}

async function main(): Promise<void> {
  const suite = process.argv[2];
  if (suite !== "discovery" && suite !== "acquisition") throw new Error("usage: chrome-junit.ts discovery|acquisition");
  const args = suite === "acquisition" ? ["--acquisition"] : [];
  const child = spawn("scripts/run-chrome-discovery.sh", args, { stdio: ["ignore", "pipe", "pipe"] });
  let spawnFailed = false;
  child.once("error", () => { spawnFailed = true; });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    (stream === child.stdout ? process.stdout : process.stderr).write(text);
    output = `${output}${text}`.slice(-256_000);
  });
  const code = await new Promise<number>((done) => child.once("close", (status) => done(status ?? 1)));
  const report = junitForChrome(suite, output, spawnFailed ? 1 : code);
  await mkdir(resolve("reports/junit"), { recursive: true });
  await writeFile(resolve(`reports/junit/chrome-${suite}.xml`), report.xml);
  if (code !== 0 || spawnFailed || report.cases === 0) process.exitCode = code || 1;
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : "browser_report_failed");
    process.exitCode = 1;
  });
}
