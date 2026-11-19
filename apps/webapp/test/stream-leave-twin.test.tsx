/** @vitest-environment jsdom */
/**
 * THE LEAVE'S COMMIT, TWO IMPLEMENTATIONS, ONE ANSWER. Today's News and Receipts views turn their stream's leave state
 * into one anchored commit inline; the places' stream does it with `streamLeaveCommit` (`@ohmail/app-logic/streams`).
 * The same leave states go to both, through the views' own stream seam, and the commits must be the same.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { streamLeaveCommit, type StreamLeaveState } from "@ohmail/app-logic/streams";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
  escape: (s: string) => s.replace(/["\\]/g, (c) => `\\${c}`),
};
(globalThis as Record<string, unknown>).IntersectionObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The views' stream, stood in: it hands the leave seam out and draws its cards. */
const seam: { onLeave: ((s: StreamLeaveState) => void) | null } = { onLeave: null };
vi.mock("../app/shell/StreamShell", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const R = await import("react");
  const Fake = R.forwardRef(function Fake(
    props: { onLeave?: (s: StreamLeaveState) => void; children?: React.ReactNode },
    ref: React.Ref<unknown>,
  ) {
    seam.onLeave = props.onLeave ?? null;
    R.useImperativeHandle(ref, () => ({
      scrollTo() {},
      element: () => null,
      enter() {},
      seen() {},
      onScreen: () => false,
      whenOffScreen() {},
      reveal() {},
      hold() {},
    }));
    return R.createElement("div", { className: "stream" }, props.children);
  });
  return { ...real, StreamShell: Fake };
});

interface Row {
  id: string;
  unread: boolean;
}
const NOW = new Date("2026-08-02T09:00:00.000Z");
function msg(r: Row, folder: string): Record<string, unknown> {
  return {
    id: r.id,
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `S-${r.id}`,
    from: { name: r.id, address: `${r.id}@example.com` },
    to: [],
    cc: [],
    date: "2026-08-02T09:00:00.000Z",
    folder,
    snippet: "preview",
    unread: r.unread,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, unread: i % 3 !== 0 }));
const order = rows.map((r) => ({ id: r.id, unread: r.unread }));

/** The leave states both sides are asked about. */
const states: Array<[string, Omit<StreamLeaveState, "read"> & { reads: string[] }]> = [
  ["no hand drove the visit", { drove: false, newestSeenId: "r0", bottomVisibleId: "r4", reads: ["r1", "r2"] }],
  ["nothing was shown", { drove: true, newestSeenId: null, bottomVisibleId: "r3", reads: ["r1"] }],
  ["the newest shown left the pile", { drove: true, newestSeenId: "gone", bottomVisibleId: "r3", reads: ["r1"] }],
  ["a screen from the top", { drove: true, newestSeenId: "r0", bottomVisibleId: "r3", reads: ["r1", "r2", "r3"] }],
  ["only what was read rides", { drove: true, newestSeenId: "r2", bottomVisibleId: "r8", reads: ["r4", "r7", "r8"] }],
  ["a foot above the anchor", { drove: true, newestSeenId: "r5", bottomVisibleId: "r1", reads: ["r5", "r1"] }],
  ["no foot", { drove: true, newestSeenId: "r4", bottomVisibleId: null, reads: ["r4", "r5"] }],
  ["read cards that are not unread", { drove: true, newestSeenId: "r0", bottomVisibleId: "r9", reads: ["r0", "r3", "r6", "r9"] }],
];
const state = (s: Omit<StreamLeaveState, "read"> & { reads: string[] }): StreamLeaveState => ({
  drove: s.drove,
  newestSeenId: s.newestSeenId,
  bottomVisibleId: s.bottomVisibleId,
  read: (id) => s.reads.includes(id),
});

async function mount(view: "reads" | "receipts", commits: unknown[]): Promise<void> {
  const { KeymapProvider } = await import("../../../test/support/keymap-provider");
  const onLeaveSeen = (c: unknown) => commits.push(c);
  const common = {
    settled: true,
    owed: false,
    tags: [],
    now: NOW,
    cur: null,
    onCur: () => {},
    markSeen: () => {},
    onLeaveSeen,
    hydrateBody: () => {},
    jumpTo: null,
    onJumped: () => {},
  };
  let node: React.ReactNode;
  if (view === "reads") {
    const { ReadsView } = await import("../app/views/ReadsView.js");
    node = h(ReadsView as never, {
      ...common,
      partition: { waterline: null, fresh: rows.map((r) => msg(r, "ohmail/News")), seen: [] },
      aiChip: null,
      chipState: null,
      onChipState: () => {},
      bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
    } as never);
  } else {
    const { ReceiptsView } = await import("../app/views/ReceiptsView.js");
    node = h(ReceiptsView as never, {
      ...common,
      messages: rows.map((r) => msg(r, "ohmail/Receipts")),
      waterline: null,
      unreadCount: rows.filter((r) => r.unread).length,
      isUnread: (m: { unread: boolean }) => m.unread,
      bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet", html: null, loadedRemoteContent: false }),
    } as never);
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: NOW,
        children: h(KeymapProvider as never, { children: node } as never),
      }),
    );
  });
}

describe("the leave's commit: today's views and the places' stream agree", () => {
  for (const view of ["reads", "receipts"] as const) {
    it(`${view}: every leave state gives the same commit, or none on both sides`, async () => {
      const commits: unknown[] = [];
      await mount(view, commits);
      expect(seam.onLeave).not.toBeNull();
      for (const [name, s] of states) {
        commits.length = 0;
        seam.onLeave!(state(s));
        const theirs = commits.length === 0 ? null : commits[0];
        expect(commits.length, name).toBeLessThanOrEqual(1);
        expect(streamLeaveCommit(state(s), order), name).toEqual(theirs);
      }
    });
  }
});
