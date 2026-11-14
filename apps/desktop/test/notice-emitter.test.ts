/**
 * The window's emitter: it hands the shell the notice itself, exactly its own members and nothing
 * an object handed in carried beside them, only while this window is not the one looked at, and
 * only for the kinds it carries.
 */
import { describe, expect, it } from "vitest";
import { noticeKindsOf, type MailNotice, type Notice } from "@ohmail/client-engine";
import { desktopNoticeEmitter, type NoticeShell } from "../src/notice-emitter";

function shell(state: { focused?: boolean; refuse?: boolean } = {}) {
  const handed: MailNotice[] = [];
  const s: NoticeShell = {
    focused: () => state.focused ?? false,
    post: async (notice) => {
      handed.push(notice);
      if (state.refuse) throw new Error("notifications are turned off for ohmail on this computer");
    },
  };
  return { s, handed };
}

describe("the window's emitter", () => {
  it("carries new mail, waiting senders and pairing, all of them kinds the table lets the desktop draw", () => {
    const { carries } = desktopNoticeEmitter(shell().s);
    expect([...carries]).toEqual(["ohbox", "screener", "pairing"]);
    for (const kind of carries) expect(noticeKindsOf("desktop")).toContain(kind);
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
