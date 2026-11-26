import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const ARRIVALS = 500;
// The fixture has no pinned mail and keeps the newest ten thousand messages inside ninety days.
const WINDOW_ROWS = 10_000;
// The production client requests this page size only on a stale or interrupted drain.
const BACKLOG_LIMIT = "2000";
const MIRROR_STATE_PATH = "/api/__perf/mirror-state";
const ARRIVAL_MARK = "ohmail-perf-arrival-visible";
const TIMEOUT_MS = 120_000;

function localUrl(path, base) {
  const origin = new URL(base);
  assert.equal(origin.protocol, "http:", "benchmark requires a local HTTP origin");
  assert(["127.0.0.1", "localhost"].includes(origin.hostname), "benchmark requires a loopback origin");
  assert(!origin.username && !origin.password, "benchmark origin cannot contain credentials");
  return new URL(path, origin);
}

async function hostStatus(fixture, action = "status", body) {
  const response = await fetch(localUrl(`/__perf/${action}`, fixture.baseUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${fixture.sessionToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  assert(response.ok, `benchmark fixture ${action} failed with HTTP ${response.status}`);
  const status = await response.json();
  assert(Number.isSafeInteger(status.rowCount), "benchmark fixture did not report a stored count");
  watermark(status.cursor);
  assert(
    typeof status.newestMessageId === "string" && status.newestMessageId.length > 0,
    "benchmark fixture did not report the newest message",
  );
  assert(
    typeof status.newestSubject === "string" && status.newestSubject.length > 0,
    "benchmark fixture did not report the newest subject",
  );
  return status;
}

function watermark(cursor) {
  assert(typeof cursor === "string", "benchmark mirror did not report a cursor");
  // The current host encodes either seq or generation.seq in its cursor.
  const parts = /^(?:\d+\.)?(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  const seq = Number(parts?.[1]);
  assert(Number.isSafeInteger(seq) && seq > 0, "benchmark cursor did not name a nonzero watermark");
  return seq;
}

function assertBaseline(status, fixture) {
  assert.equal(status.rowCount, fixture.rowCount, "host baseline count");
  assert(status.cursor === fixture.initialCursor, "host baseline cursor");
}

// Retain only the sync requests' status and paging parameters.
// Desktop bridge requests occur in Node and do not appear as browser network requests.
export function watchMirrorSync(page, { surface, origin, client = surface, onDesktopResponse }) {
  const events = [];
  const originUrl = localUrl("/", origin).origin;
  function record(method, path, search, status) {
    const pathname = path.replace(/^\/api(?=\/)/, "");
    if (method !== "GET" || (pathname !== "/sync" && pathname !== "/sync/snapshot")) return;
    const params = new URLSearchParams(search);
    events.push({
      pathname,
      status,
      answeredAtMs: performance.timeOrigin + performance.now(),
      since: params.get("since"),
      limit: params.get("limit"),
      cursor: params.get("cursor"),
      phase: params.get("phase"),
    });
  }
  if (surface === "desktop") {
    assert.equal(typeof onDesktopResponse, "function", "desktop benchmark needs bridge observation");
    const stop = onDesktopResponse((entry) => {
      if (entry.client === client) record(entry.method, entry.pathname, entry.search, entry.status);
    });
    return { events, stop };
  }
  assert.equal(surface, "web", "unknown benchmark surface");
  const observe = (response) => {
    const url = new URL(response.url());
    if (url.origin === originUrl)
      record(response.request().method(), url.pathname, url.search, response.status());
  };
  page.on("response", observe);
  return { events, stop: () => page.off("response", observe) };
}

// Executed in the actual web origin. Only counts and metadata cross the Playwright boundary.
// Write the clock stamp only after verifying the on-disk owner and baseline in the same transaction.
async function readWebMirror({ accountId, expectedCursor, rows, newestMessageId, agedAt, afterMs = 0 }) {
  function result(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  const request = indexedDB.open(`ohmail-mirror:${accountId}`);
  request.onupgradeneeded = () => request.transaction.abort();
  let db;
  try {
    db = await result(request);
  } catch (error) {
    if (error?.name === "AbortError" && agedAt === undefined) return null;
    throw error;
  }
  try {
    const tx = db.transaction(["entities", "meta"], agedAt === undefined ? "readonly" : "readwrite");
    const complete = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? new Error("benchmark mirror transaction aborted"));
    });
    const entities = tx.objectStore("entities");
    const meta = tx.objectStore("meta");
    const messageRange = IDBKeyRange.bound("message:", "message:\uffff");
    const [owner, cursor, drainStamp, mirrorRows, newest] = await Promise.all([
      result(meta.get("__owner")),
      result(meta.get("cursor")),
      result(meta.get("lastDrainAt")),
      result(entities.count(messageRange)),
      result(entities.get(`message:${newestMessageId}`)),
    ]);
    let lastDrainAtMs = Date.parse(drainStamp);
    const completeWindow =
      owner === accountId &&
      cursor === expectedCursor &&
      mirrorRows === rows &&
      newest?.entity?.id === newestMessageId &&
      Number.isFinite(lastDrainAtMs) &&
      lastDrainAtMs > afterMs;
    if (completeWindow && agedAt !== undefined) {
      meta.put(agedAt, "lastDrainAt");
      lastDrainAtMs = Date.parse(agedAt);
    }
    await complete;
    return completeWindow
      ? { mirrorRows, lastDrainAtMs, drainSinceNavigationMs: lastDrainAtMs - performance.timeOrigin }
      : null;
  } finally {
    db.close();
  }
}

function mirrorQuery(fixture, status) {
  return {
    accountId: fixture.accountId,
    expectedCursor: status.cursor,
    rows: Math.min(status.rowCount, WINDOW_ROWS),
    newestMessageId: status.newestMessageId,
  };
}

async function waitForWebMirror(page, query) {
  const deadline = performance.now() + TIMEOUT_MS;
  while (performance.now() < deadline) {
    try {
      const proof = await page.evaluate(readWebMirror, query);
      if (proof) return proof;
    } catch (error) {
      // Reauth can replace the document between the navigation commit and this probe.
      if (
        page.isClosed() ||
        !/Execution context was destroyed|Cannot find context with specified id/.test(error.message)
      ) {
        throw error;
      }
    }
    await delay(200);
  }
  throw new Error("persisted mail window did not reach the verified fixture horizon");
}

async function waitForEvent(sync, predicate, failure) {
  assert(sync, "benchmark must start observing sync before navigation");
  const until = performance.now() + TIMEOUT_MS;
  for (;;) {
    const event = sync.events.find(predicate);
    if (event) return event;
    assert(performance.now() < until, failure);
    await delay(100);
  }
}

function waitForDesktopSnapshot(sync, cursor) {
  return waitForEvent(
    sync,
    (event) => event.status === 200 && event.pathname === "/sync" && event.since === cursor,
    "desktop bootstrap never drained from the fixture's complete horizon",
  );
}

export function ohboxRow(page, messageId) {
  // The fixture's newest Inbox message is a standalone conversation.
  return page.locator(ohboxRowSelector(messageId));
}

function ohboxRowSelector(messageId) {
  return `section.fr-list .oh-row[data-id=${JSON.stringify(messageId)}]`;
}

async function waitForVisibleMessage(page, status) {
  const subject = ohboxRow(page, status.newestMessageId).getByText(status.newestSubject, { exact: true });
  await subject.waitFor({ state: "visible", timeout: TIMEOUT_MS });
}

export async function observeArrival(page, arrival) {
  await page.addInitScript(
    ({ selector, subject, mark }) => {
      if (window !== top) return;
      function observe() {
        const row = document.querySelector(selector);
        // The stable row ID disambiguates the subject from other messages. Different
        // layouts can place the label in different descendants of the same row.
        if (row?.textContent?.includes(subject)) {
          const box = row.getBoundingClientRect();
          const left = Math.max(0, box.left);
          const top = Math.max(0, box.top);
          const right = Math.min(innerWidth, box.right);
          const bottom = Math.min(innerHeight, box.bottom);
          if (
            right > left &&
            bottom > top &&
            row.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))
          ) {
            requestAnimationFrame(() => performance.mark(mark));
            return;
          }
        }
        requestAnimationFrame(observe);
      }
      requestAnimationFrame(observe);
    },
    {
      selector: ohboxRowSelector(arrival.newestMessageId),
      subject: arrival.newestSubject,
      mark: ARRIVAL_MARK,
    },
  );
}

