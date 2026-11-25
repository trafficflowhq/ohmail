import { describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { payShellWipe } from "../src/shell/take-back";
import type { KeptRow, ShellConfig } from "../src/shell/bridge-kinds";
import { createBridge } from "../web/src/bridge";
import { createPhoneEngine } from "../web/src/engine";
import { IndexedDbMirrorStore, prepareCalendarCopies } from "../web/src/engine-package";
import type { PagePort } from "../web/src/port";

const when = "2026-11-25T12:00:00.000Z";
const row = (type: string, id: string, entity: object, seq: number) =>
  ({ type, id, entity, seq, op: "create", updatedAt: when });
const mail = [
  row("message", "letter", { subject: "A private letter", bodyText: "Private words" }, 1),
  row("draft", "draft", { status: "draft", body: "Unsent words" }, 2),
];
const calendar = row("calendar", "calendar", { name: "My calendar" }, 3);
const settings = row("settings", "account", { accountId: "account", calendarEnabledAt: when }, 3);
const suggestion = row("calendar_suggestion", "suggestion", { sourceWords: "Words from a letter" }, 3);
const window = { days: 90, minRows: 0 };

function fixture({ unsupported = false, mixedReply = false } = {}) {
  const factory = new IDBFactory();
  Object.assign(globalThis, { indexedDB: factory, IDBKeyRange });
  const paths: URL[] = [];
  const keepers = new Map<string, Map<string, KeptRow>>();
  const keeperOf = (scope: string) => {
    let rows = keepers.get(scope);
    if (!rows) keepers.set(scope, rows = new Map());
    return rows;
  };
  const kept = keeperOf("fixture");
  const keeperRequests: string[] = [];
  let expired = false;
  let prepared = false;
  let take: ((text: string) => void) | undefined;
  const port: PagePort = {
    listen(fn) { take = fn; return () => { take = undefined; }; },
    post(text) {
      const ask = JSON.parse(text) as {
        id: number; epoch: string; kind: string; path: string; scope: string; puts?: KeptRow[]; deletes?: [string, string][];
      };
      const reply = (answer: object) => queueMicrotask(() => take?.(JSON.stringify({
        id: ask.id, epoch: ask.epoch, ok: true, ...answer,
      })));
      if (ask.kind === "keptRows") {
        keeperRequests.push(ask.kind);
        return reply({ rows: [...keeperOf(ask.scope).values()] });
      }
      if (ask.kind === "keepRows") {
        keeperRequests.push(ask.kind);
        const rows = keeperOf(ask.scope);
        for (const [type, id] of ask.deletes ?? []) rows.delete(type + ":" + id);
        for (const put of ask.puts ?? []) rows.set(put.type + ":" + put.id, put);
        return reply({ kept: true });
      }
      const url = new URL(ask.path, "https://fixture.invalid");
      paths.push(url);
      let answer: object = {};
      let status = 200;
      if (url.pathname.endsWith("/sync/snapshot")) {
        const restricted = url.pathname === "/calendar/sync/snapshot";
        if (unsupported && restricted) status = 404;
        const changes = restricted && !mixedReply ? [calendar, settings] : [...mail, calendar, suggestion, settings];
        answer = { asOfSeq: 3, changes, nextCursor: null, window, calendarWindow: { daysBack: 90, daysAhead: 90, maxRows: 100 } };
      }
      if (url.pathname.endsWith("/sync")) {
        if (expired) {
          expired = false;
          status = 410;
        }
        const types = url.searchParams.get("types")?.split(",") ?? [];
        const creates = [row("calendar", "added", { name: "Another calendar" }, 4), ...mail, suggestion]
          .filter((change) => types.includes(change.type));
        answer = { cursor: "4", changes: { creates, updates: [], deletes: [], moves: [] }, hasMore: false, serverTime: when };
      }
      reply({ status, headers: [["content-type", "application/json"]], body: { as: "text", text: JSON.stringify(answer) } });
    },
  };
  const bridge = createBridge(port, crypto.randomUUID());

  const open = (app: ShellConfig["app"], scope = "fixture") => {
    const phone = createPhoneEngine({ scope, accountId: "account", setting: "managed", app } as ShellConfig, bridge);
    return { ...phone, close: () => { phone.engine.dispose(); (phone.store as IndexedDbMirrorStore).close(); } };
  };
  return {
    open, paths, kept, keeperRequests, keeperOf, expire: () => { expired = true; },
    markPrepared: () => { prepared = true; },
    wipe: (scope: string) => payShellWipe({
      calendarCopiesPrepared: () => prepared,
      scopeOf: async (owner) => owner,
      keeperScopes: async () => [...keepers.keys()],
      fenceCalendarWipe: async (owner: string) =>
        [...keeperOf(owner).values()].some((row) => row.type === "calendar_outbox") ? "pending" : "empty",
      releaseCalendarWipe: async () => {},
      forgetKeeper: async (owner) => keepers.delete(owner),
      clearViewCopies: async () => {
        Object.assign(globalThis, { indexedDB: new IDBFactory() });
        return { listed: false, usage: 0 };
      },
    }, scope),
  };
}

describe("the calendar phone's copy", () => {
  it("starts with the calendar phase and keeps only calendar and account rows through hydration and catch-up", async () => {
    const { open, paths, kept, keeperRequests, expire } = fixture();
    const first = open("ohcal");
    try {
      await first.engine.start();
      expect(first.store.entries("message")).toEqual([]);
      expect(first.store.entries("draft")).toEqual([]);
      expect(first.store.entries("calendar_suggestion")).toEqual([]);
      expect(first.store.get("calendar", "calendar")).toBeDefined();
      expect(first.store.get("calendar", "added")).toBeDefined();
      expect(first.store.getCursor()).toBe("4");
      expect(first.engine.serverSearchAvailable()).toBe(false);
      await first.engine.hydrateThread(["letter"]);
      await first.engine.searchServer("private");
      expect(await first.engine.requestPull()).toBeNull();
      await first.store.setMeta("lastDrainAt", "2000-01-01T00:00:00.000Z");
      await first.store.setMeta("storePolicyGeneration", 0);
      expire();
      await first.engine.syncOnce();
      expect(first.store.getCursor()).toBe("4");
    } finally {
      first.close();
    }
    const reopened = open("ohcal");
    try {
      await reopened.engine.start();
      expect(reopened.store.entries("message")).toEqual([]);
      expect(reopened.store.get("calendar", "added")).toBeDefined();
      expect([...kept.values()]).toEqual([]);
      expect(keeperRequests.every((kind) => kind === "keptRows")).toBe(true);
      expect(paths.filter((url) => url.pathname.endsWith("/snapshot")).map((url) => [url.pathname, url.searchParams.get("phase")]))
        .toEqual([["/calendar/sync/snapshot", "calendar"], ["/calendar/sync/snapshot", "calendar"]]);
      for (const url of paths.filter((url) => url.pathname === "/calendar/sync")) {
        expect(url.searchParams.get("types")?.split(",").sort()).toEqual(["calendar", "calendar_connection", "calendar_event", "settings"]);
      }
      expect(paths.filter((url) => /^\/(messages|mailboxes|search)(\/|$)/.test(url.pathname))).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("keeps an older server's mail feed untouched and states when its calendar feed is unavailable", async () => {
    const { open, paths } = fixture({ unsupported: true });
    const phone = open("ohcal");
    try {
      await expect(phone.engine.start()).rejects.toMatchObject({ code: "calendar_unavailable" });
      expect(phone.engine.calendarServerUnavailable()).toBe(true);
      expect(phone.store.getCursor()).toBe("0");
      expect(paths.map((url) => url.pathname)).toEqual(["/calendar/sync/snapshot"]);
    } finally {
      phone.close();
    }
  });

  it("refuses an unexpected mail row before committing a snapshot or its cursor", async () => {
    const { open } = fixture({ mixedReply: true });
    const phone = open("ohcal");
    try {
      await expect(phone.engine.start()).rejects.toMatchObject({ code: "protocol" });
      expect(phone.store.entries("message")).toEqual([]);
      expect(phone.store.getCursor()).toBe("0");
    } finally {
      phone.close();
    }
  });

  it("clears previously cached mail in both accounts and keeps unsent calendar edits before opening a copy", async () => {
    fixture();
    for (const owner of ["current", "other"]) {
      const previous = new IndexedDbMirrorStore({ owner });
      await previous.load();
      await previous.putLocal("message", "letter", mail[0]?.entity);
      await previous.putLocal("compose_letter", "draft", mail[1]?.entity);
      await previous.putLocal("calendar_outbox", "offline", { kind: "calendar edit" });
      previous.close();
    }
    await prepareCalendarCopies("current");
    for (const owner of ["current", "other"]) {
      const upgraded = new IndexedDbMirrorStore({ owner });
      await upgraded.load();
      expect(upgraded.entries("message")).toEqual([]);
      expect(upgraded.entries("compose_letter")).toEqual([]);
      expect(upgraded.get("calendar_outbox", "offline")).toEqual({ kind: "calendar edit" });
      expect(upgraded.getCursor()).toBe("0");
      upgraded.close();
    }
  });

  it("restores another profile's pending calendar edit and settled receipt after a forget clears the web view", async () => {
    const { open, keeperOf, wipe, markPrepared } = fixture();
    const first = open("ohcal");
    await first.engine.hydrate();
    first.close();
    const other = open("ohcal", "other");
    await other.engine.hydrate();
    const entity = { act: { kind: "calendar_event_delete" } };
    const receipt = { expiresAt: Date.now() + 60_000, reference: { type: "event", id: "event" }, result: { kind: "taken" } } as const;
    await other.store.commitLocal([
      { type: "calendar_outbox", id: "waiting", entity },
      { type: "calendar_outbox", id: "settled", entity },
    ], []);
    await other.store.decideCalendarRow("settled", () => null, receipt);
    expect([...keeperOf("other").values()].map((row) => row.type).sort()).toEqual(["calendar_outbox", "calendar_settlement"]);
    other.close();

    markPrepared();
    await wipe("fixture");
    const reopened = open("ohcal", "other");
    try {
      await reopened.engine.hydrate();
      expect(reopened.store.get("calendar_outbox", "waiting")).toEqual(entity);
      expect(reopened.store.get("calendar_outbox", "settled")).toBeUndefined();
      expect(reopened.store.get("calendar_settlement", "settled")).toEqual(receipt);
      expect(reopened.store.entries("message")).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("keeps a pending forget from erasing an unopened profile's legacy offline edit", async () => {
    const { open, keeperOf, wipe, markPrepared } = fixture();
    const active = "p" + "a".repeat(32);
    const inactive = "p" + "b".repeat(32);
    keeperOf(active);
    const legacy = new IndexedDbMirrorStore({ owner: inactive });
    await legacy.load();
    const edit = { act: { kind: "calendar_event_update" }, key: "pending" };
    await legacy.putLocal("calendar_outbox", "pending", edit);
    await legacy.putLocal("message", "letter", mail[0]?.entity);
    legacy.close();

    await expect(wipe(active)).rejects.toMatchObject({ code: "shell_view_not_cleared" });
    await prepareCalendarCopies(undefined, async (scope, rows) => {
      for (const row of rows) keeperOf(scope).set(row.type + ":" + row.id, {
        type: row.type, id: row.id, json: JSON.stringify(row),
      });
      return true;
    });
    markPrepared();
    await wipe(active);
    const reopened = open("ohcal", inactive);
    try {
      await reopened.engine.hydrate();
      expect(reopened.store.get("calendar_outbox", "pending")).toEqual(edit);
      expect(reopened.store.entries("message")).toEqual([]);
      expect([...keeperOf(inactive).values()].map((row) => row.type)).toEqual(["calendar_outbox"]);
    } finally {
      reopened.close();
    }
  });

  it("refuses to wipe either the open or a parked pairing with an offline edit", async () => {
    const { open, keeperOf, wipe, markPrepared } = fixture();
    markPrepared();
    for (const scope of ["fixture", "parked"]) {
      const phone = open("ohcal", scope);
      await phone.engine.hydrate();
      const entity = { act: { kind: "calendar_event_update" }, key: "pending" };
      await phone.store.commitLocal([{ type: "calendar_outbox", id: "pending", entity }], []);
      if (scope === "parked") phone.close();
      try {
        await expect(wipe(scope)).rejects.toMatchObject({ code: "calendar_queue_pending" });
        expect(keeperOf(scope).has("calendar_outbox:pending")).toBe(true);
      } finally {
        if (scope === "fixture") phone.close();
      }
    }
  });

  it("transfers legacy counterproposal times under the original key for review", async () => {
    const { keeperOf } = fixture();
    const scope = "p" + "a".repeat(32);
    const old = new IndexedDbMirrorStore({ owner: scope });
    await old.load();
    const act = {
      kind: "calendar_event_propose", recordId: "invitation", base: when, occurrence: "occurrence",
      start: { kind: "date", value: "20261127" }, end: { kind: "date", value: "20261128" },
    };
    await old.putLocal("calendar_outbox", "original", { key: "original", v: 1, at: 1, n: 0, act });
    old.close();
    const keep = async (owner: string, rows: readonly { type: string; id: string }[]) => {
      for (const row of rows) keeperOf(owner).set(row.type + ":" + row.id, {
        type: row.type, id: row.id, json: JSON.stringify(row),
      });
      return true;
    };
    await expect(prepareCalendarCopies(undefined, async () => false)).rejects.toThrow();
    await prepareCalendarCopies(undefined, keep);
    const saved = keeperOf(scope).get("calendar_outbox:original");
    expect(saved && JSON.parse(saved.json).entity).toMatchObject({ key: "original", act, needsReview: true });
  });

  it("still takes the ordinary snapshot and syncs mail in the mail app", async () => {
    const { open, paths } = fixture();
    const phone = open("ohmail");
    try {
      await phone.engine.start();
      expect(paths[0]?.pathname).toBe("/sync/snapshot");
      expect(paths[0]?.searchParams.get("phase")).toBeNull();
      expect(phone.store.get("message", "letter")).toEqual(mail[0]?.entity);
      expect(phone.store.get("draft", "draft")).toEqual(mail[1]?.entity);
      expect(phone.store.getCursor()).toBe("4");
      expect(phone.engine.serverSearchAvailable()).toBe(true);
    } finally {
      phone.close();
    }
  });
});
