/** @vitest-environment jsdom */
/**
 * THE PHONE'S EMITTER, ON THE PAGE'S SIDE OF THE BRIDGE. It hands native a notice's own members and nothing an
 * object carried beside them, carries only the kinds native says it draws on this phone, never throws, and, joined
 * to the one caller and the real native end, draws nothing for a pairing that was left.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, noticeChoicesOf, type Notice, type SyncChange } from "@ohmail/client-engine";
import { EngineContext, type EngineBinding } from "@ohmail/app-logic/engine";
import { NoticeCaller, toldDevicesIn, type HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
import type { HostContract } from "@ohmail/app/host";
import { BridgeRefused, type Bridge } from "../web/src/bridge";
import { phoneNoticeEmitter } from "../web/src/notice-emitter";
import { PhoneNotices } from "../web/src/notices";
import { A, pageOver, phone } from "./helpers/notice-phone";

describe("the page's emitter over the bridge", () => {
  /** A bridge that records what the page asks, and answers as told. */
  function recordingBridge(answer: () => Promise<unknown> = async () => ({ notice: "posted" })) {
    const asked: { kind: string; ask: unknown }[] = [];
    const bridge: Pick<Bridge, "request"> = {
      request: ((kind: string, ask: unknown) => { asked.push({ kind, ask }); return answer(); }) as Bridge["request"],
    };
    return { bridge, asked };
  }

  it("carries the kinds native says it draws here, and is no emitter where native draws none", () => {
    const { bridge } = recordingBridge();
    const all = phoneNoticeEmitter(bridge, ["ohbox", "screener", "pairing"]);
    expect(all).not.toBe("none");
    if (all === "none") return;
    expect(all.carries).toEqual(["ohbox", "screener", "pairing"]);
    expect(all.acts).toEqual([]);
    expect(all.ahead).toBe("none");
    // The iPhone and the calendar's app: native names no kind, so the pane has no switch and nothing can be asked.
    expect(phoneNoticeEmitter(bridge, [])).toBe("none");
    // A kind the bridge does not carry is not carried because a list names it.
    expect(phoneNoticeEmitter(bridge, ["scheduled", "cal_alert"] as never)).toBe("none");
    const one = phoneNoticeEmitter(bridge, ["pairing", "scheduled"] as never);
    expect(one === "none" ? null : one.carries).toEqual(["pairing"]);
  });

  it("hands native a notice's own members and nothing an object carried beside them", () => {
    const { bridge, asked } = recordingBridge();
    const emitter = phoneNoticeEmitter(bridge, ["ohbox", "screener", "pairing"]);
    if (emitter === "none") throw new Error("no emitter");
    emitter.post({ kind: "ohbox", count: 2, subject: "Invoice 4471 is overdue", sender: "a@b.example" } as unknown as Notice);
    emitter.post({ kind: "screener", count: 1, who: "Dana" } as unknown as Notice);
    emitter.post({ kind: "pairing", change: "paired", device: "phone", label: "Dana's phone" } as unknown as Notice);
    expect(asked).toEqual([
      { kind: "act", ask: { act: "notices.post", notice: { kind: "ohbox", count: 2 } } },
      { kind: "act", ask: { act: "notices.post", notice: { kind: "screener", count: 1 } } },
      { kind: "act", ask: { act: "notices.post", notice: { kind: "pairing", change: "paired", device: "phone" } } },
    ]);
  });

  it("hands local details to the phone only for an identified single arrival", async () => {
    const { bridge, asked } = recordingBridge();
    const emitter = phoneNoticeEmitter(bridge, ["ohbox"]);
    if (emitter === "none") throw new Error("no emitter");
    const details = { sender: "Fixture Person", subject: "Meeting" };
    await emitter.post({ kind: "ohbox", count: 1 }, () => true, "arrived", details);
    await emitter.post({ kind: "ohbox", count: 2 }, () => true, undefined, details);
    expect(asked).toEqual([
      { kind: "act", ask: { act: "notices.post", notice: { kind: "ohbox", count: 1 }, details } },
      { kind: "act", ask: { act: "notices.post", notice: { kind: "ohbox", count: 2 } } },
    ]);
  });

  it("asks for no kind it does not carry", () => {
    const { bridge, asked } = recordingBridge();
    const emitter = phoneNoticeEmitter(bridge, ["ohbox"]);
    if (emitter === "none") throw new Error("no emitter");
    emitter.post({ kind: "screener", count: 1 });
    emitter.post({ kind: "pairing", change: "paired", device: null });
    emitter.post({ kind: "scheduled", outcome: "sent", count: 1 });
    emitter.post({ kind: "cal_found", count: 1, at: null });
    expect(asked).toEqual([]);
  });

  it("never throws: a refusal, a bridge that is gone and a notice that is no notice take nothing down", async () => {
    const refusing = phoneNoticeEmitter(recordingBridge(() => Promise.reject(new BridgeRefused("malformed"))).bridge, ["ohbox"]);
    const gone = phoneNoticeEmitter({ request: () => { throw new Error("no port"); } } as never, ["ohbox"]);
    if (refusing === "none" || gone === "none") throw new Error("no emitter");
    expect(() => refusing.post({ kind: "ohbox", count: 1 })).not.toThrow();
    expect(() => gone.post({ kind: "ohbox", count: 1 })).not.toThrow();
    expect(() => gone.post(null as unknown as Notice)).not.toThrow();
    expect(() => refusing.takeBack()).not.toThrow();
    await Promise.resolve();
  });

  it("says whether native posted a notice, so that a device's notice not drawn is told again", async () => {
    const paired: Notice = { kind: "pairing", change: "paired", device: null };
    const answered = (answer: () => Promise<unknown>) => {
      const emitter = phoneNoticeEmitter(recordingBridge(answer).bridge, ["pairing"]);
      if (emitter === "none") throw new Error("no emitter");
      return emitter.post(paired);
    };
    expect(await answered(async () => ({ notice: "posted" }))).toBe(true);
    for (const notice of ["inFront", "denied", "unsupported"]) {
      expect(await answered(async () => ({ notice })), notice).toBe(false);
    }
    expect(await answered(async () => ({ refused: "malformed" })), "refused by the guard").toBe(false);
    expect(await answered(async () => ({})), "an answer that says nothing").toBe(false);
    expect(await answered(() => Promise.reject(new BridgeRefused("malformed"))), "a refusal").toBe(false);
    const gone = phoneNoticeEmitter({ request: () => { throw new Error("no port"); } } as never, ["pairing"]);
    expect(gone === "none" ? null : await gone.post(paired), "a bridge that is gone").toBe(false);
    const other = phoneNoticeEmitter(recordingBridge().bridge, ["ohbox"]);
    expect(other === "none" ? null : await other.post(paired), "a kind it does not carry").toBe(false);
  });

  it("the page counts nothing as read at a Devices list: it draws none", () => {
    /* `atDevices` advances the numbers this phone has told with no notice drawn. The page has no Devices list,
       so only a notice native posted may count: read from the mount's text. */
    const mount = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../web/src/notices.tsx"), "utf8");
    expect(mount).toContain("{ choices, atDevices: () => false }");
    expect(mount.split("atDevices:").length - 1, "one place says it").toBe(1);
  });

  it("draws nothing under the old scope: the caller's notice for a pairing left reaches no poster", async () => {
    /* The one caller over the page's emitter, the real bridge, the real native host and door. New mail arrives for
       the pairing that stands and is handed to the poster; the pairing is then left (signed out, or switched), and
       the page of the one left settles once more with more mail: nothing reaches the poster. */
    let standing = true;
    const p = phone({ live: () => standing });
    const emitter = phoneNoticeEmitter(pageOver(p.deps), ["ohbox", "screener", "pairing"]);
    if (emitter === "none") throw new Error("no emitter");
    let devices = { made: 2, revoked: 0, live: 2 };
    // What the page keeps of the devices it has told, over a jar of its own.
    const jar = new Map<string, string>();
    const told = toldDevicesIn({
      get: (key) => jar.get(key) ?? null,
      set: (key, value) => { jar.set(key, value); return "stored"; },
      remove: (key) => { jar.delete(key); return "stored"; },
    });
    const caller = new NoticeCaller(emitter, {
      choices: () => ({
        master: true, showTitles: true, ohbox: true, screener: true, scheduled: true, pairing: true,
        cal_alert: false, cal_invitation: false, cal_change: false, cal_answer: false, cal_found: false, cal_summary: false,
      }),
      permission: () => "granted",
      devices: () => devices,
      atDevices: () => null,
      told,
      calendar: "none",
    });
    const reader = new MemoryMirrorStore();
    await reader.load();
    caller.settle("scope-a", reader);
    devices = { made: 3, revoked: 0, live: 3 };
    caller.settle("scope-a", reader);
    await new Promise((done) => setTimeout(done, 0));
    expect(p.posts).toEqual([[A, "pairing", 0, "paired", null]]);
    expect(told.read("scope-a"), "native posted it: told").toEqual({ made: 3, revoked: 0 });

    standing = false;
    devices = { made: 4, revoked: 0, live: 4 };
    caller.settle("scope-a", reader);
    await new Promise((done) => setTimeout(done, 0));
    expect(p.posts).toEqual([[A, "pairing", 0, "paired", null]]);
    expect(told.read("scope-a"), "native drew nothing: not told, so it is told when it may be drawn").toEqual({ made: 3, revoked: 0 });
  });
});