async function arrivalVisibleMs(page) {
  const mark = await page.waitForFunction(
    (name) => {
      const entry = performance.getEntriesByName(name, "mark")[0];
      return entry && { visibleMs: entry.startTime, navigationEpochMs: performance.timeOrigin };
    },
    ARRIVAL_MARK,
    { timeout: TIMEOUT_MS },
  );
  try {
    return await mark.jsonValue();
  } finally {
    await mark.dispose();
  }
}

export async function conditionWarm(page, { fixture, surface, sync }) {
  const status = await hostStatus(fixture);
  assertBaseline(status, fixture);
  await waitForVisibleMessage(page, status);
  if (surface === "desktop") {
    await waitForDesktopSnapshot(sync, status.cursor);
    // The desktop renderer rebuilds its in-memory window each launch. Its full host
    // count and the accepted post-snapshot cursor are the durable preconditions.
    return {
      hostRows: status.rowCount,
      hostWatermark: watermark(status.cursor),
      mirrorRows: null,
      mirrorWatermark: watermark(status.cursor),
      lastDrainAtMs: null,
    };
  }
  assert.equal(surface, "web", "unknown benchmark surface");
  const { mirrorRows, lastDrainAtMs } = await waitForWebMirror(page, mirrorQuery(fixture, status));
  return {
    hostRows: status.rowCount,
    hostWatermark: watermark(status.cursor),
    mirrorWatermark: watermark(status.cursor),
    mirrorRows,
    lastDrainAtMs,
  };
}

