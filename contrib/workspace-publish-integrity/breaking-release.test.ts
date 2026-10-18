import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBreakingReleasePlan,
  bumpVersion,
  loadWorkspace,
  planBreakingRelease,
  satisfiesRange,
} from "./breaking-release.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("breaking workspace release helper", () => {
  it("models zero-major caret ranges correctly", () => {
    expect(satisfiesRange("0.6.2", "^0.6.1")).toBe(true);
    expect(satisfiesRange("1.0.0", "^0.6.2")).toBe(false);
    expect(bumpVersion("0.1.5", "minor")).toBe("0.2.0");
    expect(() => bumpVersion("0.1.5", "0.1.5")).toThrow("must be greater");
  });

  it("identifies every dependent excluded by a breaking SDK version", async () => {
    const loaded = await loadWorkspace(
      path.join(process.cwd(), "contrib/workspace-publish-integrity/fixtures/breaking-release"),
    );
    const plan = planBreakingRelease({ ...loaded, nextVersion: "1.0.0" });
    expect(plan.affected.map((entry) => entry.name).sort()).toEqual([
      "vellar-cli",
      "vellar-mcp-x402-payer",
    ]);
    expect(plan.affected.every((entry) => entry.nextRange === "^1.0.0")).toBe(true);
  });

  it("updates SDK and dependent versions and ranges in a fixture workspace", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "vellar-release-fixture-"));
    temporaryDirectories.push(temporary);
    await cp(
      path.join(process.cwd(), "contrib/workspace-publish-integrity/fixtures/breaking-release"),
      temporary,
      { recursive: true },
    );
    const loaded = await loadWorkspace(temporary);
    const plan = planBreakingRelease({ ...loaded, nextVersion: "1.0.0" });
    await applyBreakingReleasePlan({
      loaded,
      plan,
      bumps: { "vellar-cli": "minor", "vellar-mcp-x402-payer": "patch" },
    });

    const root = JSON.parse(await readFile(path.join(temporary, "package.json"), "utf8"));
    const cli = JSON.parse(await readFile(path.join(temporary, "packages/cli/package.json"), "utf8"));
    const payer = JSON.parse(
      await readFile(path.join(temporary, "packages/mcp-x402-payer/package.json"), "utf8"),
    );
    expect(root.version).toBe("1.0.0");
    expect(cli).toMatchObject({ version: "0.2.0", dependencies: { "vellar-sdk": "^1.0.0" } });
    expect(payer).toMatchObject({ version: "0.1.6", dependencies: { "vellar-sdk": "^1.0.0" } });
  });

  it("requires an explicit bump choice for every affected package", async () => {
    const loaded = await loadWorkspace(
      path.join(process.cwd(), "contrib/workspace-publish-integrity/fixtures/breaking-release"),
    );
    const plan = planBreakingRelease({ ...loaded, nextVersion: "1.0.0" });
    await expect(applyBreakingReleasePlan({ loaded, plan, bumps: {} })).rejects.toThrow(
      "Missing version bump",
    );
  });

  it("rejects a non-breaking SDK version", async () => {
    const loaded = await loadWorkspace(
      path.join(process.cwd(), "contrib/workspace-publish-integrity/fixtures/breaking-release"),
    );
    expect(() => planBreakingRelease({ ...loaded, nextVersion: "0.7.0" })).toThrow(
      "must increase the SDK major version",
    );
  });
});
