import { describe, expect, it } from "vitest";
import {
  evaluateProcess,
  smokePlan,
  validatePackedArtifact,
} from "./standalone-install.mjs";

describe("standalone workspace package installation", () => {
  it("runs CLI help as the CLI smoke command", () => {
    expect(smokePlan({ name: "vellar-cli", bin: { vellar: "dist/bin.js" } })).toMatchObject({
      binary: "dist/bin.js",
      args: ["--help"],
      expectedExitCode: 0,
    });
  });

  it("uses the missing-configuration path as the MCP startup check", () => {
    const plan = smokePlan({
      name: "vellar-mcp-x402-payer",
      bin: { "vellar-mcp-x402-payer": "dist/bin.js" },
    });
    expect(plan).toMatchObject({ binary: "dist/bin.js", expectedExitCode: 1 });
    expect(evaluateProcess(
      { status: 1, stdout: "", stderr: "vellar-mcp-x402-payer failed to start: missing secret" },
      plan,
    ).valid).toBe(true);
  });

  it("fails when npm pack omits a declared runtime entry", () => {
    expect(validatePackedArtifact(
      { main: "./dist/index.js", bin: { vellar: "dist/bin.js" } },
      [{ path: "dist/index.js" }],
    )).toEqual({ valid: false, missing: ["dist/bin.js"] });
  });

  it("classifies missing dependencies as standalone failures", () => {
    expect(evaluateProcess({
      status: 1,
      stdout: "",
      stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'hoisted-only'",
    })).toEqual({ valid: false, reason: "undeclared or unresolved runtime dependency" });
  });

  it("rejects an unexpected smoke exit code", () => {
    expect(evaluateProcess(
      { status: 2, stdout: "", stderr: "unexpected" },
      { expectedExitCode: 0, stderrPattern: null },
    )).toEqual({ valid: false, reason: "exit code 2; expected 0" });
  });

  it("refuses to skip an unknown workspace package", () => {
    expect(() => smokePlan({ name: "unknown" })).toThrow("No standalone smoke behavior");
  });
});
