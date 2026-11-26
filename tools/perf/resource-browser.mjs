import { activeUse } from "./gestures.mjs";
import { measureLiveArrival } from "./mirror.mjs";

const timerEvents = new Set(["TimerInstall", "TimerRemove", "TimerFire", "FireAnimationFrame"]);

async function observeTimers(session) {
  const events = {};
  const installedTimeoutsMs = {};
  const collect = ({ value }) => {
    for (const event of value) {
      if (!timerEvents.has(event.name)) continue;
      events[event.name] = (events[event.name] ?? 0) + 1;
      const delay = event.args?.data?.timeout;
      if (event.name === "TimerInstall" && Number.isFinite(delay)) {
        installedTimeoutsMs[delay] = (installedTimeoutsMs[delay] ?? 0) + 1;
      }
    }
  };
  session.on("Tracing.dataCollected", collect);
  await session.send("Tracing.start", {
    categories: "devtools.timeline",
    options: "record-as-much-as-possible",
    transferMode: "ReportEvents",
  });
  return async () => {
    const completed = new Promise((resolve) => session.once("Tracing.tracingComplete", resolve));
    try {
      await session.send("Tracing.end");
      await completed;
      return { events, installedTimeoutsMs };
    } finally {
      session.off("Tracing.dataCollected", collect);
    }
  };
}

export async function measureResourceDetail({
  page,
  context,
  resources,
  fixture,
  size,
  surface,
  sync,
  sqlSnapshot,
  record,
  mode,
}) {
  const browser = await context.browser().newBrowserCDPSession();
  const session = await context.newCDPSession(page);
  const tasksMs = async () => {
    const { metrics } = await session.send("Performance.getMetrics");
    return metrics.find((metric) => metric.name === "TaskDuration").value * 1000;
  };
  const workers = async () => {
    const { targetInfos } = await browser.send("Target.getTargets");
    const counts = { dedicated: 0, shared: 0, service: 0 };
    for (const { type } of targetInfos) {
      if (type === "worker") counts.dedicated++;
      if (type === "shared_worker") counts.shared++;
      if (type === "service_worker") counts.service++;
    }
    return counts;
  };
  const postGc = (atCheckpoint = false) =>
    resources.heap(async () => {
      if (atCheckpoint) {
        await page.evaluate(() => {
          location.hash = "/ohbox";
        });
        await page
          .locator('.ob-scroll [role="option"][data-id]:not([aria-disabled="true"])')
          .first()
          .waitFor({ timeout: 5000 });
        await page.waitForTimeout(500);
      }
      await session.send("HeapProfiler.collectGarbage");
      const result = await session.send("Runtime.getHeapUsage");
      return {
        heapMiB: result.usedSize / 1048576,
        externalMiB: result.backingStorageSize / 1048576,
        workers: await workers(),
        ...(atCheckpoint ? { checkpointView: "ohbox" } : {}),
      };
    });
  try {
    await session.send("Performance.enable");
    await record("preload-settled", () =>
      resources.active(async (clock) => {
        const bodyCount = async () => (await sqlSnapshot()).queryCategories?.messageBodiesById?.requests ?? 0;
        let requests = await bodyCount();
        let unchanged = 0;
        for (let i = 0; i < 30 && unchanged < 3; i++) {
          await clock.wait(5_000);
          const next = await bodyCount();
          unchanged = next === requests && next > 0 ? unchanged + 1 : 0;
          requests = next;
        }
        if (unchanged < 3) throw new Error("Recent-body preload did not settle.");
        return {
          requests,
          queries: (await sqlSnapshot()).queryCategories?.messageBodiesById?.queries ?? 0,
          stableMs: unchanged * 5_000,
        };
      }),
    );
    await record("heap-settled", postGc);
    if (mode === "preload-detail") return;
    await record("settled-idle", () =>
      resources.active(async (clock) => {
        const before = await tasksMs();
        const finish = await observeTimers(session);
        let timers;
        try {
          await clock.wait(65_000);
        } finally {
          timers = await finish();
        }
        return { mainThreadTaskMs: (await tasksMs()) - before, workers: await workers(), ...timers };
      }),
    );
    await record("sync-500", () =>
      resources.active(async () => {
        const before = await tasksMs();
        const result = await measureLiveArrival(page, fixture, {
          count: 500,
          verifyMirror: surface === "web",
          desktopSync: surface === "desktop" ? sync : undefined,
        });
        return { ...result, mainThreadTaskMs: (await tasksMs()) - before, workers: await workers() };
      }),
    );
    await record("sync-background", () => resources.idle(25_000));
    await record("heap-after-arrivals", postGc);
    if (size === 1000000 && surface === "web") {
      const checkpoints = [
        [1, 60_000],
        [3, 120_000],
        [10, 420_000],
      ];
      if (mode === "resource-plateau") checkpoints.push([20, 600_000], [30, 600_000]);
      for (const [minutes, workMs] of checkpoints) {
        await record(`active-to-${minutes}min`, () =>
          resources.active((clock) => activeUse(page, { activeMs: workMs, clock })),
        );
        await record(`heap-${minutes}min`, () => postGc(mode === "resource-plateau"));
      }
    }
  } finally {
    await session.detach().catch(() => {});
    await browser.detach().catch(() => {});
  }
}
