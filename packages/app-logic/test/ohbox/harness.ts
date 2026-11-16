/**
 * THE OHBOX'S HOOK OVER PLAIN ROWS: a probe component calls `useOhboxList` with the inputs a test hands it and
 * keeps the model it returned, as the old tests fed the view.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EngineMessage, ResurfacedThreadRow } from "@ohmail/client-engine";
import { useOhboxList, type OhboxListInput, type OhboxListModel } from "../../src/ohbox/index.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** A wide window: the reading column stands, so a press selects and enters rather than opening a sheet. */
export function wide(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }) as unknown as MediaQueryList;
}

export interface Plain {
  id: string;
  unread?: boolean;
  threadId?: string;
  date?: string;
  from?: string;
  folder?: string;
  triage?: EngineMessage["triage"];
}

export const at = (hour: number, minute = 0): string =>
  `2026-08-02T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

/** One message as the engine hands it, from the few fields a case names. */
export function msg(m: Plain): EngineMessage {
  const from = m.from ?? m.id;
  return {
    id: m.id,
    accountId: "a",
    mailboxId: "mb",
    threadId: m.threadId ?? null,
    messageIdHeader: null,
    subject: m.id,
    from: { name: from, address: `${from.toLowerCase().replace(/\s+/g, ".")}@ex.example` },
    to: [],
    cc: [],
    date: m.date ?? at(9),
    folder: m.folder ?? "INBOX",
    snippet: "s",
    unread: m.unread ?? true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: m.triage ?? null,
    labels: [],
    remoteContent: "none",
    updatedAt: at(9),
  } as unknown as EngineMessage;
}

export interface Calls {
  marked: Array<{ ids: string[]; unread: boolean; via?: "glance" }>;
  held: Array<string | null>;
  selected: Array<string | null>;
  bulk: Array<{ action: string; ids: string[] }>;
  entered: string[];
}

export interface Harness {
  readonly model: OhboxListModel;
  readonly calls: Calls;
  /** Hand the hook new inputs, as a publish of the engine does: every array is a new one. */
  publish(next: Partial<OhboxListInput>): Promise<void>;
  run(f: () => void): Promise<void>;
  unmount(): Promise<void>;
}

const words = (key: string): string => key;
const h = React.createElement;

export async function mount(
  initial: Partial<OhboxListInput>,
  opts: { bulkRefuses?: boolean; selectFollows?: boolean } = {},
): Promise<Harness> {
  const calls: Calls = { marked: [], held: [], selected: [], bulk: [], entered: [] };
  let model: OhboxListModel | null = null;
  const readColRef = { current: null as HTMLDivElement | null };
  let props: OhboxListInput;
  const select = (id: string | null) => {
    calls.selected.push(id);
    if (opts.selectFollows !== false) {
      props = { ...props, selectedId: id };
      draw();
    }
  };
  const base: OhboxListInput = {
    demo: false,
    newForYou: [],
    previouslySeen: [],
    tags: [],
    now: new Date(at(12)),
    selectedId: null,
    onSelect: (id) => select(id),
    onEnterReader: (id) => {
      calls.entered.push(id);
    },
    onMarkSeen: (ids, unread, via) => {
      calls.marked.push({ ids, unread, ...(via ? { via } : {}) });
    },
    onHoldRow: (id) => {
      calls.held.push(id);
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
    bulk: {
      run: (action, ids) => {
        calls.bulk.push({ action, ids });
        return !opts.bulkRefuses;
      },
      tag: () => {},
      screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }),
      screen: () => true,
    },
    t: words,
    columnHidden: () => false,
    rowSelector: "[data-id]",
    avatarSelector: null,
    anchors: { pickTag: () => null, row: () => null },
    readColRef,
    senderName: (m) => m.from.name ?? m.from.address,
    sentLabelOf: () => null,
  };
  props = { ...base, ...initial };
  function Probe(p: { input: OhboxListInput }) {
    model = useOhboxList(p.input);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const draw = () => root.render(h(Probe, { input: props }));
  const harness: Harness = {
    get model() {
      return model!;
    },
    calls,
    async publish(next) {
      props = { ...props, ...next };
      await act(async () => {
        draw();
      });
    },
    async run(f) {
      await act(async () => {
        f();
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
  await harness.publish({});
  return harness;
}

export type { EngineMessage, ResurfacedThreadRow };
