/**
 * THE OHBOX OVER PLAIN ROWS: the real behaviour hook fed plain letters, the list drawn from its model with the
 * words of the place files, beside it what a shell would say. A test moves the inputs and reads by role and name.
 */
import type { EngineMessage } from "@ohmail/wire";
import { render, type RenderResult } from "@testing-library/react";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import { DEFAULT_AFTER_VERB } from "@ohmail/app-logic/press/after-verb";
import type { LayoutPlan, PaneProps, Route } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { NONE } from "../../src/host/index.js";
/* The list's parts from their own files, as the seat imports them (`ohbox/Seat.tsx`). */
import { OhboxAbove } from "../../src/ohbox/OhboxAbove.js";
import { OhboxList } from "../../src/ohbox/OhboxList.js";
import { ohboxPlace } from "../../src/ohbox/place.js";
import type { OhboxBeside } from "../../src/ohbox/beside.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import ohboxDe from "../../messages/ohbox.de.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import frameDe from "../../messages/frame.de.json" with { type: "json" };
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";

/** The fixture has no sent replies awaiting a mailbox copy. Other engine reads stay guarded. */
export function engineWithEmptyReplyMirror() {
  const store = {
    stampOf(kind: string) {
      if (kind !== "message" && kind !== "view_meta") throw new Error(`unexpected mirror stamp for ${kind}`);
      return 0;
    },
    entries(kind: string) {
      if (kind !== "view_meta") throw new Error(`unexpected mirror rows for ${kind}`);
      return [];
    },
  };
  return new Proxy(NO_ENGINE, {
    get(engine, key) {
      return key === "store" ? store : Reflect.get(engine, key);
    },
  });
}

export const WORDS: Record<"en" | "de", Messages> = {
  en: { ...frameEn, ...ohboxEn, ...sharedEn } as Messages,
  de: { ...frameDe, ...ohboxDe, ...sharedDe } as Messages,
};

