/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { feedPartition, ohboxView } from "@ohmail/client-engine";
import { liveReceipts } from "../../mobile/src/state/live";
import messages from "../messages/en.json";
import { NOW, VIEW, d, mirrorOf, msg } from "./_ohbox-1-convergence.js";

/**
 * THE STREAMS' CASES OF `cross-surface-convergence.test.tsx`, moved here word for word (its other cases stand over
 * the new shell's Ohbox seat): a pin drawn as the Ohbox draws it, and which of a stream's two numbers each part binds.
 * They still mount today's Reads and Receipts views and read today's shell as text: News and Receipts are not seated
 * in the new shell yet, and they wait for `mount-streams`, which re-points them at the seated streams.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/* ── the streams: a pin is state, not a folder ─────────────────────────────────────────── */

/**
 * A resurfaced message keeps its physical folder — the pin is a `message_state`, and
 * `ohboxView` scans the WHOLE mirror for it. So an issue sitting in `ohmail/News` that the
 * reader has put back at the top of the Ohbox is listed TWICE, on one screen each, and the two
 * lists have to draw it the same way. They did not: the Ohbox drew it bold from
 * `presentsUnread` while Reads drew it grey from the stored flag, and its reading pane offered
 * the opposite verb.
 */
describe("a pinned row is drawn the same way wherever it is listed", () => {
  const pinnedInReads = (): EngineMessage[] => [
    msg({ id: "issue-new", date: d(0), unread: true, folder: "ohmail/News" }),
    msg({
      id: "issue-pinned", date: d(1), unread: false, lastReadAt: d(0), folder: "ohmail/News",
      triage: { state: "resurfaced" },
    }),
    msg({ id: "issue-read", date: d(2), unread: false, lastReadAt: d(1), folder: "ohmail/News" }),
  ];

  it("Reads draws the pinned issue unread, and the Ohbox pins the same message", async () => {
    const reader = await mirrorOf(pinnedInReads());
    // It really is in both lists — the premise, asserted rather than assumed.
    expect(ohboxView(reader).resurfaced.map((m) => m.id)).toEqual(["issue-pinned"]);
    expect(feedPartition(reader, "reads").fresh.concat(feedPartition(reader, "reads").seen)
      .map((m) => m.id)).toContain("issue-pinned");

    const { ReadsView } = await import("../app/views/ReadsView.js");
    const { KeymapProvider } = await import("../../../test/support/keymap-provider");
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const part = feedPartition(reader, "reads");
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: NOW,
          children: h(KeymapProvider as never, {
            children: h(ReadsView as never, {
    settled: true, owed: false,
              partition: part, tags: [], now: NOW, cur: null, onCur: () => {},
              aiChip: null, chipState: null, onChipState: () => {}, markSeen: () => {},
              bodyOf: () => ({ text: "", state: "full" }), hydrateBody: () => {},
              jumpTo: null, onJumped: () => {}, onAction: () => {},
            }),
          }),
        }),
      );
    });
    const row = host.querySelector("[data-id='issue-pinned']");
    expect(row, "the pinned issue is not in the Reads list at all").not.toBeNull();
    expect(row!.getAttribute("data-unseen"), "Reads drew the pin grey while the Ohbox drew it bold")
      .toBe("1");
    // …and a genuinely read issue beside it is still grey, so this is not "bold everything".
    expect(host.querySelector("[data-id='issue-read']")!.getAttribute("data-unseen")).toBeNull();
  });
});

/* ── the two numbers a stream carries, and which one is positional ────────────────────── */

/**
 * `FeedPartition` publishes a POSITION (`fresh`/`seen`, where the line is drawn) and a COUNT
 * (`newCount`, what the rail says). They are different numbers the moment a device's anchor is
 * stale, and the shell passes each to exactly one place. Passing `newCount` where the position
 * is wanted slides the waterline up over rows that are genuinely above it — a silent, purely
 * visual regression that no unit assertion on the selector can see, because the selector is
 * right and the binding is wrong.
 *
 * A source-text guard, for the reason `account-deletion.test.ts` uses one: the claim is about
 * WHICH value reaches WHICH prop, and there is no cheaper way to hold it than reading the one
 * line that decides.
 */
