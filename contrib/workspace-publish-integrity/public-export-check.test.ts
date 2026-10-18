import { describe, expect, it } from "vitest";
import path from "node:path";
import { auditPublicImports, importedNames } from "./public-export-check.mjs";

const fixtureRoot = path.join(
  process.cwd(),
  "contrib/workspace-publish-integrity/fixtures/unexported-type",
);

describe("public export usage check", () => {
  it("extracts value, type-only, aliased, and re-exported symbols", () => {
    const source = [
      'import DefaultThing, { value, type PublicType, original as alias } from "vellar-sdk";',
      'export { type Forwarded } from "vellar-sdk";',
      'import * as sdk from "vellar-sdk";',
    ].join("\n");
    expect(importedNames(source, "consumer.ts", "vellar-sdk")).toEqual([
      { specifier: "vellar-sdk", name: "default" },
      { specifier: "vellar-sdk", name: "value" },
      { specifier: "vellar-sdk", name: "PublicType" },
      { specifier: "vellar-sdk", name: "original" },
      { specifier: "vellar-sdk", name: "Forwarded" },
    ]);
  });

  it("catches the fixture's deliberately unexported internal type", async () => {
    const violations = await auditPublicImports({
      rootDirectory: fixtureRoot,
      workspaceSourceDirectories: [path.join(fixtureRoot, "workspace/src")],
    });
    expect(violations).toEqual([
      expect.objectContaining({
        specifier: "vellar-sdk",
        name: "InternalOnly",
        reason: "symbol is not exported by the public entry point",
      }),
    ]);
  });

  it("accepts the current CLI and MCP payer public imports", async () => {
    const violations = await auditPublicImports({
      rootDirectory: process.cwd(),
      workspaceSourceDirectories: [
        path.join(process.cwd(), "packages/cli/src"),
        path.join(process.cwd(), "packages/mcp-x402-payer/src"),
      ],
    });
    expect(violations).toEqual([]);
  }, 30_000);
});