export async function ageForReopen(page, { fixture, surface, origin }) {
  // Leave the app document before changing its clock stamp or making arrivals. Otherwise
  // its background drain could advance the old cursor before the measured reopen.
  const neutral = await page.goto(localUrl(MIRROR_STATE_PATH, origin).href, { waitUntil: "load" });
  assert(
    neutral?.ok() && page.url() === localUrl(MIRROR_STATE_PATH, origin).href,
    "could not close the app into its blank same-origin benchmark document",
  );
  const before = await hostStatus(fixture);
  assertBaseline(before, fixture);
  const agedAtMs = Date.now() - THREE_DAYS_MS;
  const agedAt = new Date(agedAtMs).toISOString();
  let mirror = null;
  if (surface === "web") {
    mirror = await page.evaluate(readWebMirror, { ...mirrorQuery(fixture, before), agedAt });
    assert.equal(mirror?.lastDrainAtMs, agedAtMs, "could not age the warm web mirror");
  } else {
    assert.equal(surface, "desktop", "unknown benchmark surface");
  }
  const after = await hostStatus(fixture, "age", { lastSyncAt: agedAt });
  assertBaseline(after, fixture);
  assert.equal(Date.parse(after.lastSyncAt), agedAtMs, "could not age the fixture host mailbox");
  return {
    agedAtMs,
    hostRows: after.rowCount,
    hostWatermark: watermark(after.cursor),
    mirrorRows: mirror?.mirrorRows ?? null,
    mirrorWatermark: mirror ? watermark(after.cursor) : null,
  };
}

export async function addArrivals(fixture, count = ARRIVALS) {
  const before = await hostStatus(fixture);
  assertBaseline(before, fixture);
  const after = await hostStatus(fixture, "arrive", { count });
  assert.equal(after.rowCount - before.rowCount, count, "host arrival count");
  assert(watermark(after.cursor) > watermark(before.cursor), "arrivals did not advance the host watermark");
  assert(after.newestMessageId !== before.newestMessageId, "host did not record a new latest message");
  return after;
}

