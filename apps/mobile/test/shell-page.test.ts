/**
 * THE SHELL'S PAGE: its engine's transport, its account rule and its answer to the host contract.
 * The transport posts root-relative paths only; the account rule refuses a feed page that names
 * another account and leaves every other capability the bare adapter's; `phoneHost` answers each of
 * its four settings as the plan's table does, held whole, so a flipped answer is red by its key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter } from "@ohmail/client-engine";
import { setStorageOwner, storageOwnerState } from "@ohmail/app-logic/storage/storage-owner";
import { CANNOT, NONE, type DeviceNotifications, type HostContract } from "@ohmail/app/host";
import type { ShellSetting } from "../src/shell/bridge-kinds";
import { AccountMismatch, accountGuarded } from "../web/src/account-guard";
import { BENCH_MARKER, benchDoor } from "../web/src/bench";
import { createBridge } from "../web/src/bridge";
import { bridgeFetch } from "../web/src/bridge-fetch";
import { PHONE_PLACES, PHONE_STAGES, phoneFrameSupplies } from "../web/src/frame-supplies";
import { phoneHost, type PhoneSupplies } from "../web/src/host";
import { ownStorage, StorageNotOwned } from "../web/src/owner";
import type { PagePort } from "../web/src/port";
import { onlineEvents } from "../web/src/signals";

/** A native double that answers every `http` request with `reply` and records what it was asked. */
function nativeAnswering(reply: (req: Record<string, unknown>) => object) {
  const asked: Record<string, unknown>[] = [];
  let take: ((t: string) => void) | null = null;
  const port: PagePort = {
    post(text) {
      const m = JSON.parse(text) as Record<string, unknown>;
      asked.push(m);
      queueMicrotask(() => take?.(JSON.stringify({ ...reply(m), id: m.id, epoch: m.epoch, ok: true })));
    },
    listen(t) {
      take = t;
      return () => { take = null; };
    },
  };
  return { port, asked };
}

const page = (accountId: string, id: string) => ({
  changes: { creates: [{ type: "message", id, seq: 1, entity: { id, accountId, subject: "s" } }], updates: [], deletes: [], moves: [] },
  next: "1", hasMore: false,
});

describe("the page's transport", () => {
  it("posts a root-relative path as the bridge's http kind and reads the answer back", async () => {
    const native = nativeAnswering(() => ({ status: 200, headers: [["content-type", "application/json"]], body: { as: "text", text: "{\"a\":1}" } }));
    const fetch = bridgeFetch(createBridge(native.port, "e1"), "p0");
    const res = await fetch("/mailboxes?counts=1", { method: "GET", headers: { accept: "application/json" } });
    expect(await res.json()).toEqual({ a: 1 });
    expect(native.asked[0]).toMatchObject({ kind: "http", scope: "p0", method: "GET", path: "/mailboxes?counts=1", headers: [["accept", "application/json"]] });
  });

  it("refuses an address before anything is posted", async () => {
    const native = nativeAnswering(() => ({}));
    const fetch = bridgeFetch(createBridge(native.port, "e1"), "p0");
    await expect(fetch("https://elsewhere.example/sync")).rejects.toThrow(/root-relative/);
    await expect(fetch("//elsewhere.example/sync")).rejects.toThrow(/root-relative/);
    expect(native.asked).toHaveLength(0);
  });
});

describe("the account rule on the page's engine", () => {
  it("refuses a feed page that names another account, and passes this account's", async () => {
    const native = nativeAnswering((m) => ({
      status: 200, headers: [["content-type", "application/json"]],
      body: { as: "text", text: JSON.stringify(String(m.path).includes("since=1") ? page("acct-2", "m2") : page("acct-1", "m1")) },
    }));
    const adapter = new HttpAdapter({ baseUrl: "", fetch: bridgeFetch(createBridge(native.port, "e1"), "p0"), getCookie: () => null });
    const guarded = accountGuarded(adapter, "acct-1");
    await expect(guarded.sync({ since: "0" })).resolves.toBeTruthy();
    await expect(guarded.sync({ since: "1" })).rejects.toBeInstanceOf(AccountMismatch);
  });

  it("leaves every other capability the bare adapter's", () => {
    const bare = new HttpAdapter({ baseUrl: "", fetch: async () => new Response(null), forwardPartsCheck: true, scheduleFilesCheck: true });
    const guarded = accountGuarded(bare, "acct-1");
    const names = new Set<string>();
    for (let o: object | null = bare; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    }
    for (const n of names) {
      const b = (bare as unknown as Record<string, unknown>)[n];
      const g = (guarded as unknown as Record<string, unknown>)[n];
      expect(typeof g, n).toBe(typeof b);
      expect(n in guarded, n).toBe(n in bare);
    }
    expect(names.has("requestPull") && names.has("forwardPartsAnnounced") && names.has("listTrash")).toBe(true);
  });
});

