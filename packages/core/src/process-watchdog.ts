import { Worker } from "node:worker_threads";

/**
 * Recover if synchronous work prevents the main thread from ever running its own watchdog.
 * The container's init owns PID 1 so the watchdog can terminate the application process.
 */
export function startProcessWatchdog(stallMs = 120_000): () => void {
  const pulse = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const intervalMs = Math.max(1, Math.floor(stallMs / 4));
  const timer = setInterval(() => { Atomics.add(pulse, 0, 1); }, intervalMs);
  timer.unref();

  // The watchdog runs no application code and receives no credentials.
  const watchdog = new Worker(`
    const { write } = require("node:fs");
    const { workerData } = require("node:worker_threads");
    const { pulse, intervalMs, stallMs } = workerData;
    let last = Atomics.load(pulse, 0);
    let advancedAt = performance.now();
    const check = setInterval(() => {
      const current = Atomics.load(pulse, 0);
      const now = performance.now();
      if (current !== last) {
        last = current;
        advancedAt = now;
      } else if (now - advancedAt >= stallMs) {
        clearInterval(check);
        const kill = () => process.kill(process.pid, "SIGKILL");
        setTimeout(kill, 25);
        write(2, '{"level":"error","event":"event_loop_stalled_exiting"}\\n', kill);
      }
    }, intervalMs);
  `, { eval: true, env: {}, execArgv: [], workerData: { pulse, intervalMs, stallMs } });
  watchdog.unref();

  return () => {
    clearInterval(timer);
    void watchdog.terminate();
  };
}
