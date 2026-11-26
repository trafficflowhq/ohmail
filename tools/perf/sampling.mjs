import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
const pageKiB = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim()) / 1024;

// Process ids can disappear between the directory read and the counter read.
function processStats() {
  const stats = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      stats.push({
        pid: Number(name),
        parent: Number(fields[1]),
        ticks: Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]),
        rssKiB: Number(fields[21]) * pageKiB,
      });
    } catch (err) {
      if (!["EACCES", "ENOENT", "ESRCH"].includes(err.code)) throw err;
    }
  }
  return stats;
}

function family(all, roots) {
  const included = new Set(roots.filter(Number.isInteger));
  // Ignore grandchildren counted from secondary roots that are already descendants.
  let previous;
  do {
    previous = included.size;
    for (const p of all) if (included.has(p.parent)) included.add(p.pid);
  } while (previous < included.size);
  const members = all.filter((p) => included.has(p.pid));
  return {
    ticks: members.reduce((n, p) => n + p.ticks, 0),
    rssMiB: members.reduce((n, p) => n + p.rssKiB, 0) / 1024,
    processes: members.length,
  };
}

export function monitorHost(pids) {
  const snapshot = () => family(processStats(), pids);
  const before = snapshot();
  const start = performance.now();
  let peak = before.rssMiB;
  const timer = setInterval(() => {
    peak = Math.max(peak, snapshot().rssMiB);
  }, 1000);
  return () => {
    clearInterval(timer);
    const after = snapshot();
    return {
      elapsedMs: Math.round(performance.now() - start),
      cpuMs: ((after.ticks - before.ticks) * 1000) / ticksPerSecond,
      peakSampledRssMiB: Math.max(peak, after.rssMiB),
      finalRssMiB: after.rssMiB,
      processes: after.processes,
    };
  };
}

export async function observeStartup(page) {
  // A nonzero, enabled mail row hit-testable inside the viewport. The next animation
  // frame follows the paint opportunity for the frame in which we first saw it.
  await page.addInitScript(() => {
    function observe() {
      for (const el of document.querySelectorAll('.fr-list [role="option"][data-id]')) {
        const box = el.getBoundingClientRect();
        const x = Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2));
        const y = Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2));
        if (
          !box.width ||
          !box.height ||
          el.matches(":disabled,[aria-disabled=true]") ||
          !el.contains(document.elementFromPoint(x, y))
        )
          continue;
        requestAnimationFrame(() => {
          window.__perfUsable = performance.now();
        });
        return;
      }
      requestAnimationFrame(observe);
    }
    if (window === top) requestAnimationFrame(observe);
  });
}

export async function startup(page, url, timeoutMs) {
  const result = {};
  try {
    const navigation = await page.goto(url, { waitUntil: "commit", timeout: timeoutMs });
    result.documentStatus = navigation?.status() ?? null;
    await page.waitForFunction(() => typeof window.__perfUsable === "number", null, { timeout: timeoutMs });
  } catch (err) {
    result.failure = err.name === "TimeoutError" ? "usable-list deadline" : "navigation interrupted";
  }
  try {
    Object.assign(
      result,
      await page.evaluate(async () => {
        const paint = (name) => performance.getEntriesByName(name, "paint")[0]?.startTime ?? null;
        const navigation = performance.getEntriesByType("navigation")[0];
        const assets = performance
          .getEntriesByType("resource")
          .filter(
            (entry) =>
              !entry.name.includes("/api/") && new URL(entry.name, location.href).origin === location.origin,
          );
        return {
          documentTtfbMs: navigation?.responseStart ?? null,
          documentBytes: navigation?.transferSize ?? null,
          resourcesCompleted: assets.length,
          resourceTransferBytes: assets.reduce((n, entry) => n + entry.transferSize, 0),
          firstPaintMs: paint("first-paint"),
          firstContentfulPaintMs: paint("first-contentful-paint"),
          usableMs: window.__perfUsable ?? null,
          rowsMounted: document.querySelectorAll('.fr-list [role="option"][data-id]').length,
          allMailRows: document.querySelectorAll('[role="option"][data-id]').length,
          buttons: document.querySelectorAll("button").length,
          listRegions: document.querySelectorAll(".fr-list").length,
          alerts: document.querySelectorAll('[role="alert"]').length,
          busy: document.querySelectorAll('[aria-busy="true"]').length,
          signInDoor: Array.from(document.querySelectorAll("button,a")).some((node) =>
            /^(?:sign in|log in)$/i.test(node.textContent.trim()),
          ),
          errorBoundary: /something went wrong|application error|failed to load/i.test(
            document.body.innerText.slice(0, 500),
          ),
          databases: (await indexedDB.databases()).length,
        };
      }),
    );
  } catch {
    result.failure ??= "renderer unavailable";
  }
  return result;
}

// Chrome traces may contain route arguments, headers and content. Persist only numeric
// timing fields for rendering events. The original trace never leaves this process.
export async function startTrace(session) {
  const events = [];
  const allowed = new Set([
    "RunTask",
    "BeginFrame",
    "DrawFrame",
    "Paint",
    "Layout",
    "UpdateLayoutTree",
    "Commit",
    "FireAnimationFrame",
    "DroppedFrame",
    "MajorGC",
    "MinorGC",
  ]);
  const collect = ({ value }) => {
    for (const e of value)
      if (
        allowed.has(e.name) ||
        /^mail-bench\.(?:mark-read|move|send|switch-(?:news|ohbox|search|calendar|settings)|search-results)\.(?:input|visible)$/.test(
          e.name,
        )
      ) {
        events.push({ name: e.name, ph: e.ph, ts: e.ts, dur: e.dur, pid: e.pid, tid: e.tid });
      }
  };
  session.on("Tracing.dataCollected", collect);
  await session.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline.frame,toplevel,blink.user_timing",
    options: "record-as-much-as-possible",
    transferMode: "ReportEvents",
  });
  return async () => {
    const completed = new Promise((resolve) => session.once("Tracing.tracingComplete", resolve));
    await session.send("Tracing.end");
    await completed;
    session.off("Tracing.dataCollected", collect);
    return { traceEvents: events };
  };
}
