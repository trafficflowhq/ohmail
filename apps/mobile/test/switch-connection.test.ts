/** @vitest-environment jsdom */
/**
 * THE SWITCH'S RECEIVING SIDE, WIRED INTO THE CONNECTION LAYER, rendered: the real provider over a real profile store
 * and a loopback server, the calendar's app as native names it, and native's switch as a double. An arrival is taken
 * up only once the launch order has finished; a signed-out app spends the sibling's code and goes live on the shell
 * through the provider's own transition; its provider's note of live pairings is written at the launch and again
 * after; the place waits for the page of the session it was judged in. A launch that stopped on the install's
 * verdict takes nothing up.
 */
import { createHash } from "node:crypto";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";

const scene = await vi.hoisted(async () => {
  const { createHash: digest } = await import("node:crypto");
  const hash = (text: string) => digest("sha256").update(text).digest("base64url");
  const state = {
    store: null as unknown,
    deps: null as unknown,
    shell: undefined as unknown,
    arrival: null as Record<string, string> | null,
    pending: null as { challenge: string; verifier: string } | null,
    notes: [] as string[][],
    takes: 0,
    announce: () => {},
  };
  const native = {
    appId: "app.ohcal.preview",
    otherState: () => "here",
    open: async () => true,
    openStore: async () => false,
    takeArrival: async () => {
      state.takes += 1;
      const a = state.arrival;
      state.arrival = null;
      return a;
    },
    takeVerifier: async (challenge: string) => {
      const p = state.pending;
      state.pending = null;
      return p !== null && p.challenge === challenge ? { verifier: p.verifier } : null;
    },
    askSibling: async () => null,
    notePairings: async (digests: string[]) => (state.notes.push([...digests]), true),
    addListener: (_event: string, listener: () => void) => {
      state.announce = listener;
      return { remove: () => { state.announce = () => {}; } };
    },
  };
  return { state, native, hash };
});

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: "android", select: (o: Record<string, unknown>) => o.android ?? o.default },
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: (name: string) => (name === "OhmailSwitch" ? scene.native : null) }));
vi.mock("expo-crypto", () => ({}));
vi.mock("../src/variant-native", async () => {
  const { appOfNative } = await import("../src/variant");
  return { get APP() { return appOfNative(scene.native.appId); } };
});
vi.mock("../src/state/servers-native", () => ({
  nativeServerProfiles: () => scene.state.store,
  nativeFamilyDigest: async (text: string) => scene.hash(text),
  secureKV: () => null,
}));
vi.mock("../src/engine/native", () => ({ nativeEngineDeps: () => scene.state.deps }));
vi.mock("../src/shell/shell-stores-native", () => ({ nativeShellStores: () => scene.state.shell }));

import { mirrorDbName, pairLink, SqlMirrorStore } from "@ohmail/client-engine";
import { LOCAL_ENGINE_ORIGIN, mirrorOwnerKey, type MobileEngineDeps } from "../src/engine/boot";
import type { StandaloneEngine } from "../src/engine/standalone-door";
import { ConnectionProvider, useConnection, type Connection, type ConnectionState } from "../src/net/connection";
import { refuse } from "../src/refusal";
import { INSTALL_MARKER_DB, settleInstallGeneration } from "../src/state/install-marker";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { switchPlaces } from "../src/switch/receive";
import { listen, pairServer, sqlWorld } from "./helpers/pair-server";

const ID = "0b9f2c1e-7d4a-4c1b-9e3f-5a6b7c8d9e0f";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v), remove: async (k) => void map.delete(k) };
}

/**
 * A phone with nothing paired; its marker database refused where the launch is to stop on the install's verdict.
 * `opened` names every store the phone opened, in order.
 */
