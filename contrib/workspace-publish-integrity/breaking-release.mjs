import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

function parseVersion(input) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(input);
  if (!match) throw new Error(`Expected a stable semantic version, received ${input}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compare(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function satisfiesRange(versionInput, rangeInput) {
  const version = parseVersion(versionInput);
  const range = rangeInput.trim();
  if (range === "*" || range === "latest") return true;
  const match = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) throw new Error(`Unsupported dependency range: ${range}`);
  const lower = { major: Number(match[2]), minor: Number(match[3]), patch: Number(match[4]) };
  if (compare(version, lower) < 0) return false;
  if (match[1] === "^") {
    const upper = lower.major > 0
      ? { major: lower.major + 1, minor: 0, patch: 0 }
      : lower.minor > 0
        ? { major: 0, minor: lower.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: lower.patch + 1 };
    return compare(version, upper) < 0;
  }
  if (match[1] === "~") {
    return compare(version, { major: lower.major, minor: lower.minor + 1, patch: 0 }) < 0;
  }
  return compare(version, lower) === 0;
}

export function bumpVersion(versionInput, release) {
  const version = parseVersion(versionInput);
  if (release === "major") return `${version.major + 1}.0.0`;
  if (release === "minor") return `${version.major}.${version.minor + 1}.0`;
  if (release === "patch") return `${version.major}.${version.minor}.${version.patch + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(release)) {
    if (compare(parseVersion(release), version) <= 0) {
      throw new Error(`Exact version ${release} must be greater than ${versionInput}`);
    }
    return release;
  }
  throw new Error(`Version bump must be patch, minor, major, or an exact version: ${release}`);
}

function dependencyDeclaration(manifest, dependencyName) {
  for (const section of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "devDependencies",
  ]) {
    if (typeof manifest[section]?.[dependencyName] === "string") {
      return { section, range: manifest[section][dependencyName] };
    }
  }
  return null;
}

export function planBreakingRelease({ rootManifest, workspaces, nextVersion }) {
  const current = parseVersion(rootManifest.version);
  const next = parseVersion(nextVersion);
  if (next.major <= current.major) {
    throw new Error(
      `Breaking release must increase the SDK major version (${rootManifest.version} -> ${nextVersion})`,
    );
  }

  const affected = workspaces.flatMap((workspace) => {
    const dependency = dependencyDeclaration(workspace.manifest, rootManifest.name);
    if (!dependency || satisfiesRange(nextVersion, dependency.range)) return [];
    return [{
      name: workspace.manifest.name,
      path: workspace.path,
      currentVersion: workspace.manifest.version,
      dependencySection: dependency.section,
      currentRange: dependency.range,
      nextRange: `^${nextVersion}`,
    }];
  });
  return {
    packageName: rootManifest.name,
    currentVersion: rootManifest.version,
    nextVersion,
    affected,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function loadWorkspace(rootDirectory) {
  const rootPath = path.join(rootDirectory, "package.json");
  const rootManifest = await readJson(rootPath);
  const workspaces = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    if (!pattern.endsWith("/*")) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const parent = path.join(rootDirectory, pattern.slice(0, -2));
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(parent, entry.name, "package.json");
      try {
        workspaces.push({ path: manifestPath, manifest: await readJson(manifestPath) });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return { rootPath, rootManifest, workspaces };
}

export async function applyBreakingReleasePlan({ loaded, plan, bumps }) {
  const missing = plan.affected.filter((entry) => !bumps[entry.name]);
  if (missing.length > 0) {
    throw new Error(`Missing version bump for: ${missing.map((entry) => entry.name).join(", ")}`);
  }

  loaded.rootManifest.version = plan.nextVersion;
  await writeFile(loaded.rootPath, `${JSON.stringify(loaded.rootManifest, null, 2)}\n`);
  for (const affected of plan.affected) {
    const workspace = loaded.workspaces.find((entry) => entry.manifest.name === affected.name);
    workspace.manifest.version = bumpVersion(workspace.manifest.version, bumps[affected.name]);
    workspace.manifest[affected.dependencySection][plan.packageName] = affected.nextRange;
    await writeFile(workspace.path, `${JSON.stringify(workspace.manifest, null, 2)}\n`);
  }
}

function parseBumps(args) {
  const bumps = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--bump") continue;
    const value = args[index + 1];
    const separator = value?.indexOf("=") ?? -1;
    if (separator < 1) throw new Error("--bump must use package=patch|minor|major|X.Y.Z");
    bumps[value.slice(0, separator)] = value.slice(separator + 1);
    index += 1;
  }
  return bumps;
}

async function promptForBumps(affected, supplied) {
  const bumps = { ...supplied };
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const entry of affected) {
      if (bumps[entry.name]) continue;
      const answer = await terminal.question(
        `Bump ${entry.name} from ${entry.currentVersion} by patch, minor, major, or exact version: `,
      );
      bumpVersion(entry.currentVersion, answer.trim());
      bumps[entry.name] = answer.trim();
    }
  } finally {
    terminal.close();
  }
  return bumps;
}

async function main() {
  const nextVersion = process.argv[2];
  if (!nextVersion) {
    throw new Error(
      "Usage: node breaking-release.mjs <next-sdk-version> [root] [--write] [--bump package=patch]",
    );
  }
  const positionalRoot = process.argv[3]?.startsWith("--") ? "." : (process.argv[3] ?? ".");
  const loaded = await loadWorkspace(path.resolve(positionalRoot));
  const plan = planBreakingRelease({ ...loaded, nextVersion });
  console.log(`${plan.packageName}: ${plan.currentVersion} -> ${plan.nextVersion}`);
  for (const entry of plan.affected) {
    console.log(
      `  ${entry.name}: ${entry.currentRange} excludes ${nextVersion}; set ${entry.nextRange} and bump ${entry.currentVersion}`,
    );
  }
  if (!process.argv.includes("--write")) {
    console.log("Dry run only. Pass --write to update manifests and prompt for dependent bumps.");
    return;
  }
  const bumps = await promptForBumps(plan.affected, parseBumps(process.argv.slice(3)));
  await applyBreakingReleasePlan({ loaded, plan, bumps });
  console.log("Manifests updated. Run npm install --package-lock-only and review the complete diff.");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
