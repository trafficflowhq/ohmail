/** @vitest-environment jsdom */
/**
 * THE SERVERS PANE IS NEVER A DEAD END, rendered. After a pairing ends (Forget, or a revoke from the
 * web that removes the phone's copy) the phone held its own mailbox and nothing else open: the gate
 * held the phone on this pane, so the bar's Back popped onto the tabs and their gate sent it straight
 * back, and a cold start found no active row and opened on the pane with no Back and no dock. The
 * pane's Back opens this phone's own mailbox where there is one, else a pairing still stored (the
 * first-run door only when nothing is left), and a
 * launch whose active row is gone opens that mailbox instead of the pane.
 *
 * The keystore is the real profile store and the removal the real Forget ceremony; the router is a
 * stack, with the tabs' gate redirecting the way `Gated` does.
 */
import { createElement as h, type ReactNode } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./_rendered-dom";

const scene = vi.hoisted(() => ({
  conn: null as unknown,
  stack: [] as string[],
  store: null as unknown,
  deps: null as unknown,
  connects: [] as string[],
  /* The system Back's listeners, newest first answering, as React Native runs them. */
  backs: [] as (() => boolean)[],
  focused: true,
  options: null as null | { gestureEnabled?: boolean },
  nav: "dock" as "dock" | "rail",
  path: "/servers",
}));

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  BackHandler: {
    addEventListener: (_e: string, fn: () => boolean) => {
      scene.backs.unshift(fn);
      return { remove: () => void scene.backs.splice(scene.backs.indexOf(fn), 1) };
    },
  },
}));
vi.mock("expo-router", () => ({
  router: {
    canGoBack: () => scene.stack.length > 1,
    back: () => void scene.stack.pop(),
    replace: (to: string) => void scene.stack.splice(-1, 1, to),
    push: (to: string) => void scene.stack.push(to),
    navigate: (to: string) => void scene.stack.push(to),
  },
  useIsFocused: () => scene.focused,
  usePathname: () => scene.path,
  Stack: { Screen: (p: { options?: { gestureEnabled?: boolean } }) => { scene.options = p.options ?? null; return null; } },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-crypto", () => ({}));
vi.mock("react-native-svg", () => ({ default: () => null, Defs: () => null, LinearGradient: () => null, Rect: () => null, Stop: () => null }));
vi.mock("react-native-reanimated", () => ({ default: { View: () => null } }));
vi.mock("../src/state/servers-native", () => ({
  nativeServerProfiles: () => scene.store, nativeFamilyDigest: async () => "", secureKV: () => null,
}));
vi.mock("../src/engine/native", () => ({ nativeEngineDeps: () => scene.deps }));
vi.mock("../src/net/pairing", async (original) => ({
  ...((await original()) as object),
  /* The launch's connect is recorded and held open: what is asserted is which row the launch opens. */
  connectProfileById: (_env: unknown, id: string) => { scene.connects.push(id); return new Promise(() => undefined); },
}));
/* The pane reads the connection it is handed; the cold start reads the real provider's. */
vi.mock("../src/net/connection", async (original) => {
  const real = (await original()) as { useConnection: () => unknown };
  return { ...real, useConnection: () => scene.conn ?? real.useConnection() };
});
vi.mock("../src/theme", () => ({ useTheme: () => ({ c: { accent: "#000", ink2: "#000", ink3: "#000" }, radius: { dot: 1 }, zLayer: { tabBar: 1 } }) }));
vi.mock("../src/ui/base", () => {
  const div = (p: { children?: ReactNode }) => h("div", null, p.children);
  return {
    Button: (p: { label: string; onPress?: () => void }) => h("button", { "data-button": p.label, onClick: p.onPress }, p.label),
    Tap: (p: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) =>
      h("button", { "data-button": p.accessibilityLabel, onClick: p.onPress }, p.children),
    Txt: (p: { children?: ReactNode }) => h("span", null, p.children),
    Panel: div, Screen: div, Scroller: div, Section: div, TapRow: div,
    useTopPad: () => 0,
  };
});
vi.mock("../src/ui/posture", () => ({
  usePosture: () => null, useAppWindow: () => ({ width: 0, height: 0 }), useStatusCluster: () => null,
}));
vi.mock("../src/ui/scaffold/plan", async (original) => ({
  ...((await original()) as object),
  scaffoldPlan: () => ({ nav: scene.nav, railCarriesReaderVerbs: false }),
  railHome: () => ({ top: 0, bottom: 0, x: 0, width: 62 }),
}));
/* The rail's buttons, pressable by label. */
vi.mock("../src/ui/glass", () => ({
  GlassRail: (p: { groups: { id: string; label: string; onPress: () => void }[][] }) =>
    h("div", null, p.groups.flat().map((a) => h("button", { key: a.id, "data-button": a.label, onClick: a.onPress }, a.label))),
}));
vi.mock("../src/state/world", () => ({
  useWorld: () => ({ ohbox: { unread: 0 }, screener: { waiting: [] }, reads: { newCount: 0 }, receipts: { newCount: 0 } }),
}));
vi.mock("../src/ui/UnsavedChanges", () => ({ UnsavedChanges: () => null }));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/ui/Doors", () => ({ Doors: () => null }));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/ErrorBoundary", () => ({ SurfaceBoundary: (p: { children?: ReactNode }) => p.children }));

import ServersScreen from "../app/servers";
import { NavRail } from "../src/ui/nav-rail";
import { NavDrawnContext } from "../src/ui/nav-drawn";
import { EN } from "../src/copy.en";
import { LOCAL_ENGINE_ORIGIN, type MobileEngineDeps } from "../src/engine/boot";
import { ConnectionProvider, useConnection, type ConnectionState } from "../src/net/connection";
import { forgetProfile, type PairingEnv } from "../src/net/pairing";
import { deathRefusal } from "../src/net/session-death";
import { gateFor } from "../src/state/gate";
import { settleInstallGeneration } from "../src/state/install-marker";
import { ServerProfileStore, type SecureKV, type ServerProfile } from "../src/state/servers";
import { sqlWorld } from "./helpers/pair-server";

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v), remove: async (k) => void map.delete(k) };
}

