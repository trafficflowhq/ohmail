import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const watchdog = new URL("../src/process-watchdog.ts", import.meta.url).href;

it("exits the process when its event loop can no longer answer", async () => {
  await expect(run(process.execPath, ["--input-type=module", "-e", `
    import { startProcessWatchdog } from ${JSON.stringify(watchdog)};
    startProcessWatchdog(200);
    setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0), 50);
  `], { timeout: 4_000 })).rejects.toMatchObject({
    signal: "SIGKILL",
    stderr: expect.stringContaining("event_loop_stalled_exiting"),
  });
});

it("terminates even when stderr is blocked", async () => {
  // A pipe with a live reader that never consumes is different from a closed descriptor.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeSync } from "node:fs";
    import { startProcessWatchdog } from ${JSON.stringify(watchdog)};
    startProcessWatchdog(200);
    const bytes = Buffer.alloc(1024 * 1024);
    try {
      for (;;) writeSync(2, bytes);
    } catch {
      // A nonblocking descriptor signals the same full-pipe condition by throwing.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  `], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const result = await Promise.race([
      once(child, "exit"),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1600).unref()),
    ]);
    expect(result).toEqual([null, "SIGKILL"]);
  } finally {
    child.kill("SIGKILL");
  }
});
