import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { confirmSyncOwner, createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { Frame } from "@ohmail/app/frame";
import { keySheetOver } from "@ohmail/app/keys/sheet";
import { paletteOver } from "@ohmail/app/palette";
import { MailGround, mailPlaces } from "@ohmail/app/mail";
import { TextProvider } from "@ohmail/app/text";
import { WebScreenerSubjectRule } from "../app/(product)/mailbox/WebScreenerSubjectRule";
import { BROWSER_READER } from "../app/shell/browser-mail";
import { letter } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import en from "../messages/en.json";

const scope = "screener-fixture";
const now = new Date();
const at = now.toISOString();
const local = "casey-with-a-deliberately-long-mailbox-label";
const full = `${local}@example.invalid`;
const screened = location.pathname === "/screened";
const person = letter("held", {
  accountId: scope,
  mailboxId: "personal",
  folder: screened ? "ohmail/Screened" : "ohmail/Screener",
  subject: "The Screener's test letter",
  from: { name: "Casey Sender", address: screened
    ? "letters@receipts-by-mail-for-different-company-departments.example"
    : "sender@example.invalid" },
  date: at,
  updatedAt: at,
});
const mailboxes: MailboxFacts[] = ["personal", "work"].map((id) => ({
  id,
  address: id === "personal" ? full : "work@example.invalid",
  ...(screened && id === "personal" ? { displayName: "Personal" } : {}),
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedSince: null,
  syncBlockedReason: null,
  lastSyncAt: at,
  createdAt: at,
  organizerRole: "organizer",
  organizerChecked: true,
  organizedBy: null,
  organizeConsentedAt: at,
}));
const store = new MemoryMirrorStore();
await store.load();
await store.applyChanges([{ type: "message", op: "create", id: person.id, seq: 1, updatedAt: at, entity: person }]);
const engine = registerSyncGate(new OhmailEngine({
  store,
  now: () => now,
  adapter: {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "1", hasMore: false, serverTime: at,
    }),
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" }),
    fetchBody: async () => ({
      text: "Only a fixture.", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    }),
  },
}), createSyncGate(scope));
confirmSyncOwner(engine, scope);
await engine.start();

const noWrite = async () => { throw new Error("This fixture does not write consent"); };
const coarse = matchMedia("(pointer: coarse)").matches;
const { host } = fakeHost({
  engine,
  service: "self",
  scope,
  places: mailPlaces(),
  overs: { palette: paletteOver, keys: keySheetOver },
  reader: BROWSER_READER,
  above: ({ children }) => <MailGround subjectRule={WebScreenerSubjectRule}>{children}</MailGround>,
  address: fakeAddress(screened ? "#/screener/screened" : "#/screener/waiting"),
  window: fakeWindow({ pointer: coarse ? "coarse" : "fine", width: innerWidth, height: innerHeight, posture: "flat", reducedMotion: true }),
  mailboxes: async () => mailboxes,
  wires: {
    consent: {
      state: async () => ({ seedConfirmedAt: at, screeningResetAt: null, dormancyDays: 60, foldersEnabledAt: null }),
      setAutoSuggest: noWrite, setDormancyDays: noWrite, setBlockRemoteImages: noWrite,
      setBlockTrackingPixels: noWrite, setBlockAutoUnsubscribe: noWrite, setFoldersEnabled: noWrite,
      setMailboxFoldersEnabled: noWrite, setMailboxSignature: noWrite,
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TextProvider locale="en" messages={en} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>
  </NextIntlClientProvider>,
);
