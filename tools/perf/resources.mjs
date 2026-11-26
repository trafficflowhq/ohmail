import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const GUARD_POLL_MS = 200;
const SAMPLE_MS = 1000;
const STOP_POLL_MS = 200;
const EXITED = new Set(["Z", "X", "x"]);
const STOPPED = new Set(["T", "t", ...EXITED]);

function readProcess(pid, tid) {
  try {
    const path = tid === undefined ? `/proc/${pid}/stat` : `/proc/${pid}/task/${tid}/stat`;
    const line = readFileSync(path, "utf8");
    const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      state: fields[0],
      parent: Number(fields[1]),
      start: fields[19],
      ticks: Number(fields[11]) + Number(fields[12]),
      pages: Number(fields[21]),
    };
  } catch (error) {
    if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
    return null;
  }
}

function processes() {
  return new Map(
    readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map((name) => readProcess(Number(name)))
      .filter(Boolean)
      .map((entry) => [entry.pid, entry]),
  );
}

function descendants(all, roots) {
  const children = new Map();
  for (const entry of all.values()) {
    const siblings = children.get(entry.parent) ?? [];
    siblings.push(entry);
    children.set(entry.parent, siblings);
  }
  const pending = roots
    .map((root) => all.get(root.pid))
    .filter((entry, index) => entry?.start === roots[index].start);
  const family = new Map();
  for (let index = 0; index < pending.length; index++) {
    const entry = pending[index];
    if (family.has(entry.pid)) continue;
    family.set(entry.pid, entry);
    pending.push(...(children.get(entry.pid) ?? []));
  }
  return [...family.values()];
}

function ownRoot(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error("Invalid resource process root.");
  }
  const entry = readProcess(pid);
  if (!entry || EXITED.has(entry.state) || statSync(`/proc/${pid}`).uid !== process.getuid()) {
    throw new Error("Resource process root is unavailable.");
  }
  for (let ancestor = process.ppid; ancestor > 1;) {
    if (ancestor === pid) throw new Error("Resource process root is a benchmark ancestor.");
    ancestor = readProcess(ancestor)?.parent ?? 0;
  }
  return entry;
}

function belongsToRunner(entry) {
  for (let parent = entry.parent; parent > 1; parent = readProcess(parent)?.parent ?? 0) {
    if (parent === process.pid) return true;
  }
  return false;
}