function phone(opts: { markerRefused?: boolean } = {}) {
  const world = sqlWorld();
  const opened: string[] = [];
  const deps: MobileEngineDeps = {
    openExecutor: (name) => {
      opened.push(name);
      if (opts.markerRefused === true && name.includes("install")) throw new Error("the marker's store will not open");
      return world.open(name);
    },
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  const store = new ServerProfileStore(memoryKV());
  scene.state.store = store;
  scene.state.deps = deps;
  scene.state.notes = [];
  scene.state.takes = 0;
  return { deps, store, opened, world };
}

/** The provider rendered, its decided states read back through `useConnection`, and the connection itself. */
function launch() {
  const seen: ConnectionState[] = [];
  let connection: Connection | null = null;
  function Probe() {
    connection = useConnection();
    seen.push(connection.state);
    return null;
  }
  const view = mount(h(ConnectionProvider, null, h(Probe)));
  return { seen, view, connection: () => connection! };
}

/** A door of the phone's own engine, as its screen hands one over; nothing of it is driven here. */
function engineDoor(): StandaloneEngine {
  const no = async (): Promise<never> => { throw new Error("not driven by this case"); };
  return {
    accountId: "engine-account", address: "me@example.test", sessionToken: "engine-launch-token",
    handle: no, stop: async () => undefined, log: () => undefined, handBack: no, leave: () => undefined, forgetStoredLogin: no,
    serverSettings: no, resume: no, claimHere: no, heldElsewhere: no, stopOrganizing: no,
    runtimes: () => ({ organizer: {}, connection: {} }),
  };
}

/** Until `done` holds, or the bound passes. */
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

afterEach(() => {
  scene.native.appId = "app.ohcal.preview";
  scene.state.arrival = null;
  scene.state.pending = null;
  scene.state.shell = undefined;
});

describe("the switch's receiving side in the connection layer", () => {
  it("opens store ohcal without advertising pairings or redeeming an arriving code", async () => {
    scene.native.appId = "app.ohcal";
    const fake = pairServer({ flavor: "desktop-host", accountId: "acct-1" });
    const origin = await listen(fake.server);
    phone();
    fake.mintHandoffToken("code-1", CHALLENGE);
    scene.state.arrival = {
      v: "1", k: "open", p: `event:${ID}`, d: scene.hash(`${origin}\nacct-1`), c: CHALLENGE, l: pairLink(origin, "code-1", null),
    };
    scene.state.pending = { challenge: CHALLENGE, verifier: VERIFIER };
    const { seen, view } = launch();
    try {
      await until(() => scene.state.takes > 0);
      expect(scene.state.takes).toBe(1);
      expect(seen.at(-1)?.k).toBe("idle");
      expect(scene.state.notes).toEqual([]);
      expect(scene.state.pending?.challenge).toBe(CHALLENGE);
      expect(fake.seen.some((r) => r.url === "/pair/redeem")).toBe(false);
    } finally {
      view.unmount();
      fake.server.close();
    }
  });

  it("takes the arrival up after the launch order, signs the signed-out app in on the shell, and notes the pairing", async () => {
    const fake = pairServer({ flavor: "desktop-host", accountId: "acct-1", calendarSync: true });
    const origin = await listen(fake.server);
    try {
      fake.addMessage("m-1", "a letter");
      fake.mintHandoffToken("code-1", CHALLENGE);
      phone();
      scene.state.arrival = {
        v: "1", k: "open", p: `event:${ID}`, d: scene.hash(`${origin}\nacct-1`), c: CHALLENGE, l: pairLink(origin, "code-1", null),
      };
      scene.state.pending = { challenge: CHALLENGE, verifier: VERIFIER };
      const { seen, view } = launch();
      await until(() => seen.at(-1)?.k === "shell");
      const last = seen.at(-1)!;
      expect(last.k).toBe("shell");
      if (last.k !== "shell") return;
      expect([last.session.profile.origin, last.session.profile.accountId]).toEqual([origin, "acct-1"]);
      // The launch went to the door first: the arrival waited for its order to finish.
      expect(seen.map((s) => s.k)).toContain("idle");
      expect(fake.seen.some((r) => r.url.startsWith("/calendar/sync/snapshot"))).toBe(true);
      expect(fake.seen.filter((r) => /^\/sync(?:\/|\?|$)/.test(r.url))).toEqual([]);
      expect(fake.seen.filter((r) => r.url === "/pair/redeem").map((r) => JSON.parse(r.body).grant)).toEqual(["app-handoff"]);
      await until(() => scene.state.notes.length >= 2);
      expect(scene.state.notes[0], "the launch's note: no live pairing").toEqual([]);
      expect(scene.state.notes.at(-1)).toEqual([scene.hash(`${origin}\nacct-1`)]);
      expect(switchPlaces.take(last.session.profile.id)).toEqual({ to: "event", id: ID });
      view.unmount();
    } finally {
      fake.server.close();
    }
  });

  it("takes nothing up after a launch that stopped on the install's verdict, however often native announces", async () => {
    phone({ markerRefused: true });
    scene.state.arrival = { v: "1", k: "open", p: "last", d: "A".repeat(43), c: CHALLENGE, l: "https://mail.example.test/pair#x" };
    const { seen, view } = launch();
    await until(() => seen.at(-1)?.k === "refused");
    expect(seen.at(-1)?.k).toBe("refused");
    scene.state.announce();
    await new Promise((r) => setTimeout(r, 50));
    expect(scene.state.takes, "no arrival was taken up").toBe(0);
    view.unmount();
  });
});

describe("the calendar's app never opens the phone's own engine", () => {
  it("erases a confirmed calendar at launch before opening the other keepers for preparation", async () => {
    const { deps, store, world } = phone();
    await settleInstallGeneration(deps, store);
    const profile = await store.add({
      origin: "https://calendar.example.invalid", flavor: "managed", accountId: "erased", refreshToken: "cal.fixture-refresh",
    });
    const owner = mirrorOwnerKey(profile.origin, profile.accountId);
    const dbName = mirrorDbName(owner);
    const old = new SqlMirrorStore({ owner, open: deps.openExecutor });
    await old.load();
    await old.putLocal("calendar", "erased", { name: "Old calendar" });
    old.close();
    await store.markPendingWipe(profile.id, owner, true);
    const keepers = new Map([[owner, "pending edit"], ["other", "independent edit"]]);
    const atPreparation: boolean[] = [];
    let clears = 0;
    scene.state.shell = {
      scopeOf: async (key: string) => key,
      keeperScopes: async () => [...keepers.keys()],
      eraseKeeper: async (scope: string) => { keepers.delete(scope); return true; },
      releaseCalendarErasure: async () => {},
      prepareCalendarKeeper: async () => { atPreparation.push(keepers.has(owner)); return false; },
      calendarCopiesPrepared: () => false,
      waitForCalendarCopies: async () => false,
      clearViewCopies: async () => { clears++; return { listed: false, usage: 0 }; },
    };
    const { seen, view } = launch();
    try {
      await until(() => seen.at(-1)?.k === "refused");
      expect(seen.at(-1)).toEqual({ k: "refused", reason: refuse("calendarCopyRemains") });
      expect(atPreparation).toEqual([false]);
      expect(keepers).toEqual(new Map([["other", "independent edit"]]));
      expect(world.names()).not.toContain(dbName);
      expect(clears).toBe(0);
      expect(await store.pendingWipes()).toEqual([{ id: profile.id, owner, erased: true }]);
    } finally { view.unmount(); }
  });

  it("refuses the standalone door: no store is opened for it and the state never reads connecting", async () => {
    const { opened } = phone();
    const { seen, view, connection } = launch();
    await until(() => seen.at(-1)?.k === "idle");
    expect(seen.at(-1)?.k).toBe("idle");
    const before = opened.length;
    expect(await connection().openStandalone(engineDoor())).toEqual({ ok: false, reason: refuse("notPairedHere") });
    expect(opened.slice(before), "no store opened for the door").toEqual([]);
    expect(seen.map((s) => s.k)).not.toContain("connecting");
    view.unmount();
  });

  it("launches a stored row of the phone's own mailbox to the refusal, opening no store but the install's marker", async () => {
    const { deps, store, opened } = phone();
    // The install that stored the row, stamped first, as its first launch did.
    await settleInstallGeneration(deps, store);
    await store.addStandalone({ origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account" });
    expect((await store.active())?.origin).toBe(LOCAL_ENGINE_ORIGIN);
    opened.length = 0;
    const { seen, view } = launch();
    await until(() => seen.at(-1)?.k === "refused");
    expect(seen.at(-1)).toEqual({ k: "refused", reason: refuse("notPairedHere") });
    expect(opened.filter((name) => name !== INSTALL_MARKER_DB), "no engine's store opened").toEqual([]);
    view.unmount();
  });
});
