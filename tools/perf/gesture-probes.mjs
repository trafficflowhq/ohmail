const percentile = (numbers, fraction) => {
  if (numbers.length === 0) return null;
  const ordered = [...numbers].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * fraction) - 1];
};

export function summarize(samples) {
  const times = samples.map(({ ms }) => ms).filter(Number.isFinite);
  return {
    attempts: samples.length,
    measured: times.length,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: times.length ? Math.max(...times) : null,
  };
}

// The browser's event timestamp includes time an input spent waiting for the main thread.
// Poll at rAF and require the effect to survive one paint opportunity.
export async function measurePress(target, perform, effect, timeoutMs, eventType = "click") {
  const armed = await target.evaluate(
    (control, { effect, timeoutMs, eventType }) => {
      const visible = (node) => {
        if (node.closest("[inert], [hidden]")) return false;
        if (
          node.checkVisibility &&
          !node.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        )
          return false;
        const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
        if (!width || !height || bottom <= 0 || top >= innerHeight || right <= 0 || left >= innerWidth)
          return false;
        return getComputedStyle(node).visibility === "visible";
      };
      const matches = ({ selector, prefix, includes, hidden }) => {
        const shown = [...document.querySelectorAll(selector)].some((node) => {
          if (!visible(node)) return false;
          if (prefix === undefined && includes === undefined) return true;
          const text = node.textContent.trim();
          return (
            (prefix === undefined || text.startsWith(prefix)) &&
            (includes === undefined || text.includes(includes))
          );
        });
        return hidden ? !shown : shown;
      };
      const reached = () => effect.some((requirements) => requirements.every(matches));
      let finish;
      const result = new Promise((resolve) => {
        finish = resolve;
      });
      let timer;
      let frame;
      let began = null;
      let seen = false;
      const stop = (data) => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        document.removeEventListener(eventType, start, true);
        finish(data);
      };
      const start = (event) => {
        if (event.isTrusted && control.contains(event.target)) {
          began = event.timeStamp;
          if (window.__ohmailTraceAction)
            performance.mark(`mail-bench.${window.__ohmailTraceAction}.input`, { startTime: began });
          document.removeEventListener(eventType, start, true);
        }
      };
      const tick = () => {
        const met = began !== null && reached();
        if (met && seen) {
          const presented = performance.now();
          if (window.__ohmailTraceAction)
            performance.mark(`mail-bench.${window.__ohmailTraceAction}.visible`);
          return stop({ ms: presented - began, inputMs: began, presentedMs: presented });
        }
        seen = met;
        frame = requestAnimationFrame(tick);
      };

      window.__ohmailBenchmarkPress = { result, stop };
      if (reached()) {
        stop({ ms: null, why: "The expected effect was already visible before the input." });
        return false;
      }
      document.addEventListener(eventType, start, true);
      frame = requestAnimationFrame(tick);
      timer = setTimeout(
        () =>
          stop({
            ms: null,
            why:
              began === null
                ? "The input did not reach its control."
                : "The expected effect did not become visible.",
          }),
        timeoutMs,
      );
      return true;
    },
    { effect, timeoutMs, eventType },
    { timeout: timeoutMs },
  );

  if (armed) {
    try {
      await perform();
    } catch {
      await target.page().evaluate(() =>
        window.__ohmailBenchmarkPress.stop({
          ms: null,
          why: "Playwright could not complete the input on its visible control.",
        }),
      );
    }
  }
  return target.page().evaluate(() => {
    const { result } = window.__ohmailBenchmarkPress;
    delete window.__ohmailBenchmarkPress;
    return result;
  });
}

