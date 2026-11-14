/** @vitest-environment jsdom */
/**
 * THE WAKE REGISTRATION STANDS ONLY WHILE THE MASTER AND NEW MAIL ARE BOTH ON.
 *
 * A wake exists to start a closed app for new mail. With this device's master switch or its new-mail switch off
 * there is nothing a wake could draw, so the registration is taken down where it stands: the row at the server,
 * and this pairing's instance at the distributor. With both on it is made again. The two switches are the
 * page's, so the page says whether the wake is wanted over the bridge (one boolean), and the wake's own provider
 * keeps or removes the registration by it.
 *
 * Two halves, each over the real thing: the page's teller over the real bridge and guard to a native end that
 * records; and the provider itself, rendered, with the server's door and the distributor recorded.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noticeChoicesOf, type NoticeChoices } from "@ohmail/client-engine";
import { BridgeRefused } from "../web/src/bridge";
import { wakeTeller, wakeWanted } from "../web/src/notices";
import { pageOver, phone } from "./helpers/notice-phone";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── the provider's doors, recorded ─────────────────────────────────────────────────────────────── */
const calls = vi.hoisted(() => ({
  registered: [] as string[],
  forgotten: [] as Array<{ profile: string; id: string | null }>,
  chosen: [] as Array<string | null>,
  saved: "dist.example" as string | null,
  conn: { state: { k: "idle" } as { k: string; session?: unknown }, profiles: [{ id: "p-a" }] as unknown[], syncNow: () => Promise.resolve() },
  nextId: 0,
  /** Held registrations, to be answered by the case: one in the air while the page speaks. */
  held: [] as Array<() => void>,
  hold: false,
  /** What native was told to keep as the signed-in pairing, in order. */
  lives: [] as Array<string | null>,
}));

vi.mock("../src/net/connection", () => ({ useConnection: () => calls.conn }));
vi.mock("../src/net/push", () => ({
  NO_DISTRIBUTOR: { available: () => false, register: async () => null, unregister: async () => {} },
  registerWake: async (session: { profile: { id: string } }) => {
    if (calls.hold) await new Promise<void>((answer) => { calls.held.push(answer); });
    calls.registered.push(session.profile.id);
    return { k: "on", id: `row-${++calls.nextId}` };
  },
  forgetWake: async (session: { profile: { id: string } }, _distributor: unknown, id: string | null) => {
    calls.forgotten.push({ profile: session.profile.id, id });
    return { ok: true };
  },
  dropWakeRowOrOwe: async () => ({ ok: true }),
}));
vi.mock("../src/net/unified-push", () => ({
  chooseDistributor: (id: string | null) => { calls.chosen.push(id); calls.saved = id; },
  listDistributors: () => [{ id: "dist.example", label: "A distributor" }],
  onWake: () => () => {},
  requestNotificationPermission: async () => "granted",
  savedDistributor: () => calls.saved,
  unifiedPushDistributor: () => ({ available: () => true, register: async () => null, unregister: async () => {} }),
}));
/* The keeper and its reading of the connection are the real ones; native's keeping is recorded. */
vi.mock("../src/notices/notices-native", () => ({
  noticesNative: () => ({ setLive: async (instance: string | null) => { calls.lives.push(instance); return true; } }),
}));
vi.mock("../src/shell/doors", () => ({ wakeShell: () => {} }));
vi.mock("../src/state/servers-native", () => ({ nativeServerProfiles: () => ({}) }));

const { WakeProvider, useWake } = await import("../src/state/wake");
const { wakeSentence } = await import("../src/ui/wake-sentence");
type Wake = ReturnType<typeof useWake>;

const sessionOf = (id: string) => ({ profile: { id } });
const A = sessionOf("p-a");
const B = sessionOf("p-b");

