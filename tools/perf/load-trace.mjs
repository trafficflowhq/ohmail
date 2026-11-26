const routes = new Map([
  ["/auth/session", "session"],
  ["/auth/refresh", "refresh"],
  ["/consent", "consent"],
  ["/mailboxes", "mailboxes"],
  ["/sync", "delta"],
  ["/sync/snapshot", "snapshot"],
  ["/events", "events"],
  ["/messages/bodies", "bodies"],
  ["/messages", "messages"],
  ["/calendar/sync", "calendar-delta"],
  ["/calendar/sync/snapshot", "calendar-snapshot"],
]);

function apiKind(path, search) {
  const kind = routes.get(path.replace(/^\/api\//, "/"));
  if (kind === "snapshot" && new URLSearchParams(search).has("cursor")) return "snapshot-page";
  return kind ?? "other-api";
}

function browserKind(url, type) {
  if (type === "Document") return "document";
  if (url.pathname === "/sw.js") return "worker";
  if (url.pathname.startsWith("/api/") || url.pathname === "/auth/refresh") {
    return apiKind(url.pathname, url.search);
  }
  return { Script: "script", Stylesheet: "stylesheet", Font: "font" }[type];
}

// Keep measurements and versioned asset names. Headers, query strings, and payloads
// stay in the browser and fixture.
export async function observeLoad(context, page, surface, client) {
  const origin = new URL(surface.origin).origin;
  const cdp = await context.newCDPSession(page);
  await page.addInitScript(() => {
    if (window !== top || !globalThis.IDBDatabase) return;
    const original = IDBDatabase.prototype.transaction;
    const transactions = (window.__perfLoadTransactions = []);
    IDBDatabase.prototype.transaction = function (names, mode, options) {
      const transaction = original.call(this, names, mode, options);
      if (!this.name.startsWith("ohmail-mirror:") || transactions.length >= 256) return transaction;
      const stores = typeof names === "string" ? [names] : names;
      const row = {
        stores: Array.from(stores).filter((name) => name === "entities" || name === "meta"),
        mode: transaction.mode,
        start: performance.now(),
      };
      transactions.push(row);
      transaction.addEventListener(
        "complete",
        () => {
          row.end = performance.now();
        },
        { once: true },
      );
      return transaction;
    };
  });
  const requests = [];
  const byId = new Map();
  const stop = surface.onResponse((event) => {
    if (event.client !== client || !Number.isFinite(event.startedAtMs)) return;
    requests.push({
      kind: apiKind(event.pathname, event.search),
      method: event.method,
      status: event.status,
      start: event.startedAtMs,
      end: event.endedAtMs,
      decodedBodyBytes: event.bodyBytes,
      sql: event.sqlQueries,
    });
  });
  cdp.on(
    "Network.requestWillBeSent",
    ({ requestId, request, type, timestamp, wallTime, redirectResponse }) => {
      const url = new URL(request.url);
      if (url.origin !== origin) return;
      const kind = browserKind(url, type);
      if (!kind) return;
      const previous = byId.get(requestId);
      if (previous && redirectResponse) {
        previous.row.status = redirectResponse.status;
        previous.row.end = timestamp * 1000 + previous.offset;
      }
      const start = wallTime * 1000;
      const file = url.pathname.split("/").at(-1);
      const asset =
        ["script", "stylesheet", "font"].includes(kind) && /^[\w.-]+$/.test(file) ? file : undefined;
      const row = { kind, asset, method: request.method, start };
      requests.push(row);
      byId.set(requestId, { row, offset: start - timestamp * 1000 });
    },
  );
  cdp.on("Network.requestServedFromCache", ({ requestId }) => {
    const entry = byId.get(requestId);
    if (entry) entry.row.cache = "browser";
  });
  cdp.on("Network.responseReceived", ({ requestId, timestamp, response }) => {
    const entry = byId.get(requestId);
    if (!entry) return;
    const headers = Object.fromEntries(
      Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const sql = Number(headers["x-perf-sql-queries"]);
    const policy = String(headers["cache-control"] ?? "");
    Object.assign(entry.row, {
      status: response.status,
      headers: timestamp * 1000 + entry.offset,
      cache: response.fromServiceWorker
        ? "worker"
        : response.fromDiskCache
          ? "disk"
          : (entry.row.cache ?? "network"),
      ...(Number.isFinite(sql) ? { sql } : {}),
      ...(policy ? { immutable: /\bimmutable\b/.test(policy), noStore: /\bno-store\b/.test(policy) } : {}),
    });
  });
  cdp.on("Network.loadingFinished", ({ requestId, timestamp, encodedDataLength }) => {
    const entry = byId.get(requestId);
    if (entry)
      Object.assign(entry.row, { end: timestamp * 1000 + entry.offset, wireBytes: encodedDataLength });
  });
  await cdp.send("Network.enable");
  return {
    async snapshot(openedAt, index) {
      const document = await page.evaluate(async () => {
        const navigation = performance.getEntriesByType("navigation")[0];
        const registration = await navigator.serviceWorker?.getRegistration();
        return {
          epoch: performance.timeOrigin,
          ttfbMs: navigation?.responseStart,
          workerStartMs: navigation?.workerStart,
          workerRegistered: Boolean(registration),
          workerControlsPage: Boolean(navigator.serviceWorker?.controller),
          usableMs: window.__perfUsable,
          transactions: window.__perfLoadTransactions ?? [],
          resources: performance
            .getEntriesByType("resource")
            .map((entry) => {
              const url = new URL(entry.name);
              const kind = /\.m?js$/.test(url.pathname)
                ? "script"
                : /\.css$/.test(url.pathname)
                  ? "stylesheet"
                  : null;
              return kind && url.origin === location.origin
                ? {
                    kind,
                    start: entry.startTime,
                    end: entry.responseEnd,
                    encodedBodyBytes: entry.encodedBodySize,
                    decodedBodyBytes: entry.decodedBodySize,
                    transferBytes: entry.transferSize,
                  }
                : null;
            })
            .filter(Boolean),
        };
      });
      return {
        ...document,
        beforeDocumentMs: document.epoch - openedAt,
        requests: requests.slice(index).map((row) => ({
          ...row,
          start: row.start - openedAt,
          ...(row.headers === undefined ? {} : { headers: row.headers - openedAt }),
          ...(row.end === undefined ? {} : { end: row.end - openedAt }),
        })),
      };
    },
    count: () => requests.length,
    close: async () => {
      stop();
      await cdp.detach().catch(() => {});
    },
  };
}

// Compare two reads of the same closed application's fixture mirror in a neutral document.
export function compareMirrorReads(page, accountId) {
  return page.evaluate(async (owner) => {
    const result = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const open = indexedDB.open(`ohmail-mirror:${owner}`);
    open.onupgradeneeded = () => open.transaction.abort();
    const db = await result(open);
    const names = ["entities", "meta"];
    async function sample(bulk) {
      const start = performance.now();
      const tx = db.transaction(names, "readonly");
      const done = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      const read = [];
      for (const name of names) {
        const store = tx.objectStore(name);
        if (bulk) {
          const rows = await result(store.getAllRecords());
          read.push(
            rows.map((row) => row.primaryKey),
            rows.map((row) => row.value),
          );
        } else {
          read.push(await result(store.getAllKeys()), await result(store.getAll()));
        }
      }
      await done;
      return { ms: performance.now() - start, read };
    }
    try {
      if (typeof IDBObjectStore.prototype.getAllRecords !== "function") return { supported: false };
      const pairs = [];
      for (let i = 0; i < 7; i++) {
        const first = await sample(i % 2 === 1);
        const second = await sample(i % 2 === 0);
        const [ordinary, bulk] = i % 2 === 0 ? [first, second] : [second, first];
        if (JSON.stringify(ordinary.read) !== JSON.stringify(bulk.read)) {
          throw Error("browser mirror bulk read changed its result");
        }
        pairs.push({ ordinaryMs: ordinary.ms, bulkMs: bulk.ms, entityRows: ordinary.read[0].length });
      }
      return { supported: true, pairs };
    } finally {
      db.close();
    }
  }, accountId);
}