function signalExact(entry, signal) {
  const current = readProcess(entry.pid);
  if (current?.start !== entry.start || EXITED.has(current.state)) return false;
  try {
    process.kill(entry.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

function threadsStopped(entry) {
  if (EXITED.has(entry.state)) return true;
  if (!STOPPED.has(entry.state)) return false;
  const current = readProcess(entry.pid);
  if (current?.start !== entry.start || !STOPPED.has(current.state)) return false;
  try {
    // A stopped leader does not prove that a sibling has returned from kernel I/O.
    return readdirSync(`/proc/${entry.pid}/task`).every((tid) =>
      STOPPED.has(readProcess(entry.pid, tid)?.state),
    );
  } catch (error) {
    if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
    return false;
  }
}

function freezer(roots) {
  const paused = new Map();

  function stop(entry) {
    const current = readProcess(entry.pid);
    if (current?.start !== entry.start || STOPPED.has(current.state)) return;
    if (current.state === "D" && paused.get(entry.pid)?.start === entry.start) return;
    if (signalExact(entry, "SIGSTOP")) paused.set(entry.pid, entry);
  }

  async function freeze(isClosed) {
    for (const root of roots) stop(root);
    const missing = new Set();
    // Stop parents first. A second census catches children created before the
    // kernel acknowledged their parent's stop. While the guard holds, a stop
    // pending in kernel I/O keeps the phase suspended until it settles.
    let confirmed = false;
    while (!isClosed()) {
      const all = processes();
      for (const root of roots) {
        const current = all.get(root.pid) ?? readProcess(root.pid);
        if (current ? current.start !== root.start || EXITED.has(current.state) : missing.has(root.pid)) {
          throw new Error("A resource process root exited during suspension.");
        }
        if (current) {
          all.set(root.pid, current);
          missing.delete(root.pid);
        } else missing.add(root.pid);
      }
      // Retain identities we already stopped if an intermediate parent exited.
      const family = descendants(all, [...roots, ...paused.values()]);
      const settled = missing.size === 0 && family.every(threadsStopped);
      if (settled && confirmed) return;
      confirmed = settled;
      for (const entry of family) stop(entry);
      await delay(STOP_POLL_MS);
    }
  }

  function thaw() {
    // Resume dependants before their parents. Never resume a replacement PID or
    // a process that was already stopped before this benchmark reached it.
    let failed;
    for (const entry of [...paused.values()].reverse()) {
      try {
        signalExact(entry, "SIGCONT");
        paused.delete(entry.pid);
      } catch (error) {
        failed ??= error;
      }
    }
    if (failed) throw failed;
  }

  return { freeze, thaw };
}

function admissionClock({ isBlocked, signal, onLoad, roots }) {
  const tasks = freezer(roots);
  let pausedAt = null,
    pausedWall = 0,
    epoch = 0,
    transition = null,
    closed = false;
  let failure;
  let rejectClosed;
  const cancelled = new Promise((_, reject) => {
    rejectClosed = reject;
  });
  cancelled.catch(() => {});

  function close(reason = new Error("Resource phase closed.")) {
    if (!closed) {
      closed = true;
      failure = reason;
      clearInterval(watcher);
      signal?.removeEventListener("abort", onAbort);
      rejectClosed(failure);
    }
    tasks.thaw();
  }

  function onAbort() {
    try {
      close(signal.reason);
    } catch (error) {
      failure = error;
    }
  }

  function confirmFreeze() {
    transition = tasks
      .freeze(() => closed || !isBlocked())
      .catch((error) => {
        close(error);
      })
      .finally(() => {
        transition = null;
      });
    transition.catch(() => {});
  }

  function check() {
    if (closed || transition) return;
    try {
      if (isBlocked()) {
        if (pausedAt !== null) return;
        pausedAt = performance.now();
        epoch++;
        confirmFreeze();
        return;
      }
      if (pausedAt !== null) {
        tasks.thaw();
        if (isBlocked()) {
          confirmFreeze();
          return;
        }
        pausedWall += performance.now() - pausedAt;
        pausedAt = null;
      }
      onLoad?.(loadavg()[0]);
    } catch (error) {
      close(error);
    }
  }

  function timestamp() {
    const wall = performance.now();
    const withheld = pausedWall + (pausedAt === null ? 0 : wall - pausedAt);
    return { wall, admitted: wall - withheld, withheld, epoch, running: pausedAt === null && !closed };
  }

  async function ready() {
    for (;;) {
      check();
      if (closed) throw failure;
      if (pausedAt === null) return epoch;
      await Promise.race([delay(GUARD_POLL_MS), cancelled]);
    }
  }

  async function wait(ms) {
    await ready();
    const deadline = timestamp().admitted + ms;
    for (;;) {
      const remaining = deadline - timestamp().admitted;
      if (remaining <= 0) return;
      await Promise.race([delay(Math.min(GUARD_POLL_MS, remaining)), cancelled]);
      await ready();
    }
  }

  const watcher = setInterval(check, GUARD_POLL_MS);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  check();
  return { now: () => timestamp().admitted, ready, wait, poll: check, timestamp, cancelled, close };
}

function processMeter(clock, browserRoot, hostRoots, tickMs, pageMiB) {
  let previous;
  let sampledMs = 0,
    browserTicks = 0,
    hostTicks = 0;
  let browserPeak = 0,
    hostPeak = 0,
    samples = 0;

  function sample() {
    clock.poll();
    const at = clock.timestamp();
    if (!at.running) return;
    const all = processes();
    if (
      [browserRoot, ...hostRoots].some((root) => {
        const current = all.get(root.pid);
        return current?.start !== root.start || EXITED.has(current.state);
      })
    )
      throw new Error("A measured process root exited.");
    const browser = descendants(all, [browserRoot]);
    const host = descendants(all, hostRoots);
    clock.poll();
    if (!clock.timestamp().running) return;
    const browserRss = browser.reduce((sum, entry) => sum + entry.pages, 0) * pageMiB;
    const hostRss = host.reduce((sum, entry) => sum + entry.pages, 0) * pageMiB;
    if (previous?.at.epoch === at.epoch) {
      const delta = (family, baseline) => {
        const starts = new Map(baseline.map((entry) => [entry.start + ":" + entry.pid, entry.ticks]));
        return family.reduce(
          (sum, entry) => sum + Math.max(0, entry.ticks - (starts.get(entry.start + ":" + entry.pid) ?? 0)),
          0,
        );
      };
      sampledMs += at.admitted - previous.at.admitted;
      browserTicks += delta(browser, previous.browser);
      hostTicks += delta(host, previous.host);
    }
    browserPeak = Math.max(browserPeak, browserRss);
    hostPeak = Math.max(hostPeak, hostRss);
    samples++;
    previous = { at, browser, host, browserRss, hostRss };
  }

  sample();
  const timer = setInterval(() => {
    try {
      sample();
    } catch (error) {
      clock.close(error);
    }
  }, SAMPLE_MS);
  return {
    async waitUntilSampled(durationMs) {
      while (sampledMs < durationMs) {
        await clock.wait(durationMs - sampledMs);
        sample();
      }
    },
    close() {
      clearInterval(timer);
    },
    finish() {
      sample();
      return {
        sampledMs,
        samples,
        browser: {
          cpuMs: browserTicks * tickMs,
          peakSampledRssMiB: browserPeak,
          finalRssMiB: previous?.browserRss ?? null,
        },
        host: {
          cpuMs: hostTicks * tickMs,
          peakSampledRssMiB: hostPeak,
          finalRssMiB: previous?.hostRss ?? null,
          processes: previous?.host.length ?? 0,
        },
      };
    },
  };
}

async function uninterruptedRead(read, clock) {
  for (;;) {
    const before = await clock.ready();
    try {
      const value = await read();
      if ((await clock.ready()) === before) return value;
    } catch (error) {
      if ((await clock.ready()) === before) throw error;
    }
  }
}

export async function createResourcePhases({
  isBlocked,
  signal,
  browserSession,
  hostPids,
  totalSQL,
  sqlSnapshot,
  onLoad,
}) {
  const { processInfo } = await browserSession.send("SystemInfo.getProcessInfo");
  const browser = ownRoot(processInfo.find(({ type }) => type === "browser")?.id);
  if (!belongsToRunner(browser)) throw new Error("Chromium is not owned by the benchmark runner.");
  const host = [...new Set(hostPids)].map(ownRoot);
  const tickMs = 1000 / Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  const pageMiB = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim()) / 1048576;
  const clock = admissionClock({ isBlocked, signal, onLoad, roots: [browser, ...host] });
  const readSQL = sqlSnapshot ?? (async () => ({ totalQueries: await totalSQL() }));
  let measuring = false;

  async function phase(work) {
    if (measuring) throw new Error("Resource phases must run one at a time.");
    measuring = true;
    let meter;
    try {
      const requested = clock.timestamp();
      const beforeSQL = await Promise.race([uninterruptedRead(readSQL, clock), clock.cancelled]);
      const start = clock.timestamp();
      meter = processMeter(clock, browser, host, tickMs, pageMiB);
      const value = await Promise.race([work(clock, meter), clock.cancelled]);
      await clock.ready();
      const sampled = meter.finish();
      meter.close();
      const end = clock.timestamp();
      const afterSQL = await Promise.race([uninterruptedRead(readSQL, clock), clock.cancelled]);
      const queries = afterSQL.totalQueries - beforeSQL.totalQueries;
      let sqlBreakdown = {};
      if (beforeSQL.queryCategories && afterSQL.queryCategories) {
        const entries = Object.entries(afterSQL.queryCategories)
          .map(([name, after]) => {
            const before = beforeSQL.queryCategories[name];
            return [
              name,
              {
                requests: after.requests - (before?.requests ?? 0),
                failures: after.failures - (before?.failures ?? 0),
                queries: after.queries - (before?.queries ?? 0),
              },
            ];
          })
          .filter(([, counts]) => counts.requests || counts.failures || counts.queries);
        const categorizedQueries = entries.reduce((sum, [, counts]) => sum + counts.queries, 0);
        sqlBreakdown = {
          queryCategories: Object.fromEntries(entries),
          uncategorizedQueries: queries - categorizedQueries,
        };
      }
      const admittedMs = end.admitted - start.admitted;
      const pauses = end.epoch - start.epoch;
      return {
        value,
        browser: { ...sampled.browser, cpuSampledMs: sampled.sampledMs },
        host: {
          ...sampled.host,
          elapsedMs: admittedMs,
          cpuSampledMs: sampled.sampledMs,
          queries,
          ...sqlBreakdown,
        },
        admission: {
          method: pauses ? "accumulated" : "uninterrupted",
          admittedMs,
          pauses,
          wallMs: end.wall - start.wall,
          pausedWallMs: end.withheld - start.withheld,
          pausedBeforeMs: start.withheld - requested.withheld,
          resourceSamples: sampled.samples,
          cpuSampling: "intervals entirely inside one admission window",
          sqlSampling: "fixture counter difference with its process family suspended during holds",
        },
      };
    } finally {
      meter?.close();
      measuring = false;
    }
  }

  return {
    async idle(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Idle duration must be positive.");
      const result = await phase((_clock, meter) => meter.waitUntilSampled(durationMs));
      const browserCpuMs = result.browser.cpuMs;
      const cpuSampledMs = result.browser.cpuSampledMs;
      result.value = {
        requestedMs: durationMs,
        elapsedMs: result.admission.admittedMs,
        browserCpuMs,
        cpuSampledMs,
        percentOfOneCore: cpuSampledMs > 0 ? (browserCpuMs * 100) / cpuSampledMs : null,
      };
      return result;
    },
    active: (work) => phase((clock) => work(clock)),
    heap: (read) => phase((clock) => uninterruptedRead(read, clock)),
    close: clock.close,
  };
}
