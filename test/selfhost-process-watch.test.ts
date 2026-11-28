import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { expect, it } from "vitest";

const monitor = new URL("../scripts/host-watchdog.mjs", import.meta.url).href;

async function freePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
  if (typeof address !== "object" || !address) throw new Error("missing test port");
  return address.port;
}

it.each(["stopped", "blackholed", "responding", "slow-readiness"])("supervises a %s runtime from outside the application", async (mode) => {
  const port = await freePort();
  const app = `
    const http = require("node:http");
    let answered = false;
    const server = http.createServer((req, res) => {
      if (answered && ${JSON.stringify(mode)} === "blackholed") return;
      if (answered && ${JSON.stringify(mode)} === "slow-readiness" && req.url === "/health") return;
      res.writeHead(503).end();
      if (answered) return;
      answered = true;
      if (${JSON.stringify(mode)} === "stopped") setTimeout(() => process.kill(process.pid, "SIGSTOP"), 20);
      if (["responding", "slow-readiness"].includes(${JSON.stringify(mode)})) {
        setTimeout(() => { server.closeAllConnections(); server.close(); }, 450);
      }
    }).listen(${port}, "127.0.0.1");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { supervise } from ${JSON.stringify(monitor)};
    supervise([process.execPath, "-e", ${JSON.stringify(app)}], {
      port: ${port}, intervalMs: 50, timeoutMs: 50, stallMs: 150,
    });
  `], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr.setEncoding("utf8").on("data", (line: string) => { log += line; });
  try {
    const result = await Promise.race([
      once(child, "close"),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000).unref()),
    ]);
    const expected = mode === "responding" || mode === "slow-readiness" ? 0 : 1;
    expect(result, log).toEqual([expected, null]);
    expect(log.includes("host_health_stalled")).toBe(expected === 1);
  } finally {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
    }
  }
});
