/**
 * A LETTER THAT WENT OUT WITHOUT ITS COPY IN SENT, AS THE GROUND SAYS IT (`sendNotices`, the send machine's line read
 * into the frame's notice slot). The machine keeps such a letter's note on its line until the person dismisses it
 * (`SentCopyLineNote`): the notice says to whom and what it was, why its copy is not in Sent, and Dismiss; each
 * letter's note is its own notice; and a note standing never hides a letter that did not leave. Nor does a letter
 * that did not leave hide the next one going and gone: each row of the line (`lineRows`) is its own notice.
 */
import { describe, expect, it } from "vitest";
import type { SendLineItem, SendState } from "@ohmail/app-logic/writing/mail-send";
import { sendNotices } from "../../src/mail/ground/send-notices.js";
import { noticeId } from "../../src/frame/notice-store.js";

/* The words by key, with what each names: which sentence a notice says is the subject here, not its wording. */
const t = (key: string, values?: Record<string, string | number>): string =>
  values === undefined ? key : `${key} ${JSON.stringify(values)}`;
const noted = (key: string, to: string, subject: string, copy: SendLineItem["copy"]): SendLineItem => ({
  id: `note:${key}`,
  key: "re:m1",
  state: "sent",
  to,
  subject,
  copy,
});
const ended = (key: string, to: string, subject: string): SendLineItem => ({
  id: `e:${key}`,
  key,
  state: "ended",
  to,
  subject,
  ended: { phase: "failed", code: "send_unreachable" } as SendState,
});

describe("a delivered letter whose Sent copy has a note", () => {
  it("is said with whom and what it was, why its copy is not in Sent, and Dismiss, which takes that note off the line", () => {
    const dismissed: string[] = [];
    const notices = sendNotices(
      t,
      [noted("k1", "Lena", "Plans", { state: "missing", reason: "too_big" })],
      () => {},
      (id) => dismissed.push(id),
    );
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice!.kind).toBe("sentCopy");
    expect(notice!.title).toBe('sendingLine.sentToAbout {"name":"Lena","subject":"Plans"}');
    expect(notice!.line, "why the copy is not in Sent").toMatch(/^sentCopy\.missingTooBig/);
    expect(notice!.hot, "a missing copy is said as a warning").toBe(true);
    expect(notice!.acts?.map((a) => a.label)).toEqual(["sendingLine.dismiss"]);
    notice!.acts![0]!.onPress();
    expect(dismissed).toEqual(["note:k1"]);
  });

  it("a copy still owed to a full mailbox warns; each letter's note stands on its own, the oldest first", () => {
    const notices = sendNotices(
      t,
      [
        noted("k2", "Ben", "Kiln", { state: "pending", reason: "full" }),
        noted("k1", "Lena", "Plans", { state: "missing", reason: "too_big" }),
      ],
      () => {},
      () => {},
    );
    expect(notices.map((n) => [n.kind, n.id, n.line?.split(" ")[0], n.hot === true])).toEqual([
      ["sentCopy", "note:k1", "sentCopy.missingTooBig", true],
      ["sentCopy", "note:k2", "sentCopy.quotaWaiting", true],
    ]);
  });

  it("names the full mailbox and opens Mailboxes without dismissing the warning", () => {
    const closed: string[] = [];
    const opened: (string | undefined)[] = [];
    const item = {
      ...noted("k2", "Ben", "Kiln", { state: "pending", reason: "full" }),
      mailboxId: "mailbox-2",
    };
    const [notice] = sendNotices(
      t,
      [item],
      () => {},
      (id) => closed.push(id),
      true,
      {
        address: (id: string) => (id === "mailbox-2" ? "mailbox.example" : null),
        open: (id?: string) => opened.push(id),
      },
    );
    expect(notice!.title).toContain("mailbox.example");
    expect(notice!.acts?.map((a) => a.label)).toEqual(["sentCopy.openMailboxes", "sentCopy.notNow"]);
    notice!.acts![0]!.onPress();
    expect(opened).toEqual(["mailbox-2"]);
    expect(closed).toEqual([]);
    notice!.acts![1]!.onPress();
    expect(closed).toEqual(["note:k2"]);
  });

  it("shows one warning per full mailbox and dismisses only that mailbox's notes", () => {
    const full = { state: "pending", reason: "full" } as const;
    const items = [
      { ...noted("latest", "One", "Third", full), mailboxId: "first" },
      { ...noted("other", "Two", "Second", full), mailboxId: "second" },
      { ...noted("old", "Three", "First", full), mailboxId: "first" },
    ];
    const dismissed: string[] = [];
    const notices = sendNotices(
      t,
      items,
      () => {},
      (id) => dismissed.push(id),
      true,
      {
        address: (id) => id + ".example",
      },
    );
    expect(notices).toHaveLength(2);
    const first = notices.find((notice) => notice.title.includes("first.example"));
    first?.acts?.[0]?.onPress();
    expect(dismissed.sort()).toEqual(["note:latest", "note:old"]);
  });

  it("never hides a letter that did not leave: the ending is said beside it, with its Open", () => {
    const opened: string[][] = [];
    const notices = sendNotices(
      t,
      [noted("k1", "Lena", "Plans", { state: "missing", reason: "too_big" }), ended("re:m2", "Ben", "Kiln")],
      (items) => void opened.push(items.map((i) => i.id)),
      () => {},
    );
    const notSent = notices.find((n) => n.kind === "notSent");
    expect(notSent?.title, "the letter that did not leave").toBe(
      'sendingLine.aboutBoth {"name":"Ben","subject":"Kiln"}',
    );
    expect(notSent?.line).toMatch(/^reply\.statusUnreachable/);
    notSent!.acts![0]!.onPress();
    expect(opened).toEqual([["e:re:m2"]]);
    expect(
      notices.some((n) => n.kind === "sentCopy"),
      "the note beside it",
    ).toBe(true);
  });
});

describe("a letter that did not leave, then the next letters", () => {
  const line = (key: string, state: SendLineItem["state"], to: string, subject: string): SendLineItem => ({
    id: `${state}:${key}`,
    key,
    state,
    to,
    subject,
  });

  it("hides nothing: each row of the line is its own notice, the ending first, then the one going, then the one gone", () => {
    const notices = sendNotices(
      t,
      [
        line("re:m3", "sent", "Ada", "Train"),
        line("re:m2", "sending", "Jonas", "Lunch"),
        ended("re:m1", "Mila", "Thursday plans"),
      ],
      () => {},
      () => {},
    );
    expect(notices.map((n) => [n.kind, n.title])).toEqual([
      ["notSent", 'sendingLine.aboutBoth {"name":"Mila","subject":"Thursday plans"}'],
      ["sending", 'sendingLine.sending {"name":"Jonas"}'],
      ["sending", 'sendingLine.sentToAbout {"name":"Ada","subject":"Train"}'],
    ]);
    expect(new Set(notices.map(noticeId)).size, "two of one kind stand under one name in the slot").toBe(3);
  });
});
