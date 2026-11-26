import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { monitorHost } from "./sampling.mjs";

const [runtimeArg, outputArg, sizeArg, quiet, mode = "polling"] = process.argv.slice(2);
const size = Number(sizeArg);
if (
  !runtimeArg ||
  !outputArg ||
  !quiet ||
  ![10000, 200000, 400000, 1000000].includes(size) ||
  !["polling", "held", "held-poll-only", "roster-witness"].includes(mode)
) {
  throw new Error("Pass runtime, review root, fixture tier, quiet file and event mode.");
}
const runtime = resolve(runtimeArg);
const output = resolve(outputArg);
const blocked = () => existsSync(quiet) || loadavg()[0] >= 18;
while (blocked()) await delay(1000);
const directory = await mkdtemp(join(output, "a4-host-"));
const temporary = join(directory, "tmp");
await mkdir(temporary, { mode: 0o700 });
const entry = new URL("./mailbox-host.ts", import.meta.url);
const instrument = new URL(import.meta.url);
const sourceHash = createHash("sha256")
  .update(await readFile(entry))
  .update(await readFile(instrument))
  .digest("hex");
const runtimeEntry = `tools/perf/resource-host-fixture-${sourceHash.slice(0, 12)}.ts`;
await copyFile(entry, join(runtime, runtimeEntry));
const child = spawn(
  process.execPath,
  [
    "--conditions=ohmail-source",
    "--import",
    "tsx",
    runtimeEntry,
    "--output",
    output,
    "--state",
    join(directory, "mail"),
    "--rows",
    String(size),
    "--template",
    join(output, "templates-with-files", String(size)),
    "--pg-bin",
    join(output, "pg-local/lib/postgresql/16/bin"),
    ...(mode === "roster-witness" ? ["--roster-witness"] : ["--events-mode", mode]),
  ],
  {
    cwd: runtime,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: temporary,
      TMPDIR: temporary,
      LANG: "C.UTF-8",
      TZ: "UTC",
      TSX_DISABLE_CACHE: "1",
      LD_LIBRARY_PATH: join(output, "pg-local/extra"),
    },
  },
);
const stopped = once(child, "exit");
const guard = new AbortController();
const stop = () => guard.abort();
const receipt = { size, mode, sourceHash, states: {}, maxAdmittedLoad: 0 };
const watcher = setInterval(() => {
  const load = loadavg()[0];
  if (load >= 18 || existsSync(quiet)) stop();
  else receipt.maxAdmittedLoad = Math.max(load, receipt.maxAdmittedLoad);
}, 150);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

function check() {
  if (blocked()) stop();
  guard.signal.throwIfAborted();
}

