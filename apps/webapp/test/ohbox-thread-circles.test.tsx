/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * A THREAD ROW WEARS ITS PEOPLE BESIDE ITS SUBJECT.
 *
 * A row that stands for a conversation shows the conversation's faces in the badge strip on its
 * subject line, immediately after the `⤷ N` count — a short stack of small overlapping circles,
 * drawn by the same avatar helpers every other circle in the app uses. The row's LEAD is
 * untouched by all of this: it is the latest sender's one full-size circle, on a thread row
 * exactly as on a singleton, because the lead is where a row's text column begins and a list
 * whose left edge moved as conversations folded would be the worse trade.
 *
 * The guards here pin the three decisions the view makes, none of which is `MessageRow`'s:
 *
 *   · WHICH people. The circles name the same voices the SENDER LINE names — the distinct
 *     unread senders while the conversation is waiting, and the thread's recent participants
 *     (the mirror's `threadParticipants`) once it has all been read. A row whose text says
 *     "Jon Falk, Mila Reyes" and whose circles say something else would be two answers to one
 *     question.
 *   · HOW MANY. Capped, with the overflow already spoken for by `⤷ N` — no second counter.
 *   · WHEN NOT. A singleton row carries no strip circles at all. An own-sent CONVERSATION row
 *     keeps its lead as the RECIPIENT's ("Me → Nora Lindt") — that rule is unchanged — but the
 *     strip stays: the faces name who the conversation is BETWEEN, and the reader answering it
 *     does not change who it is between. The strip used to be suppressed under the Me → label,
 *     which meant every conversation lost its people the moment the reader replied — reported
 *     against a live two-person thread whose list row showed no faces at all.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

/** The account's own identity, the way an ingested Sent row carries it: address only. */
const OWN = { name: null, address: "mila@ohmail.test" };
const at = (hour: number): string => `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`;

interface Row {
  id: string;
  unread: boolean;
  threadId?: string | null;
  date?: string;
  folder?: string;
  from?: { name: string | null; address: string };
  to?: { name: string | null; address: string }[];
}
function msg(m: Row): Record<string, unknown> {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`,
    from: m.from ?? { name: `Sender ${m.id.toUpperCase()}`, address: `${m.id}@ex.example` },
    to: m.to ?? [], cc: [],
    date: m.date ?? at(9), folder: m.folder ?? "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: at(9),
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Props {
  newForYou?: Row[];
  previouslySeen?: Row[];
  /** The mirror's answer for a thread's recent voices, as the shell binds it. */
  participants?: Record<string, { initials: string; hue: number }[]>;
}

async function render(props: Props): Promise<void> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const base = {
    demo: false, settled: true, owed: false,
    older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
    resurfacedRows: [],
    newForYou: (props.newForYou ?? []).map(msg),
    previouslySeen: (props.previouslySeen ?? []).map(msg),
    replyDone: null,
    threadParticipants: (threadId: string) => props.participants?.[threadId] ?? [],
    threadSubject: () => null,
    tags: [], now: new Date(at(13)),
    onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
    onMarkSeen: () => {},
    bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
    doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
  };
  function Wrapper(): React.ReactElement {
    const [sel, setSel] = React.useState<string | null>(null);
    return h(OhboxView as never, {
      ...base, selectedId: sel, onSelect: (id: string) => setSel(id),
    } as never);
  }
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date(at(13)),
    children: h(KeymapProvider as never, { children: h(Wrapper) } as never),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

/** The row holding `id`: its own, or the folded conversation it is a member of. */
const rowEl = (id: string): HTMLElement =>
  (host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`)
    ?? [...host!.querySelectorAll<HTMLElement>(".row[data-ids]")].find((r) => (r.dataset.ids ?? "").split(" ").includes(id)))!;
const circleText = (row: HTMLElement, sel: string): string[] =>
  [...row.querySelectorAll(sel)].map((e) => e.textContent ?? "");

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

