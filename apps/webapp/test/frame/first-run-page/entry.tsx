/**
 * THE FIRST RUN'S PAGE, BUNDLED FOR A REAL BROWSER: the product's providers, the intl shell over the English catalogue,
 * and the web shell in the frame (`_todays-shell`) over an engine of its own, with a first-run door, the mailbox read
 * and the consent read the entries hand. One mailbox is connected and not yet organized, so `#/first-run` opens setup
 * on its Organize step. What the door was asked is kept on `window.firstRunAsked` for the test to read.
 */
import { createRoot } from "react-dom/client";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { Providers } from "../../../app/(product)/providers";
import { LocaleShell } from "../../../app/(product)/LocaleShell";
import { AppShell } from "../../_todays-shell";
import en from "../../../messages/en.json";
import "../../../app/app.css";
import "../../../app/zero-layout.css";

const NOW = new Date("2026-11-17T09:00:00.000Z");
const seedReview = new URLSearchParams(window.location.search).has("seed-review");
const sender = "writer" + "@" + "example.invalid";
const asked = { organize: 0, complete: 0, ai: [] as boolean[] };
(window as unknown as { firstRunAsked: typeof asked }).firstRunAsked = asked;

/* The mailbox as `GET /mailboxes` answers it: connected, nobody's organizer yet, nothing agreed. */
let consentedAt: string | null = seedReview ? NOW.toISOString() : null;
let importedAt: string | null = null;
let completedAt: string | null = seedReview ? NOW.toISOString() : null;
const mailbox = (): MailboxFacts => ({
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: NOW.toISOString(), createdAt: "2026-11-17T08:00:00.000Z",
  organizerRole: "organizer", organizedBy: null, organizeConsentedAt: consentedAt,
  initialImportCompletedAt: importedAt,
} as MailboxFacts);

const consentTransport = {
  foldersStorable: true,
  state: async () => ({
    seedConfirmedAt: null, screeningResetAt: null, dormancyDays: 60, foldersEnabledAt: null,
    onboardingCompletedAt: completedAt,
  }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: null }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};

const firstRun: FirstRunHost = {
  door: "cloud",
  ai: "unset",
  probe: async () => ({ host: "imap.example.invalid", user: "me", folders: 3 }),
  connect: async () => ({ id: "mb1" }),
  organize: async () => {
    asked.organize += 1;
    consentedAt = NOW.toISOString();
    /* The first pull ends at once: an empty mailbox. */
    importedAt = NOW.toISOString();
    return "stored";
  },
  complete: async () => {
    asked.complete += 1;
    completedAt = NOW.toISOString();
  },
  setAiEnabled: async (enabled) => {
    asked.ai.push(enabled);
    (firstRun as { ai: FirstRunHost["ai"] }).ai = enabled ? "on" : "off";
  },
  forgetMailbox: async () => {},
  probeReason: () => null,
  probeMessage: () => null,
};

const store = new MemoryMirrorStore();
const engine = new OhmailEngine({
  store,
  now: () => NOW,
  adapter: {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => ({
      text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    }),
  },
} as never);

document.documentElement.lang = "en";
void store.load().then(async () => {
  if (seedReview) {
    const stamp = NOW.toISOString();
    await store.applyChanges([
      {
        type: "rule", op: "create", id: "r1", seq: 1, updatedAt: stamp,
        entity: {
          id: "r1", kind: "sender", match: sender, destination: "INBOX", enabled: true, createdAt: stamp,
        },
      },
      ...["First review fixture", "Second review fixture"].map((subject, index) => {
        const id = `m${index + 1}`;
        return {
          type: "message", op: "create", id, seq: index + 2, updatedAt: stamp,
          entity: {
            id, subject, accountId: "a1", mailboxId: "mb1", threadId: id, folder: "INBOX",
            from: { address: sender, name: "Fixture writer" }, to: [], cc: [], date: stamp,
            unread: false, labels: [], snippet: "Fixture message", updatedAt: stamp,
          },
        };
      }),
    ] as never);
  }

  createRoot(document.getElementById("app")!).render(
    <Providers>
      <LocaleShell initialLocale="en" initialMessages={en}>
        <AppShell
          engine={engine as never}
          consentTransport={consentTransport as never}
          mailboxFacts={async () => [mailbox()]}
          firstRun={firstRun}
        />
      </LocaleShell>
    </Providers>,
  );
});
