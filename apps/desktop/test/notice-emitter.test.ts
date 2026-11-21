/**
 * The window's emitter: it hands the shell the notice itself, exactly its own members and nothing
 * an object handed in carried beside them, only while this window is not the one looked at, and
 * only for the kinds it carries.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { aheadAlert, aheadSet, noticeKindsOf, type AheadSet, type MailNotice, type Notice } from "@ohmail/client-engine";
import { setOsAlerts } from "../src/native.js";
import { desktopEmitterFor, desktopNoticeEmitter, type NoticeShell } from "../src/notice-emitter";

function shell(state: { focused?: boolean; refuse?: boolean } = {}) {
  const handed: MailNotice[] = [];
  const sets: AheadSet[] = [];
  const s: NoticeShell = {
    focused: () => state.focused ?? false,
    post: async (notice) => {
      handed.push(notice);
      if (state.refuse) throw new Error("notifications are turned off for ohmail on this computer");
    },
    alerts: async (set) => {
      sets.push(set);
      if (state.refuse) throw new Error("not the mailbox this shell serves");
      return [];
    },
  };
  return { s, handed, sets };
}

const NOW = Date.UTC(2026, 10, 16, 8, 0);
/** One account's alerts as the caller hands them: an alert an hour ahead, with no act (the window carries none). */
const setOf = (scope: string): AheadSet =>
  aheadSet(scope, [aheadAlert({ id: "standup", title: "Standup", private: false, heldBack: false }, true,
    { startMs: NOW + 3_600_000, allDay: false, leadMin: 10, acts: [] })!], NOW)!;

