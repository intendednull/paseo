import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const MCP_CONFIG_FLAG = "--mcp-config";
const MCP_CONFIG_FLAG_EQUALS = `${MCP_CONFIG_FLAG}=`;
const DIR_PREFIX = "paseo-claude-mcp-";

export interface PrivateMcpConfigArgs {
  /** The launch args with every inline `--mcp-config` JSON replaced by a file path. */
  args: string[];
  /** The private directory holding the config files, or null when none was needed. */
  dir: string | null;
  /** Removes the directory. Idempotent; call once the process has exited. */
  cleanup: () => void;
}

const liveDirs = new Set<string>();
let exitHookInstalled = false;

function removeDir(dir: string): void {
  liveDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

// A daemon that exits with agents still running never sees their "exit" events.
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const dir of liveDirs) {
      try {
        removeDir(dir);
      } catch {
        // Best effort at shutdown.
      }
    }
  });
}

function isInlineJson(value: string): boolean {
  return value.trimStart().startsWith("{");
}

function defaultBaseDir(env: NodeJS.ProcessEnv): string[] {
  // $XDG_RUNTIME_DIR is per-user, mode 700 and memory-backed; tmpdir() is the fallback.
  const runtimeDir = env.XDG_RUNTIME_DIR;
  return runtimeDir && isAbsolute(runtimeDir) ? [runtimeDir, tmpdir()] : [tmpdir()];
}

function makePrivateDir(baseDirs: string[]): string {
  let lastError: unknown;
  for (const base of baseDirs) {
    try {
      // mkdtemp creates the directory with mode 700.
      return mkdtempSync(join(base, DIR_PREFIX));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Claude Code takes `--mcp-config` as inline JSON or as a file path. The Agent SDK
 * passes inline JSON, which puts every MCP server's headers and env (the daemon's
 * Agent MCP capability token among them) on the child's command line, where any
 * local user can read it through /proc/<pid>/cmdline. This writes each inline value
 * to a mode-600 file in a fresh mode-700 directory and passes the path instead, so
 * the arguments name a file and carry no secret. Values that are already paths are
 * left alone.
 */
export function moveInlineMcpConfigToFiles(
  args: readonly string[],
  options: { baseDirs?: string[]; env?: NodeJS.ProcessEnv } = {},
): PrivateMcpConfigArgs {
  let dir: string | null = null;
  let fileCount = 0;
  const writeConfig = (json: string): string => {
    if (dir === null) {
      dir = makePrivateDir(options.baseDirs ?? defaultBaseDir(options.env ?? process.env));
      liveDirs.add(dir);
      installExitHook();
    }
    const filePath = join(dir, `mcp-${fileCount++}.json`);
    writeFileSync(filePath, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return filePath;
  };

  const next: string[] = [];
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === MCP_CONFIG_FLAG && index + 1 < args.length && isInlineJson(args[index + 1])) {
        next.push(MCP_CONFIG_FLAG, writeConfig(args[index + 1]));
        index += 1;
        continue;
      }
      if (arg.startsWith(MCP_CONFIG_FLAG_EQUALS)) {
        const value = arg.slice(MCP_CONFIG_FLAG_EQUALS.length);
        if (isInlineJson(value)) {
          next.push(`${MCP_CONFIG_FLAG_EQUALS}${writeConfig(value)}`);
          continue;
        }
      }
      next.push(arg);
    }
  } catch (error) {
    if (dir !== null) removeDir(dir);
    throw error;
  }

  const createdDir: string | null = dir;
  let cleaned = false;
  return {
    args: next,
    dir: createdDir,
    cleanup: () => {
      if (cleaned || createdDir === null) return;
      cleaned = true;
      removeDir(createdDir);
    },
  };
}
