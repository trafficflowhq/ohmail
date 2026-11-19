/**
 * THE OHBOX's OWN LIST OVER PLAIN ROWS, for the older tests that handed today's `OhboxView` its lists already cut:
 * the real behaviour hook (`useOhboxList`) fed the case's rows, the list drawn from its model with the place's words,
 * beside it what a shell would say. Share ohbox-1's helper (the join folds it): it is
 * `packages/app/test/ohbox/ohbox-world.tsx`'s `ohbox()` with the list's parts imported from their own files, as the
 * seat imports them (`ohbox/Seat.tsx`), not through `ohbox/index.ts`, which no host's entry reaches.
 */
import { render, type RenderResult } from "@testing-library/react";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import { DEFAULT_AFTER_VERB } from "@ohmail/app-logic/press/after-verb";
import { rowAddress, senderName } from "@ohmail/app-logic/text/format";
import { useSentLabel } from "@ohmail/app-logic/text/row-copy";
import type { LayoutPlan, PaneProps, Route } from "../../../packages/app/src/frame/contract.js";
import type { OhboxBeside } from "../../../packages/app/src/ohbox/beside.js";
import { OhboxAbove } from "../../../packages/app/src/ohbox/OhboxAbove.js";
import { OhboxList } from "../../../packages/app/src/ohbox/OhboxList.js";
import { TextProvider, useText, type Messages } from "../../../packages/app/src/text/index.js";
import ohboxEn from "../../../packages/app/messages/ohbox.en.json" with { type: "json" };
import sharedEn from "../../../packages/app/messages/shared.en.json" with { type: "json" };

const WORDS = { ...ohboxEn, ...sharedEn } as Messages;

const DESKTOP: LayoutPlan = {
  size: "expanded",
  short: false,
  pointer: "fine",
  device: "desktop",
  pose: null,
  rail: "words",
  columns: 2,
  handles: true,
};
const ROUTE: Route = { place: "ohbox", sub: null, open: null, stage: null, words: {} };

/** What the list says beside it: names and stamps as a shell words them, and nothing pressed. */
function beside(): OhboxBeside {
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
    pull: { busy: false, run: () => {} },
    keysShown: false,
    go: { screener: () => {}, history: () => {}, mailboxes: () => {}, organize: () => {} },
  };
}

/**
 * `seatWords`: the row's words as the seat makes them (`ohbox/Seat.tsx`: the sender's name and address, and the
 * own-sent label "Me → <name>" from `useSentLabel` over the place's words), for a case about what a row says.
 */
function Ohbox({ input, side, seatWords }: { input: OhboxListInput; side: OhboxBeside; seatWords: boolean }) {
  const sentLabelOf = useSentLabel(useText("ohbox"));
  if (seatWords) {
    input = { ...input, senderName, sentLabelOf };
    side = { ...side, words: { ...side.words, name: senderName, address: (m) => rowAddress(m), sentTo: (m) => sentLabelOf(m) } };
  }
  const model = useOhboxList(input);
  const pane: PaneProps = { route: ROUTE, plan: DESKTOP, keysHere: true };
  return (
    <OhboxAbove model={model} beside={side}>
      <OhboxList {...pane} />
    </OhboxAbove>
  );
}

/** The input record over plain rows, `over` spread last; the selection redrawn when the list moves it. */
export function ohboxList(over: Partial<OhboxListInput>, opts: { seatWords?: boolean } = {}): RenderResult {
  let props: OhboxListInput = {
    demo: false,
    newForYou: [],
    previouslySeen: [],
    tags: [],
    now: new Date("2026-08-02T12:00:00.000Z"),
    selectedId: null,
    onSelect: (id) => {
      props = { ...props, selectedId: id };
      view.rerender(tree());
    },
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
  const side = beside();
  const tree = () => (
    <TextProvider locale="en" messages={WORDS} timeZone="UTC">
      <Ohbox input={props} side={side} seatWords={opts.seatWords === true} />
    </TextProvider>
  );
  const view = render(tree());
  return view;
}
