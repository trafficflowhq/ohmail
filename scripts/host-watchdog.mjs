import { spawn } from "node:child_process";
import { write } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Observe liveness from outside the application once its listener has started.
 */
export function supervise([command, ...args], {
  port = Number(process.env.PORT || 8080),
  intervalMs = 10_000,
  timeoutMs = 5_000,
  stallMs = 60_000,
} = {}) {
  if (!command) throw new Error("the application command is required");
  const child = spawn(command, args, { stdio: "inherit" });
  let stopped = false;
  let stalled = false;
  let timer;
  let lastAnswer = null;

  const forward = (signal) => {
    stopped = true;
    clearTimeout(timer);
    child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.once("error", () => { process.exit(1); });
  child.once("exit", (code) => {
    if (!stalled) process.exit(code ?? 1);
    const exit = () => process.exit(1);
    // The application is already gone. A full log pipe cannot delay container exit.
    setTimeout(exit, 25);
    write(2, '{"level":"error","event":"host_health_stalled"}\n', exit);
  });

  const probe = async () => {
    if (stopped) return;
    try {
      await fetch(`http://127.0.0.1:${port}/live`, {
        method: "HEAD",
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastAnswer = performance.now();
    } catch {
      if (!stopped && lastAnswer !== null && performance.now() - lastAnswer >= stallMs) {
        stopped = true;
        stalled = true;
        child.kill("SIGKILL");
        return;
      }
    }
    if (!stopped) timer = setTimeout(probe, intervalMs);
  };
  void probe();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  supervise(process.argv.slice(2));
}
