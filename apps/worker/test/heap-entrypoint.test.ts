import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * THE ORGANIZER IMAGE SIZES ITS HEAP FROM THE CONTAINER IT RUNS IN: half the memory the container may
 * use (cgroup v2's memory.max, else cgroup v1's limit, else MemTotal, whichever binds), kept between
 * 512 and 2048 MiB, and a heap flag the person set is theirs. Run as the image runs it, `sh` over the
 * script, against files laid out as each machine has them. Linux only, as the image is.
 */
const SCRIPT = fileURLToPath(new URL("../entrypoint.sh", import.meta.url));
const GiB = 1024 ** 3;
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A machine: its cgroup files, if any, and its MemTotal. */
function machine(o: { v2?: string; v1?: string; memTotalKb?: number }): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "ohmail-heap-"));
  roots.push(root);
  if (o.v2 !== undefined) writeFileSync(join(root, "memory.max"), `${o.v2}\n`);
  if (o.v1 !== undefined) {
    mkdirSync(join(root, "memory"));
    writeFileSync(join(root, "memory", "memory.limit_in_bytes"), `${o.v1}\n`);
  }
  const meminfo = join(root, "meminfo");
  if (o.memTotalKb !== undefined) writeFileSync(meminfo, `MemTotal:       ${o.memTotalKb} kB\nMemFree:          4096 kB\n`);
  return { OHMAIL_CGROUP_ROOT: root, OHMAIL_MEMINFO: meminfo };
}

interface Line { heapMb: number | null; source: string; memoryBytes?: number; event: string; service: string }

/** The one line the entrypoint writes, with `--print`. */
function sized(env: Record<string, string>): Line {
  const p = spawnSync("sh", [SCRIPT, "--print"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  expect(p.status, p.stderr).toBe(0);
  const lines = p.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Line;
}

/** What the command the entrypoint runs is handed: its NODE_OPTIONS and the heap it got. */
function started(env: Record<string, string>, nodeArgs: string[] = []): { line: Line; options: string | null; limitMb: number } {
  const probe = "process.stdout.write(JSON.stringify({ options: process.env.NODE_OPTIONS ?? null, "
    + "limitMb: require('node:v8').getHeapStatistics().heap_size_limit / 1048576 }))";
  const p = spawnSync("sh", [SCRIPT, process.execPath, ...nodeArgs, "-e", probe], {
    env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8",
  });
  expect(p.status, p.stderr).toBe(0);
  const [line, out] = p.stdout.split("\n");
  return { line: JSON.parse(line!) as Line, ...JSON.parse(out!) as { options: string | null; limitMb: number } };
}

describe.skipIf(process.platform === "win32")("the organizer's entrypoint sizes the heap from the container", () => {
  it("half a cgroup v2 limit, and the command runs with that heap", () => {
    const run = started(machine({ v2: String(2 * GiB), memTotalKb: 16 * 1024 * 1024 }));
    expect(run.line).toMatchObject({ event: "worker_heap_sized", service: "worker", heapMb: 1024, source: "cgroup-v2", memoryBytes: 2 * GiB });
    expect(run.options).toBe("--max-old-space-size=1024");
    expect(run.limitMb).toBeGreaterThanOrEqual(1024);
    expect(run.limitMb).toBeLessThan(1024 + 128);
  });

  it("an unlimited cgroup v2 falls back to MemTotal, and a large machine stops at the ceiling", () => {
    expect(sized(machine({ v2: "max", memTotalKb: 16 * 1024 * 1024 }))).toMatchObject({ heapMb: 2048, source: "meminfo" });
  });

  it("half a cgroup v1 limit", () => {
    expect(sized(machine({ v1: String(1.5 * GiB), memTotalKb: 16 * 1024 * 1024 })))
      .toMatchObject({ heapMb: 768, source: "cgroup-v1", memoryBytes: 1.5 * GiB });
  });

  it("cgroup v1's unlimited falls back to MemTotal", () => {
    expect(sized(machine({ v1: "9223372036854771712", memTotalKb: 3 * 1024 * 1024 })))
      .toMatchObject({ heapMb: 1536, source: "meminfo", memoryBytes: 3 * GiB });
  });

  it("a limit above the machine's memory is not what binds", () => {
    expect(sized(machine({ v2: String(8 * GiB), memTotalKb: 2 * 1024 * 1024 }))).toMatchObject({ heapMb: 1024, source: "meminfo" });
  });

  it("a 1 GB box keeps the 512 MiB floor, and so does a box whose memory cannot be read", () => {
    expect(sized(machine({ memTotalKb: 1_000_000 }))).toMatchObject({ heapMb: 512, source: "meminfo" });
    const none = sized(machine({}));
    expect(none).toMatchObject({ heapMb: 512, source: "none" });
    expect(none.memoryBytes).toBeUndefined();
  });

  it("a limit file it cannot read as a byte count is no limit, and the container still starts", () => {
    for (const v2 of ["08", "12.5G", ""]) {
      expect(sized(machine({ v2, memTotalKb: 1_000_000 })), JSON.stringify(v2)).toMatchObject({ heapMb: 512, source: "meminfo" });
    }
  });

  it("a heap flag in NODE_OPTIONS is the person's own: kept as it is, and named", () => {
    const run = started({ ...machine({ v2: String(2 * GiB) }), NODE_OPTIONS: "--max-old-space-size=600" });
    expect(run.line).toMatchObject({ heapMb: 600, source: "NODE_OPTIONS" });
    expect(run.options).toBe("--max-old-space-size=600");
    expect(run.limitMb).toBeLessThan(1024);
  });

  it("a heap flag on the command is the person's own too, and NODE_OPTIONS is left alone", () => {
    const run = started(machine({ v2: String(2 * GiB) }), ["--max-old-space-size=700"]);
    expect(run.line).toMatchObject({ heapMb: 700, source: "command" });
    expect(run.options).toBeNull();
    expect(run.limitMb).toBeLessThan(1024);
  });

  it("other NODE_OPTIONS are kept beside the flag, and the line repeats none of them", () => {
    const env = { ...machine({ v2: String(2 * GiB) }), NODE_OPTIONS: "--enable-source-maps --title=heap-probe-private" };
    const run = started(env);
    expect(run.options).toBe("--enable-source-maps --title=heap-probe-private --max-old-space-size=1024");
    const p = spawnSync("sh", [SCRIPT, "--print"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
    expect(p.stdout).not.toContain("heap-probe-private");
    expect(Object.keys(JSON.parse(p.stdout) as object).sort()).toEqual(
      ["event", "heapMb", "level", "memoryBytes", "reason", "service", "source", "ts"],
    );
  });
});