// Feed real Chromium wheel input into the measured pane. The viewport remains at the
// end of the scroll. Movement, paint opportunities and long tasks are browser readings.
export async function measureScroll(page, scroller, { screens, timeoutMs, direction = 1 }) {
  const box = await scroller.boundingBox({ timeout: timeoutMs });
  if (!box) return { ms: null, why: "The scroll area is empty or hidden." };
  // Anchor inside the pane and clear of the phone's floating controls.
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
  const screenPx = await scroller.evaluate((element) => {
    const origin = element.scrollTop;
    const frames = [];
    const tasks = [];
    const supported =
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask");
    let observer;
    if (supported) {
      observer = new PerformanceObserver((entries) => tasks.push(...entries.getEntries()));
      observer.observe({ type: "longtask" });
    }
    let began = null;
    let lastInputAt = null;
    let latestPosition = origin;
    let lastChangeAt = null;
    let distancePx = 0;
    let frame;
    const onWheel = (event) => {
      if (event.isTrusted) {
        began ??= event.timeStamp;
        lastInputAt = event.timeStamp;
      }
    };
    element.addEventListener("wheel", onWheel, { capture: true, passive: true });
    const tick = (time) => {
      if (began !== null) {
        frames.push(time);
        const current = element.scrollTop;
        if (current !== latestPosition) {
          distancePx += Math.abs(current - latestPosition);
          lastChangeAt = time;
        }
        latestPosition = current;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.__ohmailBenchmarkScroll = () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("wheel", onWheel, true);
      tasks.push(...(observer?.takeRecords() ?? []));
      observer?.disconnect();
      const lastActivityAt = Math.max(lastChangeAt ?? 0, lastInputAt ?? 0);
      const end =
        began === null ? null : (frames.find((time) => time > lastActivityAt) ?? frames.at(-1) ?? null);
      return {
        began,
        end,
        frames: frames.filter((time) => time >= began && time <= end),
        netPx: latestPosition - origin,
        distancePx,
        longTasks: supported
          ? tasks
              .filter(
                (task) =>
                  began !== null &&
                  end !== null &&
                  task.startTime < end &&
                  task.startTime + task.duration > began,
              )
              .map((task) => task.duration)
          : null,
      };
    };
    return element.clientHeight;
  });

  const pulses = Math.max(2, Math.ceil(screens * 2));
  const requestedPx = Math.round(screenPx * screens);
  let inputFailed = false;
  let data;
  try {
    for (let step = 1; step <= pulses; step += 1) {
      const delta =
        Math.round((requestedPx * step) / pulses) - Math.round((requestedPx * (step - 1)) / pulses);
      await page.mouse.wheel(0, direction * delta);
      await page.waitForTimeout(65);
    }
    await page.waitForTimeout(150);
  } catch {
    inputFailed = true;
  } finally {
    data = await page.evaluate(() => {
      const finish = window.__ohmailBenchmarkScroll;
      delete window.__ohmailBenchmarkScroll;
      return finish();
    });
  }
  const { frames, began, end, netPx, distancePx, longTasks } = data;
  const gaps = frames.slice(1).map((time, i) => time - frames[i]);
  const actualPx = Math.max(0, netPx * direction);
  const reached = !inputFailed && began !== null && end !== null && actualPx >= requestedPx - 1;
  return {
    ms: end === null ? null : end - began,
    reached,
    why: reached
      ? undefined
      : inputFailed
        ? "Chromium did not complete the wheel inputs."
        : "The list travelled less than the requested distance.",
    requestedPx,
    screenPx,
    actualPx,
    actualScreens: screenPx === 0 ? null : actualPx / screenPx,
    distancePx,
    frameCount: frames.length,
    p95FrameMs: percentile(gaps, 0.95),
    maxFrameMs: gaps.length ? Math.max(...gaps) : null,
    framesOver32Ms: gaps.filter((gap) => gap > 32).length,
    longTaskCount: longTasks?.length ?? null,
    longestTaskMs: longTasks === null ? null : Math.max(0, ...longTasks),
    longTaskMs: longTasks?.reduce((sum, duration) => sum + duration, 0) ?? null,
  };
}