export const at = (hour: number, minute = 0): string =>
  `2026-08-02T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

export interface Plain {
  id: string;
  unread?: boolean;
  threadId?: string;
  date?: string;
  from?: string;
  subject?: string;
  folder?: string;
  file?: boolean;
}

export function msg(m: Plain): EngineMessage {
  const from = m.from ?? m.id;
  return {
    id: m.id,
    accountId: "a",
    mailboxId: "mb",
    threadId: m.threadId ?? null,
    messageIdHeader: null,
    subject: m.subject ?? m.id,
    from: { name: from, address: `${from.toLowerCase().replace(/\s+/g, ".")}@ex.example` },
    to: [],
    cc: [],
    date: m.date ?? at(9),
    folder: m.folder ?? "INBOX",
    snippet: "the first words",
    unread: m.unread ?? true,
    hasAttachments: m.file ?? false,
    attachmentCount: m.file ? 1 : 0,
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
    updatedAt: at(9),
  } as unknown as EngineMessage;
}

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
const ROUTE: Route = { place: "ohbox", sub: null, open: null, stage: null, words: {} };

export interface Said {
  marked: Array<{ ids: string[]; unread: boolean }>;
  bulk: Array<{ action: string; ids: string[] }>;
  went: string[];
  pulled: number;
  markedAll: string[][];
}

export function beside(said: Said, over: Partial<OhboxBeside> = {}): OhboxBeside {
  return {
    words: {
      name: (m) => m.from.name ?? m.from.address,
      address: (m) => m.from.address,
      stamp: () => ({ when: "09:00" }),
      sentTo: () => null,
      mailbox: (a) => a,
      tag: () => null,
    },
    mail: { mailboxes: 1, screenerCandidate: false, arrived: 0 },
    doorbell: { count: 0, settled: true },
    notOrganizing: null,
    pull: {
      busy: false,
      run: () => {
        said.pulled += 1;
      },
    },
    keysShown: false,
    go: {
      screener: () => said.went.push("screener"),
      history: () => said.went.push("history"),
      mailboxes: () => said.went.push("mailboxes"),
      organize: (id) => said.went.push(`organize:${id}`),
    },
    ...over,
  };
}

function Ohbox({
  input,
  side,
  plan,
  open,
}: {
  input: OhboxListInput;
  side: OhboxBeside;
  plan: LayoutPlan;
  open: string | null;
}) {
  const model = useOhboxList(input);
  const pane: PaneProps = { route: { ...ROUTE, open }, plan, keysHere: true };
  return (
    <OhboxAbove model={model} beside={side}>
      <OhboxList {...pane} />
    </OhboxAbove>
  );
}

export interface World {
  said: Said;
  view: RenderResult;
  again(next: Partial<OhboxListInput>, side?: Partial<OhboxBeside>): void;
}

/**
 * The default input record over plain rows, `over` spread last. Its `onSelect` moves nothing: `ohbox()` hands its own
 * (the selection redrawn), and a test that stands the model elsewhere hands the one its address writes.
 */
export function inputOf(said: Said, over: Partial<OhboxListInput> = {}): OhboxListInput {
  return {
    demo: false,
    newForYou: [],
    previouslySeen: [],
    tags: [],
    now: new Date(at(12)),
    selectedId: null,
    onSelect: () => {},
    onEnterReader: () => {},
    onMarkSeen: (ids, unread) => {
      said.marked.push({ ids, unread });
    },
    readerId: null,
    readSetFor: (id) => [id],
    doorbellInitials: [],
    doorbellCount: 0,
    settled: true,
    owed: false,
    onDoorbell: () => {},
    onAction: () => {},
    onAddTag: () => {},
    onMarkAllRead: (ids) => {
      said.markedAll.push(ids);
    },
    bulk: {
      run: (action, ids) => {
        said.bulk.push({ action, ids });
        return true;
      },
      tag: () => {},
      screenPreview: () => ({ senders: 1, messages: 2, rules: 0 }),
      screen: () => true,
    },
    t: (key) => key,
    columnHidden: () => false,
    /* These fixtures drive the list with the default after-verb choice. */
    afterVerb: () => DEFAULT_AFTER_VERB,
    rowSelector: "[data-id]",
    avatarSelector: null,
    anchors: { pickTag: () => null, row: () => null },
    readColRef: { current: null },
    senderName: (m) => m.from.name ?? m.from.address,
    sentLabelOf: () => null,
    ...over,
  };
}

export function ohbox(
  input: Partial<OhboxListInput>,
  opts: { side?: Partial<OhboxBeside>; plan?: LayoutPlan; lang?: "en" | "de"; open?: string | null } = {},
): World {
  const said: Said = { marked: [], bulk: [], went: [], pulled: 0, markedAll: [] };
  let props: OhboxListInput = inputOf(said, {
    onSelect: (id) => {
      props = { ...props, selectedId: id };
      draw();
    },
    ...input,
  });
  let side = beside(said, opts.side);
  const lang = opts.lang ?? "en";
  function List() {
    return <Ohbox input={props} side={side} plan={opts.plan ?? DESKTOP} open={opts.open ?? null} />;
  }
  const { host } = fakeHost({
    engine: engineWithEmptyReplyMirror(),
    service: "self",
    scope: "a",
    places: {
      ohbox: {
        ...ohboxPlace,
        rail: ohboxPlace.rail && { ...ohboxPlace.rail, useCount: undefined },
        panes: { kind: "columns", List, Reading: "reader", keepsOpen: true },
      },
    },
  });
  const tree = () => (
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>
  );
  const view = render(tree());
  function draw() {
    view.rerender(tree());
  }
  return {
    said,
    view,
    again(next, over) {
      props = { ...props, ...next };
      if (over) side = { ...side, ...over };
      draw();
    },
  };
}

export { NONE };