describe("the shell binds the position and the badge to different props", () => {
  /* `process.cwd()` is the repo root under this suite's config, and `import.meta.url` is a
     `data:`/vite URL in jsdom — the reason this reads paths rather than URLs. */
  const SHELL = readFileSync(resolve("apps/webapp/app/shell/AppShell.tsx"), "utf8");
  const DOCK = readFileSync(resolve("apps/mobile/app/(tabs)/_layout.tsx"), "utf8");

  it("Receipts' freshCount is the LINE's prefix, never the badge", () => {
    expect(SHELL).toMatch(/freshCount=\{receiptsPartition\.fresh\.length\}/);
    expect(SHELL).not.toMatch(/freshCount=\{receiptsNew\}/);
  });

  it("and the rail's two stream badges are the selector's own count", () => {
    expect(SHELL).toMatch(/const readsNew = partition\.newCount;/);
    expect(SHELL).toMatch(/const receiptsNew = receiptsPartition\.newCount;/);
  });

  it("the phone's dock reads the same field rather than counting rows itself", () => {
    // `items.filter(unread)` here was a third answer to the badge question — and once a pinned
    // row is projected unread it would have counted pins as new mail.
    expect(DOCK).toMatch(/reads: w\.reads\.newCount/);
    expect(DOCK).toMatch(/receipts: w\.receipts\.newCount/);
    expect(DOCK).not.toMatch(/w\.reads\.items\.filter/);
  });

  it("the panes' own '{count} new' headline is the badge, not the line's position", async () => {
    /**
     * Review round 2's one finding, and it was a correct one about round 1's fix: giving the
     * Receipts view its position back (`fresh.length`) also gave its HEADLINE that number,
     * because the view derived both from one prop — so the pane said "3 new" beside a rail
     * saying "1", which is the reported defect re-created two inches apart. The headline is a
     * COUNT and reads the badge; only the slice and the waterline read the position.
     */
    const pile = [
      msg({ id: "n0", date: d(0), unread: true, folder: "ohmail/News" }),
      ...Array.from({ length: 4 }, (_, i) =>
        msg({ id: `r${i}`, date: d(i + 1), unread: false, lastReadAt: d(i + 1), folder: "ohmail/News" })),
    ];
    // The anchor is two visits stale: three rows above the line, ONE of them unread — so the
    // position (3) and the badge (1) genuinely differ and the assertion cannot pass by luck.
    const reader = await mirrorOf(pile, { view: "reads", newestSeenId: "r2" });
    const part = feedPartition(reader, "reads");
    expect(part.fresh).toHaveLength(3);
    expect(part.newCount).toBe(1);

    const { ReadsView } = await import("../app/views/ReadsView.js");
    const { KeymapProvider } = await import("../../../test/support/keymap-provider");
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: NOW,
          children: h(KeymapProvider as never, {
            children: h(ReadsView as never, {
    settled: true, owed: false,
              partition: part, tags: [], now: NOW, cur: null, onCur: () => {},
              aiChip: null, chipState: null, onChipState: () => {}, markSeen: () => {},
              bodyOf: () => ({ text: "", state: "full" }), hydrateBody: () => {},
              jumpTo: null, onJumped: () => {}, onAction: () => {},
            }),
          }),
        }),
      );
    });
    const metas = Array.from(host.querySelectorAll(".meta, .meta.num")).map((e) => e.textContent);
    expect(metas.some((t2) => t2?.includes("1 new")), `Reads' headline is not the badge: ${metas.join(" | ")}`)
      .toBe(true);
    expect(metas.some((t2) => t2?.includes("3 new")), "Reads' headline shows the line's position")
      .toBe(false);
  });

  it("and Receipts' rendered headline is the badge while its list still slices at the position", async () => {
    // Mounted, not read as text: the first draft of this guard asserted the SOURCE said
    // `count: shownNew`, and a mutation that kept the name while changing its value
    // (`shownNew = fresh`) sailed through. The rendered number cannot be fooled that way.
    const rows = [
      msg({ id: "n0", date: d(0), unread: true, folder: "ohmail/Receipts" }),
      ...Array.from({ length: 4 }, (_, i) =>
        msg({ id: `r${i}`, date: d(i + 1), unread: false, lastReadAt: d(i + 1), folder: "ohmail/Receipts" })),
    ];
    const reader = await mirrorOf(rows, { view: "receipts", newestSeenId: "r2" });
    const part = feedPartition(reader, "receipts");
    expect(part.fresh).toHaveLength(3);
    expect(part.newCount).toBe(1);

    const { ReceiptsView } = await import("../app/views/ReceiptsView.js");
    const { KeymapProvider } = await import("../../../test/support/keymap-provider");
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: NOW,
          children: h(KeymapProvider as never, {
            children: h(ReceiptsView as never, {
    settled: true, owed: false,
              messages: [...part.fresh, ...part.seen], waterline: part.waterline,
              freshCount: part.fresh.length, newCount: part.newCount,
              tags: [], now: NOW, cur: null, onCur: () => {},
              unreadCount: 1, isUnread: (m: EngineMessage) => m.unread, markSeen: () => {},
              bodyOf: () => ({ text: "", state: "full" }), hydrateBody: () => {},
              jumpTo: null, onJumped: () => {}, onAction: () => {},
            }),
          }),
        }),
      );
    });
    const text = host.textContent ?? "";
    expect(text.includes("1 new"), "Receipts' headline is not the badge").toBe(true);
    expect(text.includes("3 new"), "Receipts' headline shows the line's position").toBe(false);
    // …and the shell feeds the badge the rail shows, so the mounted number above is the
    // number the product binds — the one seam a view test cannot reach by itself.
    expect(SHELL).toMatch(/newCount=\{receiptsNew\}/);
  });

  it("Receipts' badge agrees between the phone and the selector", async () => {
    const pile = [
      msg({ id: "rc0", date: d(0), unread: true, folder: "ohmail/Receipts" }),
      ...Array.from({ length: 5 }, (_, i) =>
        msg({ id: `rc${i + 1}`, date: d(i + 1), unread: false, lastReadAt: d(i + 1), folder: "ohmail/Receipts" })),
      /* An old receipt left unread on purpose, BELOW the line — the row that separates "new
         since the last visit" from "unread anywhere in the pile". Without it the phone's old
         whole-stream count and the selector's agree by coincidence and the guard proves
         nothing. */
      msg({ id: "rc-skipped", date: d(8), unread: true, folder: "ohmail/Receipts" }),
    ];
    const reader = await mirrorOf(pile, { view: "receipts", newestSeenId: "rc3" });
    const part = feedPartition(reader, "receipts");
    // The position and the count genuinely differ here — three rows above a stale anchor, one
    // of them unread — so the assertion below is not two equal numbers agreeing by accident.
    expect(part.fresh.map((m) => m.id)).toEqual(["rc0", "rc1", "rc2"]);
    expect(part.newCount).toBe(1);
    expect(liveReceipts(reader, VIEW).newCount).toBe(part.newCount);
  });
});