export async function measureLiveArrival(
  page,
  fixture,
  { count = 1, verifyMirror = false, desktopSync } = {},
) {
  const before = await hostStatus(fixture);
  const startedAt = Date.now();
  const after = await hostStatus(fixture, "arrive", { count });
  const committedBy = Date.now();
  assert.equal(after.rowCount, before.rowCount + count, "live host arrival count");
  assert(watermark(after.cursor) > watermark(before.cursor), "live arrival must advance the watermark");
  await waitForVisibleMessage(page, after);
  const visibleAt = await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now())),
        );
      }),
  );
  const mirror = verifyMirror
    ? await waitForWebMirror(page, { ...mirrorQuery(fixture, after), afterMs: startedAt })
    : null;
  const desktopDrain = desktopSync ? await waitForDesktopSnapshot(desktopSync, after.cursor) : null;
  return {
    insertAndReceiptMs: committedBy - startedAt,
    receiptToVisibleMs: visibleAt - committedBy,
    ...(mirror
      ? { mirrorRows: mirror.mirrorRows, receiptToDrainMs: mirror.lastDrainAtMs - committedBy }
      : {}),
    ...(desktopDrain ? { receiptToHorizonReplyMs: desktopDrain.answeredAtMs - committedBy } : {}),
  };
}

async function arrivalConvergence(page, { fixture, surface, arrival, sync, agedAtMs }) {
  if (surface === "desktop") {
    const { answeredAtMs } = await waitForDesktopSnapshot(sync, arrival.cursor);
    const convergenceMs = await page.evaluate((answered) => answered - performance.timeOrigin, answeredAtMs);
    return { convergenceMs };
  }
  assert.equal(surface, "web", "unknown benchmark surface");
  assert(Number.isFinite(agedAtMs), "arrival verification needs the aged browser drain stamp");
  const staleDelta = (event) =>
    event.status === 200 &&
    event.pathname === "/sync" &&
    event.since === fixture.initialCursor &&
    event.limit === BACKLOG_LIMIT;
  const [{ drainSinceNavigationMs, mirrorRows, lastDrainAtMs }] = await Promise.all([
    waitForWebMirror(page, { ...mirrorQuery(fixture, arrival), afterMs: agedAtMs }),
    waitForEvent(sync, staleDelta, "web reopen did not fetch deltas from its stale baseline"),
  ]);
  const deltaAt = sync.events.findIndex(staleDelta);
  assert(
    sync.events
      .slice(0, deltaAt)
      .some(
        (event) =>
          event.status === 200 &&
          event.pathname === "/sync/snapshot" &&
          event.cursor === null &&
          event.phase === null,
      ),
    "web reopen did not fetch the newest page before the stale delta drain",
  );
  return { mirrorRows, lastDrainAtMs, convergenceMs: drainSinceNavigationMs };
}

export async function waitForArrival(page, options) {
  const { arrival, onVisible } = options;
  const visibility = arrivalVisibleMs(page);
  const [visible, convergence, progress] = await Promise.allSettled([
    visibility,
    arrivalConvergence(page, options),
    visibility.then(onVisible),
  ]);
  const hostWatermark = watermark(arrival.cursor);
  return {
    hostRows: arrival.rowCount,
    hostWatermark,
    mirrorRows: null,
    mirrorWatermark: convergence.status === "fulfilled" ? hostWatermark : null,
    lastDrainAtMs: null,
    ...(convergence.status === "fulfilled"
      ? convergence.value
      : {
          convergenceMs: null,
          convergenceFailure: "arrival drain could not be verified",
        }),
    ...(visible.status === "fulfilled"
      ? { visibleMs: visible.value.visibleMs }
      : {
          visibleMs: null,
          visibilityFailure: "newest arrival was not observed in the viewport",
        }),
    ...(visible.status === "fulfilled" && progress.status === "rejected"
      ? {
          visibilityProgressFailure: "intermediate arrival observation could not be saved",
        }
      : {}),
  };
}