type Removal = (env: PairingEnv, id: string) => Promise<unknown>;

/**
 * A phone holding its own mailbox and a pairing, the pairing open (the last thing it opened), then
 * the pairing removed as each shape removes it (`connection.tsx`). The keystore survives into the
 * cold start.
 */
async function phoneAfterThePairingEnded(opts: { ownMailbox: boolean; remove: Removal | null; another?: boolean }) {
  const kv = memoryKV();
  const world = sqlWorld();
  const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000" };
  const profiles = new ServerProfileStore(kv);
  /* The install that stored the rows, stamped first, as the first launch does. */
  await settleInstallGeneration(deps, profiles);
  const here = opts.ownMailbox
    ? await profiles.addStandalone({ origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account" })
    : null;
  const other = opts.another
    ? await profiles.add({ origin: "https://home.example", flavor: "selfhosted", accountId: "acct-b", refreshToken: "rt-b" })
    : null;
  const paired = await profiles.add({ origin: "https://cloud.example", flavor: "managed", accountId: "acct-a", refreshToken: "rt" });
  if (opts.remove !== null) await opts.remove({ profiles, engineDeps: deps }, paired.id);
  return { kv, deps, here, other, paired, rows: await profiles.list(), activeId: (await profiles.active())?.id ?? null };
}

/** The two shapes: the Forget verb (its sign-out told), and the revoke's removal of the copy. */
const SHAPES: { name: string; state: ConnectionState; remove: Removal }[] = [
  { name: "Forget", state: { k: "idle" }, remove: (env, id) => forgetProfile(env, id, { revoke: async () => true }) },
  {
    name: "a revoke from the web",
    state: { k: "ended", reason: deathRefusal("revoked") },
    remove: (env, id) => forgetProfile(env, id, { closed: Promise.resolve(), revoke: async () => true }),
  },
];
const [FORGET, REVOKE] = SHAPES as [(typeof SHAPES)[number], (typeof SHAPES)[number]];

/** A live engine with nothing in it, for the pane's live numbers. */
const QUIET = { subscribe: () => () => undefined, read: () => ({ version: () => 0, list: () => [] }) };

/** The connection as the pane reads it; a switch connects (the first state `runConnect` enters). */
function connection(state: ConnectionState, rows: ServerProfile[], activeId: string | null) {
  const switches: string[] = [];
  scene.conn = {
    state, profiles: rows, activeId, syncing: false, syncError: null,
    unsentDraftsHere: () => null,
    forget: async () => ({ ok: true }),
    switchTo: async (id: string) => {
      switches.push(id);
      scene.conn = { ...(scene.conn as object), state: { k: "connecting", origin: LOCAL_ENGINE_ORIGIN } };
      return { ok: true };
    },
  };
  return switches;
}

/** What the tabs' gate does with the screen it is handed: a held phone goes back to the pane. */
function gateRedirects(): void {
  const c = scene.conn as { state: ConnectionState; profiles: ServerProfile[] };
  if (scene.stack.at(-1) === "/" && gateFor(c.state, c.profiles.length).to === "servers") scene.stack.splice(-1, 1, "/servers");
}

/** The root's reading of whether the dock and rail are drawn. */
const navDrawnFor = (state: ConnectionState, count: number) => gateFor(state, count).to === "mail";

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

async function pressBack(el: HTMLElement): Promise<void> {
  const back = el.querySelector(`[data-button="${EN.back}"]`) as HTMLButtonElement | null;
  expect(back, "the pane offers no Back").not.toBeNull();
  act(() => back!.click());
  await settle();
  gateRedirects();
}

/** Android's system Back: the newest listener that takes it answers; none taking it pops the stack. */
async function systemBack(): Promise<boolean> {
  const taken = scene.backs.some((fn) => fn());
  if (!taken) scene.stack.pop();
  await settle();
  gateRedirects();
  return taken;
}

afterEach(() => {
  scene.conn = null; scene.stack.splice(0); scene.connects.splice(0); scene.backs.splice(0);
  scene.focused = true; scene.options = null; scene.nav = "dock";
  document.body.innerHTML = "";
});

describe("Back from the pane after a pairing ended", () => {
  for (const shape of SHAPES) {
    it(`${shape.name}, opened from the mailbox: Back opens this phone's own mailbox`, async () => {
      const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: shape.remove });
      const switches = connection(shape.state, phone.rows, phone.activeId);
      scene.stack.push("/", "/servers");
      const view = mount(h(ServersScreen));
      await pressBack(view.el);
      expect({ switches, at: scene.stack.at(-1), backs: view.el.querySelectorAll(`[data-button="${EN.back}"]`).length })
        .toEqual({ switches: [phone.here!.id], at: "/", backs: 1 });
      view.unmount();
    });

    it(`${shape.name}, landed on with no stack: the same Back`, async () => {
      const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: shape.remove });
      const switches = connection(shape.state, phone.rows, phone.activeId);
      scene.stack.push("/servers");
      const view = mount(h(ServersScreen));
      await pressBack(view.el);
      expect({ switches, at: scene.stack.at(-1) }).toEqual({ switches: [phone.here!.id], at: "/" });
      view.unmount();
    });
  }

  it("with no mailbox of its own, Back goes to the first-run door", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: false, remove: REVOKE.remove });
    const switches = connection(REVOKE.state, phone.rows, phone.activeId);
    scene.stack.push("/", "/servers");
    const view = mount(h(ServersScreen));
    await pressBack(view.el);
    expect({ switches, stack: scene.stack }).toEqual({ switches: [], stack: ["/", "/welcome"] });
    view.unmount();
  });

  it("with no mailbox of its own but another pairing left, Back opens that pairing", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: false, another: true, remove: REVOKE.remove });
    for (const start of [["/", "/servers"], ["/servers"]]) {
      const switches = connection(REVOKE.state, phone.rows, phone.activeId);
      scene.stack.splice(0, scene.stack.length, ...start);
      const view = mount(h(ServersScreen));
      await pressBack(view.el);
      expect({ switches, at: scene.stack.at(-1) }).toEqual({ switches: [phone.other!.id], at: "/" });
      view.unmount();
    }
  });

  it("Disconnect on the only pairing: Back reconnects it, never the first-run door", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: false, remove: null });
    const switches = connection({ k: "idle" }, phone.rows, phone.paired.id);
    scene.stack.push("/", "/settings", "/servers");
    const view = mount(h(ServersScreen));
    await pressBack(view.el);
    expect({ switches, stack: scene.stack }).toEqual({ switches: [phone.paired.id], stack: ["/", "/settings", "/"] });
    view.unmount();
  });

  it("a switch the pairing refuses keeps the pane", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: false, remove: null });
    const switches = connection({ k: "idle" }, phone.rows, phone.paired.id);
    (scene.conn as { switchTo: unknown }).switchTo = async (id: string) => { switches.push(id); return { ok: false, reason: deathRefusal("revoked") }; };
    scene.stack.push("/servers");
    const view = mount(h(ServersScreen));
    await pressBack(view.el);
    expect({ switches, stack: scene.stack }).toEqual({ switches: [phone.paired.id], stack: ["/servers"] });
    view.unmount();
  });

  it("the only pairing left lost its credential: Back skips it for the first-run door", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: false, remove: null });
    const ended = phone.rows.map((r) => ({ ...r, refreshToken: null }));
    const switches = connection(REVOKE.state, ended, phone.paired.id);
    scene.stack.push("/servers");
    const view = mount(h(ServersScreen));
    await pressBack(view.el);
    expect({ switches, stack: scene.stack }).toEqual({ switches: [], stack: ["/welcome"] });
    view.unmount();
  });

  it("a pairing that lost its credential is passed over for one that keeps it, the active mark too", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: false, another: true, remove: null });
    const rows = phone.rows.map((r) => (r.id === phone.paired.id ? { ...r, refreshToken: null } : r));
    const switches = connection(REVOKE.state, rows, phone.paired.id);
    scene.stack.push("/servers");
    const view = mount(h(ServersScreen));
    await pressBack(view.el);
    expect({ switches, at: scene.stack.at(-1) }).toEqual({ switches: [phone.other!.id], at: "/" });
    view.unmount();
  });

  for (const shape of SHAPES) {
    it(`${shape.name}: Android's system Back runs the same way out, from the mailbox and with no stack`, async () => {
      const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: shape.remove });
      for (const start of [["/", "/servers"], ["/servers"]]) {
        const switches = connection(shape.state, phone.rows, phone.activeId);
        scene.stack.splice(0, scene.stack.length, ...start);
        const view = mount(h(ServersScreen));
        const taken = await systemBack();
        expect({ taken, switches, at: scene.stack.at(-1) }).toEqual({ taken: true, switches: [phone.here!.id], at: "/" });
        view.unmount();
      }
    });
  }

  it("a held pane takes iOS's edge swipe away (it would pop into the same redirect); a live one keeps it", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: REVOKE.remove });
    connection(REVOKE.state, phone.rows, phone.activeId);
    scene.stack.push("/", "/servers");
    const held = mount(h(ServersScreen));
    expect(scene.options?.gestureEnabled).toBe(false);
    held.unmount();
    connection({ k: "live", session: { profile: phone.here!, engine: QUIET } } as unknown as ConnectionState, phone.rows, phone.here!.id);
    const live = mount(h(ServersScreen));
    expect(scene.options?.gestureEnabled).toBe(true);
    live.unmount();
  });

  it("CONTROL: the system Back is the screen in front's: a pane under another screen, or a live one, leaves it to the stack", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: REVOKE.remove });
    const switches = connection(REVOKE.state, phone.rows, phone.activeId);
    scene.focused = false;
    scene.stack.push("/servers", "/scan");
    const under = mount(h(ServersScreen));
    expect({ taken: await systemBack(), switches, stack: scene.stack }).toEqual({ taken: false, switches: [], stack: ["/servers"] });
    under.unmount();
    scene.focused = true;
    connection({ k: "live", session: { profile: phone.here!, engine: QUIET } } as unknown as ConnectionState, phone.rows, phone.here!.id);
    scene.stack.splice(0, scene.stack.length, "/", "/servers");
    const live = mount(h(ServersScreen));
    expect({ taken: await systemBack(), stack: scene.stack }).toEqual({ taken: false, stack: ["/"] });
    live.unmount();
  });

  it("on a rail posture a held pane shows one Back, and it is the way out", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: REVOKE.remove });
    const switches = connection(REVOKE.state, phone.rows, phone.activeId);
    scene.nav = "rail";
    scene.stack.push("/", "/servers");
    const c = scene.conn as { state: ConnectionState; profiles: ServerProfile[] };
    /* The root's own frame: the drawn flag as the root derives it (`app/_layout.tsx`), the pane and the rail beside it. */
    const view = mount(h(NavDrawnContext.Provider, { value: navDrawnFor(c.state, c.profiles.length) }, h(ServersScreen), h(NavRail)));
    expect(view.el.querySelectorAll(`[data-button="${EN.back}"]`).length).toBe(1);
    await pressBack(view.el);
    expect({ switches, at: scene.stack.at(-1) }).toEqual({ switches: [phone.here!.id], at: "/" });
    view.unmount();
  });

  it("CONTROL: on a rail posture with a mailbox open the rail carries Back and the bar yields it", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: FORGET.remove });
    const live = { k: "live", session: { profile: phone.here!, engine: QUIET } } as unknown as ConnectionState;
    connection(live, phone.rows, phone.here!.id);
    scene.nav = "rail";
    scene.stack.push("/", "/servers");
    const view = mount(h(NavDrawnContext.Provider, { value: navDrawnFor(live, phone.rows.length) }, h(ServersScreen), h(NavRail)));
    expect(view.el.querySelectorAll(`[data-button="${EN.back}"]`).length).toBe(1);
    await pressBack(view.el);
    expect(scene.stack).toEqual(["/"]);
    view.unmount();
  });

  it("CONTROL: with a mailbox open, Back pops", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: FORGET.remove });
    const live = { k: "live", session: { profile: phone.here!, engine: QUIET } } as unknown as ConnectionState;
    const switches = connection(live, phone.rows, phone.here!.id);
    scene.stack.push("/", "/servers");
    const view = mount(h(ServersScreen));
    await pressBack(view.el);
    expect({ switches, stack: scene.stack }).toEqual({ switches: [], stack: ["/"] });
    view.unmount();
  });
});

