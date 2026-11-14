/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MemoryMirrorStore, type EngineMessage, type Folder, type RuleDTO, type StayedWhy, type SyncChange } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";
import { screeningReadBack } from "@ohmail/app-logic/press/press-verdict";

/**
 * A MESSAGE ANOTHER MAIL APP FILED IS NOT AT THE RULE'S PLACE. With "also move"
 * on, the server moved the five messages ohmail had filed and left the one another app had moved
 * into a folder of the person's own: the wire read INBOX 5, Fixture 1. The sheet must say the
 * split the wire has, and name why the one stayed. The seam is the sheet's own placement
 * (`sender-screening.ts#subjectOf`): a folder of the person's own is no place it counts.
 */
const ADDR = "letters@vendor.example";
const NOW = "2026-10-02T21:00:00.000Z";
let seq = 0;

function msg(id: string, folder: Folder, date: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Issue ${id}`,
    from: { name: null, address: ADDR }, to: [], cc: [], date, folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW,
  };
}
const rule = (): RuleDTO => ({
  id: "r-1", kind: "sender", match: ADDR, destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW, updatedAt: NOW, subjectContains: null, bodyContains: null,
  retro: { requestedAt: NOW, doneAt: NOW },
} as RuleDTO);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

/** Five in INBOX where the rule's pass put them; `fixture` adds the one another app filed. */
async function render(o: { fixture: boolean; placeOf?: Map<string, Folder | null>; putAway?: boolean }) {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => msg(`in-${i}`, "INBOX", `2026-09-${String(30 - i).padStart(2, "0")}${"T"}09:00:00.000Z`)),
    ...(o.fixture ? [msg("fix-1", "Fixture" as Folder, "2026-09-20T09:00:00.000Z")] : []),
    // A Trash and a Junk copy: the person put these away, so no count and no line names them.
    ...(o.putAway ? [msg("trash-1", "Trash" as Folder, "2026-09-19T09:00:00.000Z"), msg("junk-1", "INBOX/Junk" as Folder, "2026-09-18T09:00:00.000Z")] : []),
  ];
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW, entity: m })),
    { type: "rule", op: "create", id: "r-1", seq: ++seq, updatedAt: NOW, entity: rule() },
  ] as SyncChange[]);
  const sender = senderScreening(store, "in-0", undefined, o.placeOf)!;
  // The server's answer for an 'external' row, wherever it sits (why-stayed.ts).
  const stayedFor = vi.fn(async (ids: readonly string[]) =>
    new Map(ids.filter((id) => id !== "in-0" && !id.startsWith("in-")).map((id) => [id, "filed-elsewhere" as StayedWhy] as const)));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en,
      children: React.createElement(SenderMenu, {
        state: { messageId: "in-0", x: 0, y: 0 } as never, sender,
        onChoose: () => undefined, onOpenDetail: () => undefined, onClose: () => undefined, stayedFor, onMoveToo: vi.fn(),
      }),
    }));
  });
  await act(async () => { await Promise.resolve(); });
  const lines = [...host.querySelectorAll(".sm-stayed-line")].map((l) => l.querySelector("span")!.textContent!);
  const back = screeningReadBack(store, "in-0", undefined, "ohbox", "sender", {
    consent: { known: true, standalone: false, dormancyDays: 60, screeningBaselineAt: null, screeningScope: "window", foldersEnabled: false },
    now: new Date(NOW), ownAddresses: ["me@home.example"], retro: true,
  });
  return { now: host.querySelector(".sm-now")!.textContent!, lines, stayedFor, back };
}

describe("the sheet's split is the wire's when another mail app filed one", () => {
  it("with no partition supplied: 5 in the Ohbox and 1 in Fixture, and the one says why", async () => {
    const r = await render({ fixture: true });
    // The why-stayed ask is keyed on the rows the split counts away from the rule's place.
    expect(r.stayedFor).toHaveBeenCalledWith(["fix-1"]);
    expect(r.now).toBe("6 messages — Ohbox 5 · Fixture 1");
    expect(r.lines).toEqual(["1 stays in Fixture: filed in another mail app."]);
  });

  it("with the lists' partition (a folder of the person's own keeps its place)", async () => {
    const placeOf = new Map<string, Folder | null>([["fix-1", "Fixture" as Folder]]);
    const r = await render({ fixture: true, placeOf });
    expect(r.now).toBe("6 messages — Ohbox 5 · Fixture 1");
    expect(r.lines).toEqual(["1 stays in Fixture: filed in another mail app."]);
  });

  it("positive control: a sender ohmail filed all of reads as before and asks nothing", async () => {
    const r = await render({ fixture: false });
    expect(r.now).toBe("5 messages — now in Ohbox");
    expect(r.stayedFor).not.toHaveBeenCalled();
    expect(r.lines).toEqual([]);
    expect(r.back?.verdict).toEqual({ key: "none" });
  });

  it("Trash and Junk copies are in no count and no line, beside the Fixture one", async () => {
    const r = await render({ fixture: true, putAway: true });
    expect(r.now).toBe("6 messages — Ohbox 5 · Fixture 1");
    expect(r.stayedFor).toHaveBeenCalledWith(["fix-1"]);
    expect(r.lines).toEqual(["1 stays in Fixture: filed in another mail app."]);
    expect(r.back?.verdict).toMatchObject({ key: "still", count: 5, still: 1, ids: ["fix-1"] });
  });

  it("Trash and Junk alone change nothing: 5, now in Ohbox, and 'all' after the press", async () => {
    const r = await render({ fixture: false, putAway: true });
    expect(r.now).toBe("5 messages — now in Ohbox");
    expect(r.stayedFor).not.toHaveBeenCalled();
    expect(r.back?.verdict).toEqual({ key: "none" });
  });

  it("the press's after-sentence says the one that stayed, never 'all 5' over six", async () => {
    // `screening.verdictAll` ("All 5 from … are in Ohbox.") is said only on `none`.
    const r = await render({ fixture: true });
    expect(r.back?.verdict).toMatchObject({ key: "still", count: 5, still: 1, stillPlace: "Fixture", ids: ["fix-1"] });
  });
});