let root: Root | null = null;
let wake: Wake;
function Probe(): null {
  wake = useWake();
  return null;
}
/** Let the provider's queue of wake mutations run out. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
async function mount(state: { k: string; session?: unknown }): Promise<void> {
  calls.conn = { ...calls.conn, state };
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => { root!.render(createElement(WakeProvider, null, createElement(Probe))); });
  await settled();
}
async function move(state: { k: string; session?: unknown }): Promise<void> {
  calls.conn = { ...calls.conn, state };
  await act(async () => { root!.render(createElement(WakeProvider, null, createElement(Probe))); });
  await settled();
}
const say = async (profile: string, wanted: boolean): Promise<void> => {
  await act(async () => { wake.want(profile, wanted); });
  await settled();
};

beforeEach(() => {
  calls.registered.length = 0;
  calls.forgotten.length = 0;
  calls.chosen.length = 0;
  calls.held.length = 0;
  calls.lives.length = 0;
  calls.hold = false;
  calls.saved = "dist.example";
  calls.nextId = 0;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
});

describe("the wake registration on a phone follows the page's two switches", () => {
  it("nothing is registered for a shell's pairing until its page has said the wake is wanted", async () => {
    await mount({ k: "shell", session: A });
    expect(calls.registered, "a launch registered before the page had read its switches").toEqual([]);
    await say("p-a", true);
    expect(calls.registered).toEqual(["p-a"]);
    expect(wake.state).toEqual({ k: "on", id: "row-1" });
  });

  it("either switch off takes it down at the server and at the distributor; both on makes it again", async () => {
    await mount({ k: "shell", session: A });
    await say("p-a", true);

    await say("p-a", false);
    // The row the server holds, by its id, and this pairing's instance: `forgetWake` takes both, the row first.
    expect(calls.forgotten).toEqual([{ profile: "p-a", id: "row-1" }]);
    expect(wake.state).toEqual({ k: "off", reason: "switched_off" });
    expect(wakeSentence(wake.state, "android")).toContain("switched off on this phone");
    expect(calls.chosen, "the person's choice of a distributor is kept").toEqual([]);
    expect(wake.chosen).toBe("dist.example");

    await say("p-a", true);
    expect(calls.registered).toEqual(["p-a", "p-a"]);
    expect(wake.state).toEqual({ k: "on", id: "row-2" });
    // Said again as it stands: nothing is done twice.
    await say("p-a", true);
    expect(calls.registered).toHaveLength(2);
  });

  it("a phone that starts with a switch off registers nothing, and a distributor chosen then registers nothing either", async () => {
    await mount({ k: "shell", session: A });
    await say("p-a", false);
    expect(calls.registered).toEqual([]);
    await act(async () => { wake.choose("dist.example"); });
    await settled();
    expect(calls.registered, "the Servers pane registered a wake the switches do not want").toEqual([]);
    expect(wake.state).toEqual({ k: "off", reason: "switched_off" });
  });

  it("a registration in the air when the page says no is taken down once it lands", async () => {
    await mount({ k: "shell", session: A });
    calls.hold = true;
    await say("p-a", true);
    expect(calls.held).toHaveLength(1);
    await say("p-a", false);
    expect(calls.forgotten, "nothing is removed before there is anything to remove").toEqual([]);
    calls.hold = false;
    await act(async () => { calls.held.splice(0).forEach((answer) => answer()); });
    await settled();
    expect(calls.registered).toEqual(["p-a"]);
    expect(calls.forgotten.map((f) => f.id), "the row that landed was left standing").toContain("row-1");
    expect(wake.state).toEqual({ k: "off", reason: "switched_off" });
  });

  it("the page of a pairing that is not the live one says nothing here, and another pairing's page starts unsaid", async () => {
    await mount({ k: "shell", session: A });
    await say("p-b", true);
    expect(calls.registered).toEqual([]);
    await say("p-a", true);
    expect(calls.registered).toEqual(["p-a"]);
    // The person switches to another pairing: what A's page said is not about B.
    await move({ k: "shell", session: B });
    expect(calls.registered, "B was registered on A's page's word").toEqual(["p-a"]);
    await say("p-b", true);
    expect(calls.registered).toEqual(["p-a", "p-b"]);
  });

  it("a session that is no shell's has no page and registers as it always has", async () => {
    await mount({ k: "live", session: A });
    expect(calls.registered).toEqual(["p-a"]);
    expect(wake.state).toEqual({ k: "on", id: "row-1" });
  });

  it("tells native who is signed in at each move of the connection: a pairing, none on the way to the next, none at sign-out", async () => {
    const pB = { profile: { id: "pbk2x9aq1z7" } };
    const pC = { profile: { id: "pck2x9aq1z7" } };
    await mount({ k: "live", session: pB });
    await move({ k: "connecting" });
    await move({ k: "live", session: pC });
    await move({ k: "idle" });
    expect(calls.lives).toEqual(["pbk2x9aq1z7", null, "pck2x9aq1z7", null]);
  });

  it("with no distributor chosen the page's word registers nothing and removes nothing", async () => {
    calls.saved = null;
    await mount({ k: "shell", session: A });
    await say("p-a", true);
    await say("p-a", false);
    expect(calls.registered).toEqual([]);
    expect(calls.forgotten).toEqual([]);
    expect(wake.state).toEqual({ k: "no_distributor" });
  });
});

describe("the page says whether the wake is wanted, over the bridge", () => {
  const choices = (over: Partial<NoticeChoices> = {}): NoticeChoices => ({ ...noticeChoicesOf(null, null, { ohcalPhone: false }), ...over });
  /** The page's teller over the real bridge and guard, to a native end that records what it was told. */
  function page() {
    const told: boolean[] = [];
    const bridge = pageOver(phone().deps, undefined, (wanted) => { told.push(wanted); });
    const tell = wakeTeller(async (wanted) => { await bridge.request("act", { act: "wake.want", wanted }); });
    const crossed = async (): Promise<void> => { await new Promise((done) => setTimeout(done, 0)); };
    return { bridge, tell, told, crossed };
  }

  it("is wanted only while the master and new mail are both on; the other switches are no part of it", () => {
    expect(wakeWanted(choices())).toBe(true);
    expect(wakeWanted(choices({ master: false }))).toBe(false);
    expect(wakeWanted(choices({ ohbox: false }))).toBe(false);
    expect(wakeWanted(choices({ screener: false, scheduled: false, pairing: false, cal_alert: false }))).toBe(true);
    // A stored value that is no boolean is no yes.
    expect(wakeWanted(choices({ master: "true" as never }))).toBe(false);
  });

  it("says it once when the choices are first read, and again only when the answer changes", async () => {
    const p = page();
    p.tell(choices());
    p.tell(choices());
    await p.crossed();
    expect(p.told, "the first reading is said: a phone that starts with both on is registered").toEqual([true]);
    p.tell(choices({ ohbox: false }));
    await p.crossed();
    p.tell(choices({ ohbox: false, master: false }));
    await p.crossed();
    expect(p.told).toEqual([true, false]);
    p.tell(choices());
    await p.crossed();
    expect(p.told).toEqual([true, false, true]);
  });

  it("an answer native refused is said again at the next settle", async () => {
    const told: boolean[] = [];
    let refuse = true;
    const tell = wakeTeller(async (wanted) => {
      if (refuse) throw new BridgeRefused("notReady");
      told.push(wanted);
    });
    tell(choices({ master: false }));
    await new Promise((done) => setTimeout(done, 0));
    refuse = false;
    tell(choices({ master: false }));
    await new Promise((done) => setTimeout(done, 0));
    expect(told).toEqual([false]);
  });

  it("a page that sends a word for the boolean, or a key beside it, is refused by the guard and native is told nothing", async () => {
    const p = page();
    for (const hostile of [{ wanted: "false" }, { wanted: 0 }, {}, { wanted: false, instance: "pzz9k2x9aq1z7" }]) {
      await expect(p.bridge.request("act", { act: "wake.want", ...hostile } as never)).rejects.toBeInstanceOf(BridgeRefused);
    }
    expect(p.told).toEqual([]);
  });

  it("a surface whose host has no wake registration says nothing", () => {
    expect(() => wakeTeller(undefined)(choices({ master: false }))).not.toThrow();
  });
});