describe("the cold start after a pairing ended", () => {
  /** A fresh provider over the same keystore: the app's launch, read back through `useConnection`. */
  async function coldStart(phone: Awaited<ReturnType<typeof phoneAfterThePairingEnded>>) {
    scene.store = new ServerProfileStore(phone.kv);
    scene.deps = phone.deps;
    const seen: { state: ConnectionState; count: number }[] = [];
    function Probe() {
      const conn = useConnection();
      seen.push({ state: conn.state, count: conn.profiles.length });
      return null;
    }
    const view = mount(h(ConnectionProvider, null, h(Probe)));
    await settle();
    const last = seen.at(-1)!;
    const active = await (scene.store as ServerProfileStore).active();
    view.unmount();
    return { gate: gateFor(last.state, last.count).to, active: active?.id ?? null, connects: [...scene.connects] };
  }

  for (const shape of SHAPES) {
    it(`${shape.name}: the launch opens this phone's own mailbox, never the pane`, async () => {
      const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: shape.remove });
      expect(await coldStart(phone)).toEqual({ gate: "connecting", active: phone.here!.id, connects: [phone.here!.id] });
    });
  }

  it("CONTROL: a row still marked active is the one the launch opens", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: true, remove: null });
    expect(await coldStart(phone)).toEqual({ gate: "connecting", active: phone.paired.id, connects: [phone.paired.id] });
  });

  it("CONTROL: nothing left on the phone is the first-run door", async () => {
    const phone = await phoneAfterThePairingEnded({ ownMailbox: false, remove: REVOKE.remove });
    expect(await coldStart(phone)).toEqual({ gate: "welcome", active: null, connects: [] });
  });
});