async function run(fixture) {
  const base = new URL(fixture.baseUrl);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.origin !== fixture.baseUrl ||
    fixture.rowCount !== size ||
    fixture.eventsMode !== (mode === "roster-witness" ? "polling" : mode) ||
    fixture.attachmentCount < 1
  ) {
    throw new Error("Local fixture validation failed.");
  }
  receipt.attachmentCount = fixture.attachmentCount;
  const target = (path, options = {}, signal = guard.signal) => {
    check();
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error("Expected fixture origin.");
    return fetch(url, {
      ...options,
      signal,
      redirect: "error",
      headers: { authorization: `Bearer ${fixture.sessionToken}`, ...options.headers },
    });
  };
  const stats = async () => {
    const response = await target("/__perf/stats");
    if (!response.ok) throw new Error("Fixture counters unavailable.");
    return response.json();
  };
  const median = (numbers) => {
    const values = [...numbers].sort((a, b) => a - b);
    return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
  };
  const apiCpu = (state) => state.cpuMicroseconds.user + state.cpuMicroseconds.system;
  const syncPath = (cursor) => `/sync?since=${encodeURIComponent(cursor)}`;
  const inspect = async (path, headers) => {
    const start = performance.now();
    const response = await target(
      path,
      { headers },
      AbortSignal.any([guard.signal, AbortSignal.timeout(30_000)]),
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`Unexpected fixture status ${response.status}.`);
    return { bytes, sql: Number(response.headers.get("x-perf-sql-queries")), ms: performance.now() - start };
  };
  const section = async (name, task) => {
    const before = await stats();
    const endPostgres = monitorHost([fixture.postgresPid]);
    const started = performance.now();
    try {
      const result = await task(started);
      const pg = endPostgres();
      const after = await stats();
      check();
      receipt.states[name] = {
        ...result,
        elapsedMs: performance.now() - started,
        apiCpuMs: (apiCpu(after) - apiCpu(before)) / 1000,
        postgresCpuMs: pg.cpuMs,
        statements: after.totalQueries - before.totalQueries,
        requests: after.totalRequests - before.totalRequests,
      };
    } finally {
      endPostgres();
    }
  };
  const repeat = async (name, path, headers, count = 200) => {
    for (let i = 0; i < Math.min(16, count); i++) await inspect(path, headers);
    await section(name, async () => {
      const samples = [];
      for (let i = 0; i < count; i++) {
        const { bytes, sql, ms } = await inspect(path, headers);
        samples.push({ bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sql, ms });
      }
      return {
        samples: samples.length,
        decodedBytes: median(samples.map((s) => s.bytes)),
        modeledGzipBytes: median(samples.map((s) => s.gzipBytes)),
        medianMs: median(samples.map((s) => s.ms)),
        p95Ms: samples.map((s) => s.ms).sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1],
        statementsPerRequest: median(samples.map((s) => s.sql)),
      };
    });
  };
  const arrive = async (count) => {
    const response = await target("/__perf/arrive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count }),
    });
    if (!response.ok) throw new Error("Synthetic arrival failed.");
    return response.json();
  };
  if (mode === "roster-witness") {
    const path = "/mailboxes";
    const grouped = { "x-perf-roster-transaction": "grouped" };
    for (const suffix of ["First", "Second"]) {
      await repeat("existing" + suffix, path);
      await repeat("grouped" + suffix, path, grouped);
    }
    const stable = (bytes) =>
      JSON.stringify(JSON.parse(bytes), (key, value) => (key === "asOf" ? undefined : value));
    receipt.equalRosterExceptClock =
      stable((await inspect(path)).bytes) === stable((await inspect(path, grouped)).bytes);
    if (!receipt.equalRosterExceptClock) throw new Error("Roster witness changed the response.");
    return;
  }
  if (mode === "polling") {
    await repeat("emptySync", syncPath(fixture.initialCursor));
    await repeat("mailboxes", "/mailboxes");
    const archive = "/sync/snapshot?phase=tail&limit=500";
    const archiveAnswer = JSON.parse((await inspect(archive)).bytes);
    const archiveData = archiveAnswer.data ?? archiveAnswer;
    receipt.archiveRows = archiveData.changes.filter((change) => change.type === "message").length;
    await repeat("archiveTail", archive, undefined, 10);
    const arrival = await arrive(500);
    if (arrival.rowCount !== size + 500) throw new Error("Wrong fixture arrival count.");
    await repeat("delta500", syncPath(fixture.initialCursor));
    const delta = JSON.parse((await inspect(syncPath(fixture.initialCursor))).bytes);
    const data = delta.data ?? delta;
    const creates = data.changes.creates.filter((row) => row.type === "message");
    if (creates.length !== 500 || data.cursor !== arrival.cursor) {
      throw new Error("Measured delta did not contain all 500 arrivals.");
    }
    const tail = await inspect(syncPath(data.cursor));
    const empty = JSON.parse(tail.bytes);
    const emptyData = empty.data ?? empty;
    if (
      emptyData.hasMore ||
      emptyData.cursor !== data.cursor ||
      Object.values(emptyData.changes).some((rows) => rows.length !== 0)
    ) {
      throw new Error("Measured delta did not terminate at an empty horizon.");
    }
    receipt.deltaShape = {
      changes: Object.fromEntries(Object.entries(data.changes).map(([op, rows]) => [op, rows.length])),
      createsOfMessages: creates.length,
      hasMore: data.hasMore,
      reachedHorizon: true,
      emptyTail: { bytes: tail.bytes.length, statements: tail.sql },
    };
    const ids = creates
      .slice(0, 20)
      .map((row) => row.id)
      .join(",");
    await repeat("bodies20", `/messages/bodies?ids=${encodeURIComponent(ids)}`);
    return;
  }
  await section("heldIdleThenArrival", async (start) => {
    const stream = new AbortController();
    const signal = AbortSignal.any([guard.signal, stream.signal]);
    const response = await target("/events", {}, signal);
    if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      throw new Error(`Unexpected fixture status ${response.status}.`);
    }
    const reader = response.body.getReader();
    const frames = [];
    const decoder = new TextDecoder();
    let pending = "",
      bytes = 0,
      wakeResolve,
      readyResolve;
    const wake = new Promise((resolve) => {
      wakeResolve = resolve;
    });
    const ready = new Promise((resolve) => {
      readyResolve = resolve;
    });
    try {
      const consume = async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          pending += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const type = /^event: (ready|ping|sync|sync_failed)$/m.exec(frame)?.[1] ?? "retry";
            const timestamp = performance.now();
            frames.push({ type, msSinceDial: timestamp - start, bytes: Buffer.byteLength(frame) + 2 });
            if (type === "ready") readyResolve();
            if (type === "sync") wakeResolve(timestamp);
          }
        }
      };
      const reading = consume();
      reading.catch(() => {});
      if ((await Promise.race([ready.then(() => true), delay(5_000, false, { signal })])) !== true) {
        throw new Error("Held event stream did not prove its ready and sync frames.");
      }
      const opened = await stats();
      await delay(42_000, undefined, { signal });
      const idle = await stats();
      const insertAt = performance.now();
      await arrive(1);
      const insertComplete = performance.now();
      const heard = await Promise.race([wake, delay(10_000, null, { signal })]);
      if (!heard || frames.filter((frame) => frame.type === "ready").length !== 1) {
        throw new Error("Held event stream did not prove its ready and sync frames.");
      }
      return {
        frames,
        bytes,
        openingStatements: opened.queryCategories.events.queries,
        steadyEventStatements: idle.queryCategories.events.queries - opened.queryCategories.events.queries,
        steadyApiCpuMs: (apiCpu(idle) - apiCpu(opened)) / 1000,
        insertToWakeMs: heard - insertAt,
        receiptToWakeMs: heard - insertComplete,
      };
    } finally {
      stream.abort();
      await reader.cancel().catch(() => {});
    }
  });
  const delta = await inspect(syncPath(fixture.initialCursor));
  receipt.oneArrivalDelta = {
    decodedBytes: delta.bytes.length,
    modeledGzipBytes: gzipSync(delta.bytes).length,
    statements: delta.sql,
    ms: delta.ms,
  };
}

try {
  const manifest = join(directory, "mail/mailbox-ready.json");
  const deadline = Date.now() + 120_000;
  while (!existsSync(manifest)) {
    check();
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error("Resource fixture did not start.");
    }
    await delay(100);
  }
  await run(JSON.parse(await readFile(manifest, "utf8")));
  check();
  receipt.result = "finished";
} catch (error) {
  receipt.result = guard.signal.aborted ? "guard interrupted" : "failed";
  receipt.error =
    error.message.match(
      /^(Local fixture validation failed|Fixture counters unavailable|Unexpected fixture status \d+|Synthetic arrival failed|Wrong fixture arrival count|Measured delta did not contain all 500 arrivals|Measured delta did not terminate at an empty horizon|Held event stream did not prove its ready and sync frames|Resource fixture did not start)\./,
    )?.[1] ?? error.name;
  process.exitCode = guard.signal.aborted ? 75 : 1;
} finally {
  clearInterval(watcher);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await Promise.race([stopped, delay(15_000, undefined, { ref: false })]);
  await writeFile(join(directory, "result.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
}
console.log(`${size} ${mode}: ${receipt.result} (${directory})`);
