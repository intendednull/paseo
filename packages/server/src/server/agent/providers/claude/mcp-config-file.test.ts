import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { moveInlineMcpConfigToFiles } from "./mcp-config-file.js";

const SECRET = "Bearer 0123456789abcdef-test-capability";
const INLINE = JSON.stringify({
  mcpServers: {
    paseo: {
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=a1",
      headers: { Authorization: SECRET },
    },
  },
});

describe("moveInlineMcpConfigToFiles", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "paseo-mcp-config-file-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("moves inline JSON into a private file and keeps it off the arguments", () => {
    const result = moveInlineMcpConfigToFiles(
      ["--print", "--mcp-config", INLINE, "--setting-sources", "user"],
      { baseDirs: [baseDir] },
    );

    expect(result.args.join(" ")).not.toContain(SECRET);
    expect(result.args[0]).toBe("--print");
    expect(result.args[1]).toBe("--mcp-config");
    expect(result.args.slice(3)).toEqual(["--setting-sources", "user"]);
    const filePath = result.args[2];
    expect(dirname(filePath)).toBe(result.dir);
    expect(dirname(filePath).startsWith(baseDir)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(INLINE);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(filePath)).mode & 0o777).toBe(0o700);

    result.cleanup();
    expect(existsSync(dirname(filePath))).toBe(false);
    result.cleanup();
  });

  test("handles the --mcp-config=<json> form", () => {
    const result = moveInlineMcpConfigToFiles([`--mcp-config=${INLINE}`], {
      baseDirs: [baseDir],
    });

    expect(result.args).toHaveLength(1);
    expect(result.args[0]).not.toContain(SECRET);
    const filePath = result.args[0].slice("--mcp-config=".length);
    expect(readFileSync(filePath, "utf8")).toBe(INLINE);
    result.cleanup();
    expect(existsSync(filePath)).toBe(false);
  });

  test("writes each inline config to its own file", () => {
    const other = JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } } });
    const result = moveInlineMcpConfigToFiles(["--mcp-config", INLINE, "--mcp-config", other], {
      baseDirs: [baseDir],
    });

    expect(readFileSync(result.args[1], "utf8")).toBe(INLINE);
    expect(readFileSync(result.args[3], "utf8")).toBe(other);
    expect(result.args[1]).not.toBe(result.args[3]);
    result.cleanup();
  });

  test("leaves config paths and other arguments alone without creating a directory", () => {
    const args = ["--mcp-config", "/etc/claude/mcp.json", "--settings", '{"fastMode":true}'];
    const result = moveInlineMcpConfigToFiles(args, { baseDirs: [baseDir] });

    expect(result.args).toEqual(args);
    expect(result.dir).toBeNull();
    result.cleanup();
  });

  test("falls back to the next base directory when the first is unusable", () => {
    const result = moveInlineMcpConfigToFiles(["--mcp-config", INLINE], {
      baseDirs: [join(baseDir, "missing"), baseDir],
    });

    expect(dirname(result.args[1]).startsWith(baseDir)).toBe(true);
    expect(readFileSync(result.args[1], "utf8")).toBe(INLINE);
    result.cleanup();
  });
});
