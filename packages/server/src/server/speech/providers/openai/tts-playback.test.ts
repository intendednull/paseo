import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("prefetched speech survives garbage collection until its playback turn", () => {
  const fixture = fileURLToPath(new URL("./test-utils/prefetched-playback.ts", import.meta.url));
  const output = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", fixture], {
    encoding: "utf8",
    timeout: 15_000,
  });

  const result = JSON.parse(output) as {
    requests: string[];
    emitted: { bytes: number; value: number; format: string }[];
  };
  expect(result.requests.map((r) => r.split(" ")[0]).sort()).toEqual(["First", "Second", "Third"]);
  // Each response streams out as several chunks, in order, with every byte delivered.
  const values = result.emitted.map((e) => e.value);
  expect(values).toEqual([...values].sort());
  const totals = new Map<number, number>();
  for (const e of result.emitted) totals.set(e.value, (totals.get(e.value) ?? 0) + e.bytes);
  expect([...totals.entries()]).toEqual([
    [1, 192_000],
    [2, 192_000],
    [3, 192_000],
  ]);
  expect(result.emitted.every((e) => e.format === "pcm")).toBe(true);
});
