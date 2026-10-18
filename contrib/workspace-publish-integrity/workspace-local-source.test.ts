import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertMarkerInText, assertWorkspaceLink } from "./workspace-local-source.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("workspace-local SDK source rehearsal", () => {
  it("accepts a node_modules package linked to the workspace root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vellar-link-fixture-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "package.json"), '{"name":"vellar-sdk"}');
    await mkdir(path.join(root, "node_modules"));
    await symlink(root, path.join(root, "node_modules", "vellar-sdk"), "junction");
    await expect(assertWorkspaceLink(root, "vellar-sdk")).resolves.toBeTruthy();
  });

  it("rejects a package resolved from a different registry-style directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vellar-link-fixture-"));
    temporaryDirectories.push(root);
    const registryCopy = path.join(root, "registry-copy");
    await mkdir(path.join(root, "node_modules"));
    await mkdir(registryCopy);
    await symlink(registryCopy, path.join(root, "node_modules", "vellar-sdk"), "junction");
    await expect(assertWorkspaceLink(root, "vellar-sdk")).rejects.toThrow("registry metadata");
  });

  it("accepts declaration outputs containing the unique marker", () => {
    expect(assertMarkerInText("__marker_123", [
      { path: "cli/dist/index.d.ts", text: "export type { __marker_123 } from 'vellar-sdk';" },
      { path: "payer/dist/index.d.ts", text: "export type { __marker_123 } from 'vellar-sdk';" },
    ])).toBe(true);
  });

  it("fails when any expected output lacks the marker", () => {
    expect(() => assertMarkerInText("__marker_123", [
      { path: "cli/dist/index.d.ts", text: "export {};" },
    ])).toThrow("Marker __marker_123 is absent");
  });
});
