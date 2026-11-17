/** @vitest-environment jsdom */
/**
 * The one caller: at each settle it samples the copy, asks the gate and hands the emitter what the
 * gate answered. A switch that is off calls nothing; another account starts from nothing and takes
 * back what was drawn for the one left.
 */
import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  MAIL_NOTICE_KINDS,
  MemoryMirrorStore,
  noticeChoicesOf,
  type Notice,
  type NoticeChoices,
  type NoticeKind,
  type NoticePermission,
  type SyncChange,
} from "@ohmail/client-engine";
import {
  NoticeCaller,
  useNotices,
  type HostNoticeEmitter,
  type NoticesMount,
} from "../../src/notices/use-notices.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-11-17T09:00:00.000Z";
let seq = 0;
const letter = (id: string): SyncChange =>
  ({
    type: "message",
    op: "create",
    id,
    seq: ++seq,
    updatedAt: AT,
    entity: {
      id,
      accountId: "acct",
      mailboxId: "mb",
      threadId: null,
      messageIdHeader: null,
      subject: "A subject",
      from: { name: "A sender", address: "a@example.org" },
      to: [],
      cc: [],
      date: AT,
      folder: "INBOX",
      snippet: "",
      unread: true,
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      sensitivity: {
        sensitive: false,
        category: null,
        no_ai: false,
        no_forward: false,
        no_kb: false,
        priority: false,
      },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: AT,
    },
  }) as SyncChange;

async function copyWith(...ids: string[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  if (ids.length > 0) await store.applyChanges(ids.map(letter));
  return store;
}

/** An emitter that records what it is handed and what it takes back. */
function recording(carries: readonly NoticeKind[] = MAIL_NOTICE_KINDS) {
  const posted: Notice[] = [];
  let takenBack = 0;
  const emitter: HostNoticeEmitter = {
    carries,
    acts: [],
    ahead: "none",
    post: (notice) => {
      posted.push(notice);
    },
    takeBack: () => {
      takenBack += 1;
    },
  };
  return { emitter, posted, takenBack: () => takenBack };
}

function callerOf(
  emitter: HostNoticeEmitter,
  over: { choices?: Partial<NoticeChoices>; permission?: NoticePermission } = {},
) {
  return new NoticeCaller(emitter, {
    choices: () => ({ ...noticeChoicesOf(null, null, { ohcalPhone: false }), ...over.choices }),
    permission: () => over.permission ?? "granted",
    devices: () => null,
  });
}

describe("the one caller", () => {
  it("draws nothing for the copy it first sees, then hands the emitter what arrived", async () => {
    const r = recording();
    const caller = callerOf(r.emitter);
    const store = await copyWith("one", "two");
    caller.settle("acct-a", store);
    expect(r.posted, "an app opened over two unread letters has not just received two").toEqual([]);
    await store.applyChanges([letter("three")]);
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([{ kind: "ohbox", count: 1 }]);
    caller.settle("acct-a", store);
    expect(r.posted, "a settle with nothing new draws nothing").toHaveLength(1);
  });

  it("calls the emitter for nothing while the kind's switch, the master or the platform says no", async () => {
    for (const over of [
      { choices: { ohbox: false } },
      { choices: { master: false } },
      { permission: "denied" as const },
    ]) {
      const r = recording();
      const caller = callerOf(r.emitter, over);
      const store = await copyWith();
      caller.settle("acct-a", store);
      await store.applyChanges([letter(`n-${seq}`)]);
      caller.settle("acct-a", store);
      expect(r.posted, JSON.stringify(over)).toEqual([]);
    }
  });

  it("hands an emitter no kind it does not carry", async () => {
    const r = recording(["screener"]);
    const caller = callerOf(r.emitter);
    const store = await copyWith();
    caller.settle("acct-a", store);
    await store.applyChanges([letter("arrived")]);
    caller.settle("acct-a", store);
    expect(r.posted).toEqual([]);
  });

  it("at an account switch takes back what was drawn, and the next account's first sample draws nothing", async () => {
    const r = recording();
    const caller = callerOf(r.emitter);
    const left = await copyWith();
    caller.settle("acct-a", left);
    await left.applyChanges([letter("for-a")]);
    caller.settle("acct-a", left);
    expect(r.posted).toHaveLength(1);
    expect(r.takenBack()).toBe(0);

    // The next account's copy holds three unread letters the first account never had.
    const next = await copyWith("b1", "b2", "b3");
    caller.settle("acct-b", next);
    expect(r.takenBack(), "what was drawn for the account left stays listed").toBe(1);
    expect(r.posted, "the next account's mail was compared against the account left").toHaveLength(1);
    await next.applyChanges([letter("b4")]);
    caller.settle("acct-b", next);
    expect(r.posted.at(-1)).toEqual({ kind: "ohbox", count: 1 });
  });

  it("at sign-out takes back what was drawn and starts from nothing again", async () => {
    const r = recording();
    const caller = callerOf(r.emitter);
    const store = await copyWith();
    caller.settle("acct-a", store);
    caller.end();
    expect(r.takenBack()).toBe(1);
    await store.applyChanges([letter("after")]);
    caller.settle("acct-a", store);
    expect(r.posted, "the first sample after the end seeds again").toEqual([]);
  });

  it("an emitter that throws while taking back takes nothing else down", async () => {
    const r = recording();
    const caller = callerOf({
      ...r.emitter,
      takeBack: () => {
        throw new Error("no");
      },
    });
    const store = await copyWith();
    caller.settle("acct-a", store);
    expect(() => caller.settle("acct-b", store)).not.toThrow();
    expect(() => caller.end()).not.toThrow();
  });
});

describe("the mounted caller", () => {
  it("takes back what was drawn when the shell that mounted it goes", async () => {
    const r = recording();
    const store = await copyWith();
    const mount: NoticesMount = {
      reader: store,
      version: 1,
      settled: true,
      scope: "acct-a",
      emitter: r.emitter,
      reads: {
        choices: () => noticeChoicesOf(null, null, { ohcalPhone: false }),
        permission: () => "granted",
        devices: () => null,
      },
    };
    function Shell() {
      useNotices(mount);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(createElement(Shell));
    });
    expect(r.takenBack()).toBe(0);
    await act(async () => {
      root.unmount();
    });
    expect(r.takenBack(), "a sign-out left the account's notices listed").toBe(1);
  });
});