describe("Ohbox thread rows carry the conversation's circles beside the subject", () => {
  it("a three-voice unread conversation shows three small circles after ⤷ 3, and is still led by one", async () => {
    setViewport();
    await render({
      newForYou: [
        { id: "a", unread: true, threadId: "T", from: { name: "Ada Lund", address: "ada@ex.example" }, date: at(12) },
        { id: "b", unread: true, threadId: "T", from: { name: "Bo Ek", address: "bo@ex.example" }, date: at(11) },
        { id: "c", unread: true, threadId: "T", from: { name: "Cy Mora", address: "cy@ex.example" }, date: at(10) },
      ],
    });
    const row = rowEl("a");
    // one row for the conversation…
    expect(host!.querySelectorAll(".row[data-id]")).toHaveLength(1);
    // …whose faces sit in the subject LINE's strip — the subject's SIBLING since the
    // badge strip left the truncating `.subj` span (a long subject was silently eating
    // the count and the faces; packages/ui/test/interactions.test.tsx pins the shape) —
    // and the count comes first.
    const badges = row.querySelector(".row-mid .badges")!;
    expect(badges.children[0]!.textContent).toBe("⤷ 3");
    expect(badges.children[1]!.classList.contains("thread-circles")).toBe(true);
    expect(circleText(row, ".thread-circles .av")).toEqual(["A", "B", "C"]);
    // the circles are the SENDER LINE's people, in its order — one answer, not two.
    expect(row.textContent).toContain("Ada Lund, Bo Ek, Cy Mora");
    // and the LEAD is one full-size circle, the latest sender's, exactly as on a plain row.
    const lead = row.firstElementChild!;
    expect(lead.classList.contains("av")).toBe(true);
    expect(lead.classList.contains("s")).toBe(false);
    expect(lead.textContent).toBe("A");
    expect(row.querySelectorAll(".av")).toHaveLength(4); // the lead, plus the three faces
    expect(row.querySelector(".av-stack")).toBeNull();
  });

  it("caps the circles, leaving the overflow to the count that is already there", async () => {
    setViewport();
    await render({
      newForYou: [
        { id: "a", unread: true, threadId: "T", from: { name: "Ada Lund", address: "ada@ex.example" }, date: at(12) },
        { id: "b", unread: true, threadId: "T", from: { name: "Bo Ek", address: "bo@ex.example" }, date: at(11) },
        { id: "c", unread: true, threadId: "T", from: { name: "Cy Mora", address: "cy@ex.example" }, date: at(10) },
        { id: "d", unread: true, threadId: "T", from: { name: "Del Roy", address: "del@ex.example" }, date: at(9) },
        { id: "e", unread: true, threadId: "T", from: { name: "Eve Sten", address: "eve@ex.example" }, date: at(8) },
      ],
    });
    const row = rowEl("a");
    expect(circleText(row, ".thread-circles .av")).toEqual(["A", "B", "C"]);
    expect(row.textContent).toContain("⤷ 5");
  });

  it("an all-read conversation falls back to the mirror's recent participants", async () => {
    setViewport();
    await render({
      previouslySeen: [
        { id: "p1", unread: false, threadId: "T", from: { name: "Ada Lund", address: "ada@ex.example" }, date: at(12) },
        { id: "p2", unread: false, threadId: "T", from: { name: "Bo Ek", address: "bo@ex.example" }, date: at(11) },
      ],
      // deliberately NOT the row's own senders: the faces have to come from this answer, and
      // letters the messages cannot supply are what prove it.
      participants: { T: [{ initials: "X", hue: 10 }, { initials: "Y", hue: 120 }] },
    });
    const row = rowEl("p1");
    // the sender line of a read conversation names only its newest voice; the circles do not
    // stop at one because of that — the thread's people are what the mirror knows.
    expect(circleText(row, ".thread-circles .av")).toEqual(["X", "Y"]);
    // and the lead is still that newest voice's own circle, not the first face in the strip.
    expect(row.firstElementChild!.textContent).toBe("A");
  });

  it("a singleton row has one full-size circle and no strip faces", async () => {
    setViewport();
    await render({
      newForYou: [{ id: "s1", unread: true, from: { name: "Ada Lund", address: "ada@ex.example" }, date: at(12) }],
    });
    const row = rowEl("s1");
    expect(row.querySelector(".thread-circles")).toBeNull();
    expect(circleText(row, ".av")).toEqual(["A"]);
    expect(row.querySelector(".av")!.classList.contains("s")).toBe(false);
  });

  it("an own-sent conversation row keeps the recipient's lead AND the conversation's faces", async () => {
    // The reported shape, verbatim: a two-person exchange whose newest message is the reader's
    // own reply. The Me → rule still owns the LEAD — the row is about the person the reply went
    // to — but the strip beside the subject says who the conversation is between, and answering
    // a conversation does not change who it is between. (The strip was suppressed here once,
    // which removed a thread's faces at the exact moment the reader engaged with it.)
    setViewport();
    await render({
      previouslySeen: [
        { id: "s5", unread: false, threadId: "T", folder: "Sent", from: OWN, to: [{ name: "Nora Lindt", address: "nora@example.net" }], date: at(12) },
        { id: "p1", unread: false, threadId: "T", from: { name: "Nora Lindt", address: "nora@example.net" }, date: at(9) },
      ],
      // the mirror's answer for the thread's voices — the account holder is one of them.
      participants: { T: [{ initials: "M", hue: 10 }, { initials: "N", hue: 120 }] },
    });
    const row = rowEl("s5");
    expect(row.textContent).toContain("Me → Nora Lindt");
    // the lead is the recipient's one full-size circle — unchanged…
    const lead = row.firstElementChild!;
    expect(lead.classList.contains("av")).toBe(true);
    expect(lead.classList.contains("s")).toBe(false);
    expect(lead.textContent).toBe("N");
    // …and the strip still carries the conversation's people, from the mirror's answer.
    expect(circleText(row, ".thread-circles .av")).toEqual(["M", "N"]);
  });

  it("an own-sent SINGLETON row still carries no strip — there is no conversation to name", async () => {
    setViewport();
    await render({
      previouslySeen: [
        { id: "s9", unread: false, folder: "Sent", from: OWN, to: [{ name: "Nora Lindt", address: "nora@example.net" }], date: at(12) },
      ],
    });
    const row = rowEl("s9");
    expect(row.textContent).toContain("Me → Nora Lindt");
    expect(row.querySelector(".thread-circles")).toBeNull();
    expect(circleText(row, ".av")).toEqual(["N"]);
  });
});