describe("the page's one caller, mounted", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const AT = "2026-11-17T09:00:00.000Z";
  let seq = 0;
  /** The account's settings record as the sync hands it: the three device numbers and nothing of any letter. */
  const settings = (made: number, revoked: number, live: number): SyncChange => ({
    type: "settings", op: "update", id: "acct", seq: ++seq, updatedAt: AT,
    entity: {
      accountId: "acct", dormancyDays: null, folderMailboxesOff: {}, locale: null, updatedAt: AT,
      devices: live, devicesMade: made, devicesRevoked: revoked,
    },
  }) as SyncChange;

  it("hands the emitter the notice of a device paired to the account, read from the engine's own copy", async () => {
    globalThis.localStorage?.clear();
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([settings(2, 0, 2)]);
    const listeners = new Set<() => void>();
    const engine = {
      read: () => store,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => void listeners.delete(listener); },
      placementStamp: () => 0,
    };
    const binding = { engine, demo: false, serverDemo: false, sync: { bootstrapping: false } } as unknown as EngineBinding;
    const posted: Notice[] = [];
    const emitter: HostNoticeEmitter = {
      carries: ["ohbox", "screener", "pairing"], acts: [], ahead: "none",
      post: (notice) => { posted.push(notice); return true; },
      takeBack: () => {},
    };
    const host = {
      device: { notifications: { permission: () => "granted", request: async () => "granted", emitter } },
      session: { scope: "scope-a" },
    } as unknown as HostContract;
    const choices = () => noticeChoicesOf(null, null, { ohcalPhone: false });
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(EngineContext.Provider, { value: binding }, createElement(PhoneNotices, { host, choices })));
    });
    expect(posted, "the first settle on this device tells nothing").toEqual([]);

    await act(async () => {
      await store.applyChanges([settings(3, 0, 3)]);
      listeners.forEach((listener) => listener());
    });
    expect(posted).toEqual([{ kind: "pairing", change: "paired", device: null }]);
    await act(async () => { root.unmount(); });
  });
});