describe("the window's emitter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands a single letter's opening separately from the native notice words", async () => {
    const invoke = vi.fn(async (_name: string, _payload?: unknown) => undefined);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke, transformCallback: () => 1 });
    const writer = { document: 2, session: 3 };
    await expect(desktopEmitterFor(writer).post({ kind: "ohbox", count: 1 }, () => true, "arrived")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("notify", {
      notice: { kind: "ohbox", count: 1 },
      opening: { ...writer, letter: "arrived" },
    });
  });

  it("sends each calendar replacement immediately with the frame's captured writer and increasing order", async () => {
    const invoke = vi.fn(async (_name: string, _payload?: unknown, _options?: unknown) => []);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke, transformCallback: () => 1 });
    const set = { scope: "sample-mailbox", alerts: [] };
    await setOsAlerts(set, null);
    expect(invoke).not.toHaveBeenCalled();
    await setOsAlerts(set, { document: 2, session: 3 });
    await setOsAlerts(set, { document: 2, session: 4 });
    const headers = invoke.mock.calls.map(call => (call[2] as { headers: Record<string, string> }).headers);
    expect(invoke.mock.calls.map(([name, body]) => [name, body])).toEqual([["alerts_set", { set }], ["alerts_set", { set }]]);
    expect(headers[0]).toMatchObject({ "x-ohmail-notice-document": "2", "x-ohmail-notice-session": "3" });
    expect(headers[1]).toMatchObject({ "x-ohmail-notice-document": "2", "x-ohmail-notice-session": "4" });
    expect(Number(headers[1]!["x-ohmail-notice-revision"])).toBe(Number(headers[0]!["x-ohmail-notice-revision"]) + 1);
  });

  it("carries new mail, waiting senders, pairing and the calendar's alerts, all of them kinds the table lets the desktop draw", () => {
    const { carries } = desktopNoticeEmitter(shell().s);
    expect([...carries]).toEqual(["ohbox", "screener", "pairing", "cal_alert"]);
    for (const kind of carries) expect(noticeKindsOf("desktop")).toContain(kind);
  });

  it("withdraws a schedule even when the previous handoff is never acknowledged", () => {
    const sets: AheadSet[] = [];
    const emitter = desktopNoticeEmitter({
      ...shell().s,
      alerts: (set) => {
        sets.push(set);
        return new Promise<never>(() => {});
      },
    });
    if (emitter.ahead === "none") throw new Error("the window sets no alerts ahead");
    emitter.ahead(setOf("mb-1"));
    emitter.takeBack();
    expect(sets.map(set => set.alerts.length)).toEqual([1, 0]);
  });

  it("a delayed installation cannot restore an earlier title after its withdrawal", async () => {
    const writes: { set: AheadSet; finish: () => void }[] = [];
    let installed: AheadSet | null = null;
    const emitter = desktopNoticeEmitter({
      ...shell().s,
      alerts: async (set) => {
        await new Promise<void>(finish => writes.push({ set, finish }));
        installed = set;
        return [];
      },
    });
    if (emitter.ahead === "none") throw new Error("the window sets no alerts ahead");
    emitter.ahead(setOf("mb-1"));
    emitter.takeBack();
    // The platform may finish either operation first. An old completion after the
    // withdrawal causes one immediate reassertion of the current empty set.
    expect(writes.map(w => w.set.alerts.length)).toEqual([1, 0]);
    writes[1]!.finish();
    await vi.waitFor(() => expect(installed).toEqual({ scope: "mb-1", alerts: [] }));
    writes[0]!.finish();
    await vi.waitFor(() => expect(writes.map(w => w.set.alerts.length)).toEqual([1, 0, 0]));
    writes[2]!.finish();
    await Promise.resolve();
    expect(installed).toEqual({ scope: "mb-1", alerts: [] });
  });

  it("keeps the replacement window's schedule when an earlier mount finally acknowledges", async () => {
    const writes: { set: AheadSet; finish: () => void }[] = [];
    const port = {
      ...shell().s,
      alerts: (set: AheadSet) => new Promise<string[]>(resolve => writes.push({ set, finish: () => resolve([]) })),
    };
    const earlier = desktopNoticeEmitter(port);
    const later = desktopNoticeEmitter(port);
    if (earlier.ahead === "none" || later.ahead === "none") throw new Error("no native schedule");
    earlier.ahead(setOf("mb-1"));
    earlier.takeBack();
    writes[1]!.finish();
    await Promise.resolve();
    later.ahead(setOf("mb-1"));
    writes[2]!.finish();
    writes[0]!.finish();
    await Promise.resolve();
    expect(writes.map(write => write.set.alerts.length)).toEqual([1, 0, 1]);
  });

  it("hands the shell the account's alerts ahead, read closed, and never posts an alert", () => {
    const r = shell();
    const emitter = desktopNoticeEmitter(r.s);
    if (emitter.ahead === "none") throw new Error("the window sets no alerts ahead");
    const set = setOf("mb-1");
    emitter.ahead(set);
    expect(r.sets).toEqual([set]);
    expect(r.sets[0], "the set crossed as the object handed in, not as a closed copy").not.toBe(set);
    const [alert] = set.alerts;
    emitter.ahead({ ...set, alerts: [{ ...alert!, place: "Zqplace" } as never] });
    emitter.ahead({ scope: "demo:fixtures", alerts: [] });
    emitter.ahead({ ...set, extra: true } as unknown as AheadSet);
    expect(r.sets, "a set that does not read closed crossed").toHaveLength(1);
    emitter.post({ kind: "cal_alert", eventId: "standup", label: { as: "event" }, at: { hour: 9, minute: 0, day: "today" }, allDay: false, leadMin: 10, acts: [] });
    expect(r.handed, "an alert was posted instead of set ahead").toEqual([]);
  });

  it("takes back the last account's alerts: the shell is handed that account's empty set, once", async () => {
    const r = shell();
    const emitter = desktopNoticeEmitter(r.s);
    emitter.takeBack();
    expect(r.sets, "nothing was handed, so nothing is taken back").toEqual([]);
    if (emitter.ahead === "none") throw new Error("the window sets no alerts ahead");
    emitter.ahead(setOf("mb-1"));
    emitter.ahead(setOf("mb-2"));
    emitter.takeBack();
    emitter.takeBack();
    await vi.waitFor(() => expect(r.sets.slice(2)).toEqual([{ scope: "mb-2", alerts: [] }]));
  });

  it("a shell that refuses a set takes nothing down", async () => {
    const r = shell({ refuse: true });
    const emitter = desktopNoticeEmitter(r.s);
    if (emitter.ahead === "none") throw new Error("the window sets no alerts ahead");
    const ahead = emitter.ahead;
    expect(() => ahead(setOf("mb-1"))).not.toThrow();
    await Promise.resolve();
    expect(() => emitter.takeBack()).not.toThrow();
    expect(r.sets).toHaveLength(2);
  });

  it("hands the shell each notice as exactly its own members", () => {
    const r = shell();
    const emitter = desktopNoticeEmitter(r.s);
    const notices: MailNotice[] = [
      { kind: "ohbox", count: 2 },
      { kind: "screener", count: 1 },
      { kind: "pairing", change: "revoked", device: "browser" },
    ];
    for (const notice of notices) emitter.post(notice);
    expect(r.handed).toEqual(notices);
  });

  it("leaves behind whatever an object handed in carried beside a notice's members", () => {
    const r = shell();
    const emitter = desktopNoticeEmitter(r.s);
    emitter.post({ kind: "ohbox", count: 1, subject: "Zqsubject", sender: "zq@example.org" } as unknown as Notice);
    emitter.post({ kind: "pairing", change: "paired", device: null, label: "Zqdevice" } as unknown as Notice);
    expect(r.handed).toEqual([{ kind: "ohbox", count: 1 }, { kind: "pairing", change: "paired", device: null }]);
    expect(JSON.stringify(r.handed)).not.toMatch(/zq/i);
  });

  it("hands over nothing while this window is the one looked at", () => {
    const r = shell({ focused: true });
    desktopNoticeEmitter(r.s).post({ kind: "ohbox", count: 3 });
    expect(r.handed).toEqual([]);
  });

  it("says whether the shell took a notice, so that a device's notice not drawn is told again", async () => {
    const paired: Notice = { kind: "pairing", change: "paired", device: null };
    expect(await desktopNoticeEmitter(shell().s).post(paired)).toBe(true);
    expect(await desktopNoticeEmitter(shell({ refuse: true }).s).post(paired), "notifications are off for ohmail").toBe(false);
    expect(await desktopNoticeEmitter(shell({ focused: true }).s).post(paired), "this window is the one looked at").toBe(false);
    expect(await desktopNoticeEmitter(shell().s).post({ kind: "scheduled", outcome: "sent", count: 1 }), "not carried").toBe(false);
  });

  it("hands over nothing for a kind it does not carry", () => {
    const r = shell();
    const emitter = desktopNoticeEmitter(r.s);
    emitter.post({ kind: "scheduled", outcome: "sent", count: 1 });
    emitter.post({ kind: "scheduled", outcome: "failed", count: 1 });
    emitter.post({ kind: "cal_found", count: 1, at: null });
    emitter.post({ kind: "cal_summary", events: 2, first: null, toAnswer: 0 });
    expect(r.handed).toEqual([]);
  });

  it("swallows the shell's refusal: a notice that cannot be shown takes nothing down", async () => {
    const r = shell({ refuse: true });
    const emitter = desktopNoticeEmitter(r.s);
    expect(() => emitter.post({ kind: "ohbox", count: 1 })).not.toThrow();
    await Promise.resolve();
    expect(r.handed).toHaveLength(1);
    expect(() => emitter.takeBack()).not.toThrow();
  });
});
