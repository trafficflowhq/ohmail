/**
 * THE TOUCH LAYER'S PAGE, for a real browser under a finger: the real frame over the fake host, with its own host's
 * glass spread over it (the address's cells: `sysb` the system's bottom inset), the Ohbox's place from the real
 * behaviour hook over sixty plain letters, so the list scrolls. What the model is asked to do is counted on
 * `window.touchSaid` for the browser's test to read. Fictional people only.
 */
import { createRoot } from "react-dom/client";
import type { EngineMessage } from "@ohmail/client-engine";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import { DEFAULT_AFTER_VERB } from "@ohmail/app-logic/press/after-verb";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { NONE, type HostContract, type SafeInsets } from "../../src/host/index.js";
import { OhboxAbove, OhboxList, type OhboxBeside } from "../../src/ohbox/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAppearance, fakeWindow, movable, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };

export interface TouchSaid {
  marked: Array<{ ids: string[]; unread: boolean }>;
  acted: Array<[string, string]>;
  opened: string[];
  pulled: number;
  picked: number;
}

const q = new URLSearchParams(location.search);
const sysb = Number(q.get("sysb") ?? "");
const said: TouchSaid = { marked: [], acted: [], opened: [], pulled: 0, picked: 0 };
(window as unknown as { touchSaid: TouchSaid }).touchSaid = said;

const PEOPLE = ["Ada Lund", "Bo Ek", "Cleo Marti", "Dario Rossi", "Elin Berg", "Femi Okoro"];
const letter = (k: number): EngineMessage =>
  ({
    id: `m${k}`,
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Letter ${k}`,
    from: { name: PEOPLE[k % PEOPLE.length], address: `p${k % PEOPLE.length}@ex.example` },
    to: [],
    cc: [],
    date: new Date(Date.UTC(2026, 7, 2, 11, 59 - (k % 60))).toISOString(),
    folder: "INBOX",
    snippet: "the first words of a letter",
    unread: k < 30,
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
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  }) as unknown as EngineMessage;
const ALL = Array.from({ length: 60 }, (_, k) => letter(k));

const input: OhboxListInput = {
  demo: false,
  newForYou: ALL.filter((m) => m.unread),
  previouslySeen: ALL.filter((m) => !m.unread),
  tags: [],
  now: new Date("2026-08-02T12:00:00.000Z"),
  selectedId: null,
  onSelect: (id) => {
    if (id !== null) said.opened.push(id);
  },
  onEnterReader: (id) => {
    said.opened.push(id);
  },
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
  onAction: (action, m) => {
    said.acted.push([action, m.id]);
  },
  onAddTag: () => {},
  onMarkAllRead: () => {},
  bulk: {
    run: () => true,
    tag: () => {},
    screenPreview: () => ({ senders: 1, messages: 1, rules: 0 }),
    screen: () => true,
  },
  t: (key) => key,
  columnHidden: () => true,
  afterVerb: () => DEFAULT_AFTER_VERB,
  rowSelector: "[data-id]",
  avatarSelector: null,
  anchors: { pickTag: () => null, row: () => null },
  readColRef: { current: null },
  senderName: (m) => m.from.name ?? m.from.address,
  sentLabelOf: () => null,
};

const side: OhboxBeside = {
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
  go: { screener: () => {}, history: () => {}, mailboxes: () => {}, organize: () => {} },
};

function OhboxPane({ route, plan }: PaneProps) {
  const model = useOhboxList(input);
  said.picked = model.picked.size;
  return (
    <OhboxAbove model={model} beside={side}>
      <OhboxList route={route} plan={plan} keysHere />
    </OhboxAbove>
  );
}

const ohbox: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List: OhboxPane, Reading: () => null },
};

const made = fakeHost({
  engine: NO_ENGINE,
  service: "self",
  scope: "a",
  places: { ohbox },
  window: fakeWindow({ ...ROOMS.phone, posture: "flat", reducedMotion: true }),
  appearance: fakeAppearance(),
}).host;
const host: HostContract = {
  ...made,
  signals: {
    ...made.signals,
    insets:
      Number.isFinite(sysb) && q.has("sysb")
        ? movable<SafeInsets>({ top: 0, right: 0, bottom: sysb, left: 0 })
        : NONE,
  },
};
document.documentElement.setAttribute("data-face", "paper");
document.documentElement.setAttribute("data-theme", "light");

createRoot(document.getElementById("root")!).render(
  <TextProvider
    locale="en"
    messages={{ ...FRAME_WORDS.en, ...ohboxEn, ...sharedEn } as Messages}
    timeZone="UTC"
  >
    <Frame host={host} />
  </TextProvider>,
);
