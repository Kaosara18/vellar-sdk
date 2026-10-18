import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RESOLUTION_ERROR = /(ERR_MODULE_NOT_FOUND|Cannot find (?:module|package))/i;

function binEntries(manifest) {
  if (typeof manifest.bin === "string") return [[manifest.name, manifest.bin]];
  return Object.entries(manifest.bin ?? {});
}

export function smokePlan(manifest) {
  if (manifest.name === "vellar-cli") {
    const binary = binEntries(manifest).find(([name]) => name === "vellar")?.[1];
    if (!binary) throw new Error("vellar-cli does not declare its vellar binary");
    return { binary, args: ["--help"], expectedExitCode: 0, stderrPattern: null, clear: [] };
  }
  if (manifest.name === "vellar-mcp-x402-payer") {
    const binary = binEntries(manifest).find(([name]) => name === manifest.name)?.[1];
    if (!binary) throw new Error(`${manifest.name} does not declare its startup binary`);
    return {
      binary,
      args: [],
      expectedExitCode: 1,
      stderrPattern: /failed to start/i,
      clear: [
        "VELLAR_X402_SECRET",
        "VELLAR_X402_SECRET_FILE",
        "VELLAR_X402_WALLET",
        "VELLAR_X402_RPC_URL",
      ],
    };
  }
  throw new Error(`No standalone smoke behavior is defined for ${manifest.name}`);
}

export function validatePackedArtifact(manifest, files) {
  const shipped = new Set(files.map((file) => file.path.replace(/^package\//, "")));
  const required = [manifest.main, manifest.module, manifest.types, ...binEntries(manifest).map(([, file]) => file)]
    .filter((file) => typeof file === "string")
    .map((file) => file.replace(/^\.\//, ""));
  const missing = required.filter((file) => !shipped.has(file));
  return { valid: missing.length === 0, missing };
}

export function evaluateProcess(result, expectation = { expectedExitCode: 0, stderrPattern: null }) {
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (RESOLUTION_ERROR.test(combined)) {
    return { valid: false, reason: "undeclared or unresolved runtime dependency" };
  }
  if (result.status !== expectation.expectedExitCode) {
    return {
      valid: false,
      reason: `exit code ${result.status ?? "missing"}; expected ${expectation.expectedExitCode}`,
    };
  }
  if (expectation.stderrPattern && !expectation.stderrPattern.test(result.stderr ?? "")) {
    return { valid: false, reason: "MCP startup did not reach its configuration guard" };
  }
  return { valid: true, reason: "process matched expected standalone behavior" };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    ...options,
  });
}

function runNpm(args, options = {}) {
  const installedNpmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const npmCli = process.env.npm_execpath ?? (existsSync(installedNpmCli) ? installedNpmCli : null);
  return npmCli
    ? run(process.execPath, [npmCli, ...args], options)
    : run("npm", args, options);
}

function pack(packageDirectory, destination) {
  const result = runNpm(["pack", packageDirectory, "--json", "--pack-destination", destination]);
  if (result.status !== 0) throw new Error(`npm pack failed for ${packageDirectory}: ${result.stderr}`);
  const records = JSON.parse(result.stdout);
  if (!records[0]?.filename || !Array.isArray(records[0].files)) {
    throw new Error(`npm pack returned incomplete metadata for ${packageDirectory}`);
  }
  return records[0];
}

export async function runStandaloneInstall({ rootDirectory, packageDirectory }) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "vellar-isolated-install-"));
  const packs = path.join(scratch, "packs");
  const consumer = path.join(scratch, "consumer");
  await mkdir(packs);
  await mkdir(consumer);
  try {
    const rootManifest = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
    const targetManifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
    const rootPack = pack(rootDirectory, packs);
    const targetPack = pack(packageDirectory, packs);
    const artifact = validatePackedArtifact(targetManifest, targetPack.files);
    if (!artifact.valid) throw new Error(`Packed artifact is missing: ${artifact.missing.join(", ")}`);

    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({ name: "vellar-isolated-consumer", private: true, type: "module" }, null, 2),
    );
    const install = runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(packs, rootPack.filename),
      path.join(packs, targetPack.filename),
    ], { cwd: consumer });
    const installResult = evaluateProcess(install);
    if (!installResult.valid) throw new Error(`Isolated install failed: ${installResult.reason}`);

    const plan = smokePlan(targetManifest);
    const environment = { ...process.env };
    for (const name of plan.clear) delete environment[name];
    const smoke = run(
      process.execPath,
      [path.join(consumer, "node_modules", targetManifest.name, plan.binary), ...plan.args],
      { cwd: consumer, env: environment },
    );
    const smokeResult = evaluateProcess(smoke, plan);
    if (!smokeResult.valid) throw new Error(`Standalone smoke failed: ${smokeResult.reason}`);
    return { packageName: targetManifest.name, installResult, smokeResult };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  if (!process.argv[2]) {
    throw new Error("Usage: node standalone-install.mjs <package-directory> [root-directory]");
  }
  const rootDirectory = path.resolve(process.argv[3] ?? ".");
  const result = await runStandaloneInstall({
    rootDirectory,
    packageDirectory: path.resolve(process.argv[2]),
  });
  console.log(`[OK] ${result.packageName} installed and passed its standalone smoke check`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