describe("the phone shell's answers, per setting", () => {
  const named = <T,>(name: string) => ({ named: name }) as unknown as T;
  const has: PhoneSupplies = {
    signOut: named("signOut"),
    notifications: named<DeviceNotifications>("notifications"),
    frame: {
      places: named("places"), stages: named("stages"), address: named("address"), window: named("window"),
      appearance: named("appearance"), recover: named("recover"),
    },
    signals: {
      linkIn: named("linkIn"), posture: named("posture"), insets: named("insets"), keyboard: named("keyboard"),
      back: named("back"), wake: named("wake"),
    },
  };
  const engine = named<HostContract["engine"]>("engine");
  const of = (setting: ShellSetting) =>
    phoneHost(engine, {
      setting, scope: "p0123456789abcdef0123456789abcdef", accountId: "acct-1", build: { version: "2.0.0", commit: "abc" },
    }, has);
  const NO_WIRE = Object.fromEntries([
    "organizerNotice", "gapLetters", "liveBody", "away", "profileImport", "consent", "images", "olderBody", "junk", "trash",
    "suggest", "draftReply", "firstRun", "screening", "autoFiled", "seedReview", "folderSummary", "ownModelAutoSuggest", "mailboxes",
  ].map((w) => [w, NONE]));
  const NO_FEATURE = {
    ...Object.fromEntries([
      "account", "mailboxes", "ai", "subscription", "storage", "storageCard", "accountStrip", "invites", "security", "about",
      "desktop", "devices", "defaultMail", "stageCard", "screener", "help",
    ].map((f) => [f, NONE])),
    places: has.frame.places,
    stages: has.frame.stages,
  };
  const DEVICE = {
    build: { surface: "phone", version: "2.0.0", commit: "abc", mailtoLeaves: true },
    notifications: has.notifications,
    badge: NONE, language: NONE, openLink: NONE, pickFile: NONE, saveFile: NONE, defaultMail: NONE,
    address: has.frame.address, window: has.frame.window, appearance: has.frame.appearance,
    textSize: NONE, fold: NONE, liveTheme: NONE,
  };
  const SIGNALS = {
    hostConnection: NONE, sessionState: NONE, copyAge: NONE, access: NONE, updateOffer: NONE, droppedFiles: NONE,
    ...has.signals,
  };
  const capabilities = (service: string, unsubscribeFrom: string, account: string) => ({
    ...CANNOT, service, rulesMarked: true, unsubscribeFrom, account, language: "install",
  });

  const table: [ShellSetting, object][] = [
    ["managed", { session: { state: "live", account: "acct-1", signOut: has.signOut }, capabilities: capabilities("managed", "service", "signOutOnly") }],
    ["selfHosted", { session: { state: "live", account: "acct-1", signOut: has.signOut }, capabilities: capabilities("self", "service", "signOutOnly") }],
    ["desktopHost", { session: { state: NONE, account: null, signOut: has.signOut }, capabilities: capabilities("ownComputer", "computer", "signOutOnly") }],
    ["standalone", { session: { state: NONE, account: null, signOut: NONE }, capabilities: capabilities("ownComputer", "computer", NONE) }],
  ];
  for (const [setting, want] of table) {
    it(`answers the whole record on ${setting}`, () => {
      const w = want as { session: { state: string; account: string | null; signOut: unknown }; capabilities: object };
      expect(of(setting)).toEqual({
        engine,
        session: {
          resolve: NONE, confirmed: NONE, state: w.session.state, scope: "p0123456789abcdef0123456789abcdef",
          account: w.session.account, signOut: w.session.signOut, recover: has.frame.recover,
        },
        reads: { mailboxes: NONE, copyAge: NONE, access: NONE },
        wires: NO_WIRE,
        capabilities: w.capabilities,
        features: NO_FEATURE,
        device: DEVICE,
        signals: SIGNALS,
      });
    });
  }
});

