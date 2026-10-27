/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore, triagePiles, type EngineMessage, type MessageStateDTO, type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { TriageView } from "../app/views/TriageView";
import { KeymapProvider } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";

/**
 * AS IT WAS SEEN: a letter in Answer Later deleted on the mail server left the pane
 * reading "Answer Later 7" and "19 items" over six letters, plus a seventh row whose only text was
 * the letter's bare id. The piles are derived the shell's way (`triagePiles` over the mirror) and
 * rendered through the real view: six rows, no row reading an id, and the count says six. The
 * deleted letter's case holds under either mechanism alone (the store cascade or the selector);
 * the third case is the selector's own, red with its arm reverted.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

const ISO = "2026-10-12T01:19:58.000Z";
const NOW = new Date("2026-10-12T01:48:33.000Z");
const GHOST = "94179640-1ad8-43bf-8863-bccdd7b58e2b";
const id = (i: number) => (i === 6 ? GHOST : `00000000-0000-4000-8000-00000000000${i}`);

const letter = (i: number): EngineMessage =>
  ({
    id: id(i), accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `letter ${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: `2026-08-2${i}${"T"}09:00:00.000Z`, folder: "INBOX", snippet: `snippet ${i}`, unread: false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;

const claim = (i: number, seq: number): SyncChange => ({
  type: "message_state", op: "update", id: `state-row:${id(i)}`, seq, updatedAt: ISO,
  entity: { messageId: id(i), state: "reply_later", bubbleUpAt: null, setAt: ISO, updatedAt: ISO } as unknown as MessageStateDTO,
});

let roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  document.body.innerHTML = "";
});

async function render(store: MemoryMirrorStore): Promise<HTMLElement> {
  const piles = triagePiles(store);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={NOW} timeZone="UTC">
        <KeymapProvider><WithListGone>
          <TriageView onMarkSeen={() => {}} settled owed={false} piles={piles} pile="reply" onPile={() => {}} frDone={new Set<string>()}
            onStartFR={() => {}} messageOf={(m) => store.get<EngineMessage>("message", m) ?? null}
            tags={[]} now={NOW} onOpen={() => {}} hydrateBody={() => {}} onAction={() => {}} onAddTag={() => {}} />
        </WithListGone></KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
  return host;
}

function read(host: HTMLElement) {
  const rows = [...host.querySelectorAll(".view-triage .row")];
  return {
    letters: host.querySelectorAll(".view-triage .row[data-id]").length,
    rows: rows.length,
    idRow: rows.some((r) => (r.textContent ?? "").includes(GHOST)),
    text: host.textContent ?? "",
  };
}

async function sevenParked(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  const changes: SyncChange[] = [];
  for (let i = 0; i < 7; i++) {
    changes.push({ type: "message", op: "create", id: id(i), seq: 2 * i + 1, updatedAt: ISO, entity: letter(i) });
    changes.push(claim(i, 2 * i + 2));
  }
  await store.applyChanges(changes);
  return store;
}

describe("a letter deleted on the server is not drawn in Answer Later, and the count agrees", () => {
  it("seven parked letters draw seven rows (the positive control)", async () => {
    const r = read(await render(await sevenParked()));
    expect([r.letters, r.rows]).toEqual([7, 7]);
    expect(r.text).toContain("Answer Later 7");
  });

  it("the sync that deletes the seventh letter leaves six rows, no id row, and 'Answer Later 6'", async () => {
    const store = await sevenParked();
    await store.applyChanges([{ type: "message", op: "delete", id: GHOST, seq: 100, updatedAt: "2026-10-12T01:39:38.903Z" }]);
    const r = read(await render(store));
    expect([r.letters, r.rows, r.idRow]).toEqual([6, 6, false]);
    expect(r.text).toContain("Answer Later 6");
    expect(r.text).toContain("6 items");
  });

  it("a claim kept over a letter this mirror does not hold is not drawn either", async () => {
    const store = await sevenParked();
    await store.prune([{ type: "message", id: GHOST }]);
    expect(store.record("message_state", `state-row:${GHOST}`)?.entity).toBeTruthy();
    const r = read(await render(store));
    expect([r.letters, r.rows, r.idRow]).toEqual([6, 6, false]);
    expect(r.text).toContain("Answer Later 6");
  });
});
