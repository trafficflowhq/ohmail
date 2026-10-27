/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { TagView } from "../app/views/TagView";
import { TriageView } from "../app/views/TriageView";
import { KeymapProvider } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import { ESTIMATED_ROW_PX, FALLBACK_VIEWPORT_PX } from "../app/shell/list-window";

/**
 * A TAG AND A TRIAGE PILE MOUNT THEIR WINDOW. Neither list has an upper bound, and both mapped
 * every row into the list column on every visit; both now go through `useListWindow`, so a
 * viewport's rows mount over thousands and the rest is reserved height. Counts, not timers.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const ISO = "2026-08-04T09:00:00.000Z";
const NOW = new Date(ISO);
const N = 1200;
const ROWS_AT_TOP = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1 + 8;
const tag: TagDTO = { id: "t1", name: "Studio" } as TagDTO;

const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet ${i}`, unread: false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: ["t1"], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

let roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  document.body.innerHTML = "";
});

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={NOW} timeZone="UTC">
        <KeymapProvider><WithListGone>{node}</WithListGone></KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
  return host;
}

const common = {
  onMarkSeen: () => {},
  tags: [tag], now: NOW, onOpen: () => {}, hydrateBody: () => {}, onAction: () => {}, onAddTag: () => {},
};

describe("the Tag and Triage lists are windows", () => {
  it("a long tag mounts a viewport's rows, and a short tag renders whole", async () => {
    const all = Array.from({ length: N }, (_, i) => message(i));
    const big = await mount(
      <TagView settled owed={false} tag={tag} messages={all} onScreen={() => {}} canDelete={() => true} canReplyAll={() => true} {...common} />,
    );
    expect(big.querySelectorAll(".view-tag .row[data-id]").length).toBe(ROWS_AT_TOP);
    const small = await mount(
      <TagView settled owed={false} tag={tag} messages={all.slice(0, 30)} onScreen={() => {}} canDelete={() => true} canReplyAll={() => true} {...common} />,
    );
    expect(small.querySelectorAll(".view-tag .row[data-id]").length).toBe(30);
  });

  it("an Answer Later pile of 1 200 mounts a viewport's rows, and a short pile renders whole", async () => {
    const all = Array.from({ length: N }, (_, i) => message(i));
    const byId = new Map(all.map((m) => [m.id, m]));
    const pile = (n: number) => ({
      replyLater: all.slice(0, n).map((m) => ({ messageId: m.id, title: m.subject })),
      setAside: [], resurface: [],
    });
    const view = (n: number) => (
      <TriageView settled owed={false}
        piles={pile(n)} pile="reply" onPile={() => {}} frDone={new Set<string>()} onStartFR={() => {}}
        messageOf={(id) => byId.get(id) ?? null} {...common}
      />
    );
    const big = await mount(view(N));
    expect(big.querySelectorAll(".view-triage .row[data-id]").length).toBe(ROWS_AT_TOP);
    const small = await mount(view(30));
    expect(small.querySelectorAll(".view-triage .row[data-id]").length).toBe(30);
  });
});
