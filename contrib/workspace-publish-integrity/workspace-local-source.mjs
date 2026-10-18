import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

async function declarationFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await declarationFiles(fullPath));
    else if (entry.isFile() && /\.d\.[cm]?ts$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function normalized(filePath) {
  return path.normalize(filePath).toLowerCase();
}

export async function assertWorkspaceLink(rootDirectory, packageName) {
  const root = await realpath(rootDirectory);
  const installed = await realpath(path.join(rootDirectory, "node_modules", packageName));
  if (normalized(root) !== normalized(installed)) {
    throw new Error(
      `${packageName} resolves to ${installed}, not workspace root ${root}; registry metadata is in use`,
    );
  }
  return installed;
}

export function assertMarkerInText(markerName, outputs) {
  const missing = outputs.filter((output) => !output.text.includes(markerName));
  if (missing.length > 0) {
    throw new Error(`Marker ${markerName} is absent from: ${missing.map((item) => item.path).join(", ")}`);
  }
  return true;
}

function runBuild(rootDirectory, args) {
  const installedNpmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const npmCli = process.env.npm_execpath ?? (existsSync(installedNpmCli) ? installedNpmCli : null);
  const command = npmCli ? process.execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: rootDirectory,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    throw new Error(`Build failed: npm ${args.join(" ")}\n${detail}`);
  }
}

export async function runWorkspaceSourceRehearsal({ rootDirectory, workspaceDirectories }) {
  const rootManifest = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
  await assertWorkspaceLink(rootDirectory, rootManifest.name);
  const markerName = `__VellarWorkspaceMarker_${randomBytes(8).toString("hex")}`;
  const files = [
    path.join(rootDirectory, "src", "index.ts"),
    ...workspaceDirectories.map((directory) => path.join(directory, "src", "index.ts")),
  ];
  const originals = new Map();
  for (const filePath of files) originals.set(filePath, await readFile(filePath, "utf8"));

  try {
    await writeFile(
      files[0],
      `${originals.get(files[0])}\nexport type ${markerName} = "workspace-local";\n`,
    );
    for (const filePath of files.slice(1)) {
      await writeFile(
        filePath,
        `${originals.get(filePath)}\nexport type { ${markerName} } from "${rootManifest.name}";\n`,
      );
    }

    runBuild(rootDirectory, ["run", "build"]);
    const outputGroups = [];
    for (const workspaceDirectory of workspaceDirectories) {
      const manifest = JSON.parse(await readFile(path.join(workspaceDirectory, "package.json"), "utf8"));
      runBuild(rootDirectory, ["run", "build", "--workspace", manifest.name]);
      const outputs = await declarationFiles(path.join(workspaceDirectory, "dist"));
      outputGroups.push({
        packageName: manifest.name,
        outputs: await Promise.all(outputs.map(async (filePath) => ({
          path: filePath,
          text: await readFile(filePath, "utf8"),
        }))),
      });
    }

    for (const group of outputGroups) {
      if (group.outputs.length === 0) throw new Error(`${group.packageName} produced no declarations`);
      if (!group.outputs.some((output) => output.text.includes(markerName))) {
        throw new Error(`${group.packageName} build output does not contain ${markerName}`);
      }
    }
    return { markerName, packages: outputGroups.map((group) => group.packageName) };
  } finally {
    await Promise.all([...originals].map(([filePath, contents]) => writeFile(filePath, contents)));
  }
}

async function main() {
  const rootDirectory = path.resolve(process.argv[2] ?? ".");
  const workspaceDirectories = (process.argv.slice(3).length > 0
    ? process.argv.slice(3)
    : ["packages/cli", "packages/mcp-x402-payer"])
    .map((directory) => path.resolve(rootDirectory, directory));
  const result = await runWorkspaceSourceRehearsal({ rootDirectory, workspaceDirectories });
  console.log(`[OK] ${result.markerName} reached: ${result.packages.join(", ")}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
