/**
 * THE LIST PLACES OVER PLAIN ROWS: the words of their place files in both languages, the plans a test draws them at,
 * and a stamp that prints an instant as the seat would. A test builds its rows, mounts the place and reads by role.
 */
import type { EngineDraft, EngineMessage } from "@ohmail/wire";
import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import type { LayoutPlan, PaneProps, PlaceId, Route } from "../../src/frame/contract.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import addressDe from "../../messages/address.de.json" with { type: "json" };
import addressEn from "../../messages/address.en.json" with { type: "json" };
import draftsDe from "../../messages/drafts.de.json" with { type: "json" };
import draftsEn from "../../messages/drafts.en.json" with { type: "json" };
import folderDe from "../../messages/folder.de.json" with { type: "json" };
import folderEn from "../../messages/folder.en.json" with { type: "json" };
import historyDe from "../../messages/history.de.json" with { type: "json" };
import historyEn from "../../messages/history.en.json" with { type: "json" };
import readerDe from "../../messages/reader.de.json" with { type: "json" };
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import tagsDe from "../../messages/tags.de.json" with { type: "json" };
import tagsEn from "../../messages/tags.en.json" with { type: "json" };
import trashDe from "../../messages/trash.de.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };

export const WORDS: Record<"en" | "de", Messages> = {
  en: {
    ...draftsEn,
    ...trashEn,
    ...historyEn,
    ...tagsEn,
    ...folderEn,
    ...addressEn,
    ...sharedEn,
    reader: readerEn.reader,
  } as Messages,
  de: {
    ...draftsDe,
    ...trashDe,
    ...historyDe,
    ...tagsDe,
    ...folderDe,
    ...addressDe,
    ...sharedDe,
    reader: readerDe.reader,
  } as Messages,
};

export const DESKTOP: LayoutPlan = {
  size: "expanded",
  short: false,
  pointer: "fine",
  device: "desktop",
  pose: null,
  rail: "words",
  columns: 2,
  handles: true,
};
export const PHONE: LayoutPlan = {
  size: "compact",
  short: false,
  pointer: "coarse",
  device: "phone",
  pose: null,
  rail: "dock",
  columns: 1,
  handles: false,
};

export const at = (day: number, hour = 9): string =>
  `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

/** No hit was opened into the place: what a host that stands a list's model itself hands as the frame's one-shot. */
export const NO_HIT = { letter: null, taken: () => undefined } as const;

/**
 * The walk's seat as such a host hands it: the columns that stand, one list, the keys' names. It binds no key, and
 * its first letter rests on arrival: the cases over the tests' door of a mount hold the walk and the arrival.
 */
export const walkAt = (columns: 1 | 2 = 2) => ({
  walk: {
    columns,
    list: "the list",
    labels: { next: "Next", prev: "Previous", open: "Open" },
    say: () => undefined,
  },
  arrival: "rest" as const,
});

/** An instant as a row prints it: the day and the hour, enough to tell rows apart. */
export const stamp = (iso: string): string => iso.slice(5, 16).replace("T", " ");

export function pane(place: PlaceId, over: Partial<Route> = {}, plan: LayoutPlan = DESKTOP): PaneProps {
  return { route: { place, sub: null, open: null, stage: null, words: {}, ...over }, plan, keysHere: true };
}

export function inWords(node: ReactNode, lang: "en" | "de" = "en"): ReactNode {
  return (
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="UTC">
      {node}
    </TextProvider>
  );
}

export function draw(node: ReactNode, lang: "en" | "de" = "en"): RenderResult {
  return render(inWords(node, lang));
}

export function draft(over: Partial<EngineDraft> & { id: string }): EngineDraft {
  return {
    mailboxId: "mb",
    threadId: null,
    inReplyToMessageId: null,
    subject: `About ${over.id}`,
    body: "the first words",
    to: [{ name: "Nadja Lehner", address: "nadja@ex.example" }],
    cc: [],
    bcc: [],
    rationale: null,
    status: "draft",
    createdAt: at(1),
    updatedAt: at(2),
    ...over,
  } as EngineDraft;
}

export interface Plain {
  id: string;
  unread?: boolean;
  threadId?: string;
  date?: string;
  from?: string;
  fromAddress?: string;
  to?: string;
  subject?: string;
  folder?: string;
  mailboxId?: string;
  labels?: string[];
  hasAttachments?: boolean;
}

export function msg(m: Plain): EngineMessage {
  const from = m.from ?? m.id;
  return {
    id: m.id,
    accountId: "a",
    mailboxId: m.mailboxId ?? "mb",
    threadId: m.threadId ?? null,
    messageIdHeader: null,
    subject: m.subject ?? m.id,
    from: { name: from, address: m.fromAddress ?? `${from.toLowerCase().replace(/\s+/g, ".")}@ex.example` },
    to: m.to ? [{ name: m.to, address: m.to }] : [],
    cc: [],
    date: m.date ?? at(2),
    folder: m.folder ?? "INBOX",
    snippet: "the first words",
    unread: m.unread ?? false,
    hasAttachments: m.hasAttachments ?? false,
    attachmentCount: m.hasAttachments ? 1 : 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: m.labels ?? [],
    remoteContent: "none",
    updatedAt: m.date ?? at(2),
  } as unknown as EngineMessage;
}