describe("what the page hands the frame", () => {
  /** A window with an address bar: a fragment, its history, and its `hashchange`. */
  function windowWith(hash: string) {
    const listeners = new Set<() => void>();
    let at = hash;
    const announce = () => { for (const l of [...listeners]) l(); };
    const win = {
      location: { get hash() { return at; }, set hash(next: string) { at = next; announce(); } },
      history: { state: null, replaceState: (_s: unknown, _t: string, next: string) => { at = next; } },
      dispatchEvent: () => { announce(); return true; },
      addEventListener: (_t: string, l: () => void) => listeners.add(l),
      removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
      innerWidth: 412, innerHeight: 915,
    };
    return win as unknown as Window;
  }

  it("puts the address back where native kept it, then tells native each place it moves to, once", () => {
    const told: string[] = [];
    const win = windowWith("");
    const frame = phoneFrameSupplies("#/news", (f) => told.push(f), win);
    expect(frame.address.read()).toBe("#/news");
    expect(told).toEqual([]);
    frame.address.write("#/ohbox", "push");
    frame.address.write("#/ohbox", "push");
    frame.address.write("#/ohbox/m/42", "replace");
    expect(told).toEqual(["#/ohbox", "#/ohbox/m/42"]);
  });

  it("mounts no place and no stage, and offers no way back of its own", () => {
    const frame = phoneFrameSupplies(null, () => {}, windowWith(""));
    expect(Object.values(PHONE_PLACES).every((p) => p === NONE)).toBe(true);
    expect(Object.values(PHONE_STAGES).every((s) => s === NONE)).toBe(true);
    expect(frame.places).toBe(PHONE_PLACES);
    expect(frame.recover).toBe(NONE);
    expect(frame.address.read()).toBe("");
  });

  it("tells the sync loop only of a return to the network", () => {
    let online = false;
    const changed = new Set<() => void>();
    const signal = { read: () => online, subscribe: (c: () => void) => (changed.add(c), () => changed.delete(c)) };
    const set = (next: boolean) => { online = next; for (const c of [...changed]) c(); };
    const events = onlineEvents(signal);
    let told = 0;
    const listener = () => { told += 1; };
    events.addEventListener("online", listener);
    set(false);
    set(true);
    set(true);
    set(false);
    set(true);
    expect(told).toBe(2);
    events.removeEventListener("online", listener);
    set(false);
    set(true);
    expect(told).toBe(2);
  });
});

describe("the page's storage", () => {
  const scope = "p0123456789abcdef0123456789abcdef";
  afterEach(() => {
    vi.unstubAllGlobals();
    setStorageOwner(null);
  });

  it("is the scope's, as the host's answer, read back before anything mounts", () => {
    ownStorage(scope);
    expect(storageOwnerState()).toMatchObject({ owner: scope, source: "host" });
  });

  it("refuses the mount when a cookie names another owner, or the scope is not id-shaped", () => {
    vi.stubGlobal("document", { cookie: "tf_owner=acct-other" });
    expect(() => ownStorage(scope)).toThrow(StorageNotOwned);
    vi.unstubAllGlobals();
    expect(() => ownStorage("p:not/shaped")).toThrow(StorageNotOwned);
  });
});

describe("the bench's door", () => {
  it("types into kept families only, queues a send as Send does, and reads counts", async () => {
    const storage = new Map<string, string>();
    const kv = {
      get length() { return storage.size; },
      key: (i: number) => [...storage.keys()][i] ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    };
    const sent: unknown[] = [];
    const engine = { mutate: async (m: unknown) => (sent.push(m), { status: "queued" }) } as unknown as Parameters<typeof benchDoor>[0];
    const store = { entries: (type: string) => (type === "outbox_entry" ? [{ id: "o1" }, { id: "o2" }] : []) } as unknown as Parameters<typeof benchDoor>[1];
    const door = benchDoor(engine, store, kv);
    door.words("ohmail.ui.compose.p0", "half a letter");
    expect(() => door.words("ohmail.ui.theme", "dark")).toThrow(/kept family/);
    storage.set("ohmail.ui.theme", "dark");
    expect(await door.send({ to: ["a@example.com"], subject: "s", body: "b", mailboxId: "mb1" })).toBe("queued");
    expect(sent).toEqual([{
      kind: "mail_send", inReplyTo: null, body: "b", subject: "s", mailboxId: "mb1", to: [{ name: null, address: "a@example.com" }],
    }]);
    expect(door.counts()).toEqual({ outbox: 2, words: 1 });
    expect(door.marker).toBe(BENCH_MARKER);
  });
});
