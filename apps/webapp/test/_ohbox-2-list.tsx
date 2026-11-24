/**
 * THE OHBOX's OWN LIST OVER PLAIN ROWS, REDRAWN WITH NEW ROWS: share ohbox-2's helper (the join folds it into
 * `_ohbox-1-list.tsx`, whose `ohboxList` draws the same composition once). A case that hands the list new groups while
 * it stands (mail arriving deep in a scroll) calls `redraw` with the new input: the same tree, its scroller and its
 * window kept, as today's harness re-rendered `OhboxView` with new lists. The list's parts are imported from their own
 * files, as the seat imports them (`ohbox/Seat.tsx`).
 */
import { act, render, type RenderResult } from "@testing-library/react";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import { DEFAULT_AFTER_VERB } from "@ohmail/app-logic/press/after-verb";
import type { PaneProps } from "../../../packages/app/src/frame/contract.js";
import type { OhboxBeside } from "../../../packages/app/src/ohbox/beside.js";
import { OhboxAbove } from "../../../packages/app/src/ohbox/OhboxAbove.js";
import { OhboxList } from "../../../packages/app/src/ohbox/OhboxList.js";
import { OhboxListFrame } from "./_ohbox-1-list.js";

/** What the list says beside it: names and stamps as a shell words them, and nothing pressed. */
const BESIDE: OhboxBeside = {
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
  pull: { busy: false, run: () => {} },
  keysShown: false,
  go: { screener: () => {}, history: () => {}, mailboxes: () => {}, organize: () => {} },
};

function Ohbox({ input, pane }: { input: OhboxListInput; pane: PaneProps }) {
  const model = useOhboxList(input);
  return (
    <OhboxAbove model={model} beside={BESIDE}>
      <OhboxList {...pane} />
    </OhboxAbove>
  );
}

/** The input record over plain rows, `over` spread last (as `_ohbox-1-list.tsx`'s `ohboxList`). */
function inputOf(over: Partial<OhboxListInput>): OhboxListInput {
  return {
    demo: false,
    newForYou: [],
    previouslySeen: [],
    tags: [],
    now: new Date("2026-08-02T12:00:00.000Z"),
    selectedId: null,
    onSelect: () => {},
    onEnterReader: () => {},
    onMarkSeen: () => {},
    readerId: null,
    readSetFor: (id) => [id],
    doorbellInitials: [],
    doorbellCount: 0,
    settled: true,
    owed: false,
    onDoorbell: () => {},
    onAction: () => {},
    onAddTag: () => {},
    onMarkAllRead: () => {},
    bulk: { run: () => true, tag: () => {}, screenPreview: () => ({ senders: 1, messages: 2, rules: 0 }), screen: () => true },
    t: (key) => key,
    columnHidden: () => false,
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

/** The list drawn over `over`; `redraw` hands the standing list a new input (its tree and scroller kept). */
export function ohboxListRedrawable(over: Partial<OhboxListInput>): {
  view: RenderResult;
  redraw: (next: Partial<OhboxListInput>) => Promise<void>;
} {
  const tree = (input: OhboxListInput) => (
    <OhboxListFrame list={(pane) => <Ohbox input={input} pane={pane} />} />
  );
  const view = render(tree(inputOf(over)));
  return {
    view,
    redraw: async (next) => {
      await act(async () => {
        view.rerender(tree(inputOf(next)));
      });
    },
  };
}
