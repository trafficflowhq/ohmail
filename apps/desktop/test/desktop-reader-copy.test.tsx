/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";
import { mailboxRowWhy } from "../src/install-role.js";
import { desktopNotificationHost } from "../src/notify-host.js";

/**
 * THE FACTS, SUPPLIED BY REPLACING THE ACCESSOR — `desktop-mailboxes.test.ts`'s own pattern.
 *
 * `MailStateProvider` is the shell's 30-second poller and it reads `EngineProvider` on the way up,
 * so standing it up here would mean standing up an engine for a test about three sentences. What
 * the pane reads is ONE value through the NON-throwing accessor, and this is that value.
 *
 * Mocking the accessor rather than the pane is what keeps the case honest: the predicate under
 * test (`screenerReadOnly` over `readerStandDown`) still runs, on real `MailboxFacts`, in the real
 * component.
 */
let FACTS: MailboxFacts[] | null = null;
vi.mock("../../webapp/app/shell/MailStateProvider", () => ({
  useMailboxFacts: () => FACTS,
}));

/**
 * ═══ A READER INSTALL'S PANES READ AS A READER'S ═════════════════════════════════════════════
 *
 * ## WHAT WAS MEASURED — released 0.13.7, a standalone install reading a mailbox ohmail Cloud
 * held the live lease on
 *
 *   · Settings → Desktop and Settings → About: **"Mailbox — The mailbox this copy of ohmail
 *     organizes."** — on a machine whose own Mailboxes pane said, correctly and at the same
 *     moment, *"Organized by ohmail Cloud · This computer reads the mailbox; it moves nothing and
 *     screens nothing."*
 *   · the Remove confirmation's first bullet: **"ohmail stops organizing this mailbox."** — an
 *     install that never organized it.
 *   · Settings → Screener: the Ohbox posture, the automatic-suggestion consent and the
 *     "when a sender goes quiet 60 / 90 / 180 / 365 / All time" window, offered as though this
 *     install screened. Every one inert here, and none said so.
 *
 * ## THE SHAPE OF THE FIX, AND WHAT IS DELIBERATELY NOT DONE
 *
 * The Screener's CONTROLS stay. Their values are stored on this computer and are what the install
 * will screen by the moment somebody takes the mailbox over, so removing them would make setting
 * up ahead of a takeover impossible and would throw away the only record of what this machine
 * believes. What was missing was the sentence, and that is what is added.
 *
 * The two Mailbox rows and the Remove bullet are different: each was a false STATEMENT rather than
 * an inert control, so each changes its words.
 *
 * ## HOW TO WATCH THESE FAIL
 *
 *  · make `mailboxRowWhy` return the organizer sentence unconditionally → the row table goes red;
 *  · delete the `readOnly ?` note from `DesktopScreening` → "the pane says so" goes red with the
 *    posture switch on screen and no sentence, which is the released pane exactly;
 *  · make the Screener note unconditional → the CONTROL case goes red, putting "somebody else
 *    organizes this" over an install that organizes it;
 *  · make `desktopNotificationHost.permission()` answer "default" → the host case goes red, and
 *    that is the arm that left the master switch unpressable on the released build.
 *
 * All four were run.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ROW BOTH INSTALL PANES DRAW
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("mailboxRowWhy — 'organizes' or 'reads', and never the wrong one", () => {
  it("an install that organizes it keeps the sentence it always had", () => {
    expect(mailboxRowWhy(null)).toBe("The mailbox this copy of ohmail organizes.");
  });

  it("a reader says it READS, and names who organizes", () => {
    const said = mailboxRowWhy({ name: "ohmail Cloud" });
    expect(said).toContain("reads");
    expect(said).toContain("ohmail Cloud");
    expect(said, "the released sentence claimed work this install never did")
      .not.toContain("this copy of ohmail organizes");
  });

  it("a holder with no NAME says so without inventing one", () => {
    const said = mailboxRowWhy({ name: null });
    expect(said).toContain("reads");
    expect(said, "a placeholder reached the pane").not.toContain("{name}");
    expect(said, "a null name was rendered as a machine called null").not.toContain("null");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE OS-ANSWER HOST THIS WINDOW BRINGS
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("desktopNotificationHost — the window cannot read the OS answer, so it says so", () => {
  it("answers granted for BOTH reads, which is what lets the master press be written", async () => {
    /* `permission()` answers the narrower question this surface can answer — may this window ask
       the shell — and `pressMaster` refuses to write anything for any other value. On the
       released build the browser reader answered otherwise and three presses stored nothing. */
    expect(desktopNotificationHost.permission()).toBe("granted");
    await expect(desktopNotificationHost.request()).resolves.toBe("granted");
  });

  it("declares that the OS holds the permission, which is what earns the pane its sentence", () => {
    expect(desktopNotificationHost.osHoldsPermission).toBe(true);
  });

  it("brings NO subscription layer — there is no server to register with", () => {
    // Omitted rather than stubbed: the interface names this build as the reason the method is
    // optional, and a do-nothing stub is a promise the type makes and the surface does not keep.
    expect(desktopNotificationHost.syncSubscription).toBeUndefined();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  SETTINGS → SCREENER, ON AN INSTALL THAT SCREENS NOTHING
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

const READER: MailboxFacts = {
  id: "mbx-1",
  address: "someone@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-09-02T09:00:00.000Z",
  initialImportCompletedAt: "2026-09-02T09:00:00.000Z",
  createdAt: "2026-09-01T09:00:00.000Z",
  organizerRole: "reader",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-09-02T08:00:00.000Z" },
  organizerState: "held",
  organizeConsentedAt: null,
};
const ORGANIZER: MailboxFacts = {
  ...READER,
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-09-01T09:00:00.000Z",
};

/** Encode an answer exactly as the shell's `engine_request` does — length, metadata, bytes. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const PREFERENCE = JSON.stringify({
  ohboxPolicy: "people_only",
  ohboxBar: "Only people who write to me by hand.",
  defaultBar: "Keep my Ohbox for real people writing to me.",
  screenerAutoApply: false,
});

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const shellHost = globalThis as unknown as Host;

let hostEl: HTMLDivElement;
let root: Root | null = null;

/**
 * Mount the real pane over the real provider, so the predicate reads the facts the way it does in
 * the app — `useMailboxFacts` off `MailStateProvider`, not a mocked hook.
 */
async function mountScreener(
  facts: MailboxFacts[],
  locale: "en" | "de" = "en",
): Promise<HTMLDivElement> {
  FACTS = facts;
  /* Imported inside, so the module graph is built after `vi.mock` is registered — the same
     reason `desktop-mailboxes.test.ts` imports its pane inside its render helper. */
  const { DesktopScreening } = await import("../src/DesktopScreening.js");
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(
      NextIntlClientProvider,
      { locale, messages: (locale === "de" ? de : en) as never, timeZone: "UTC" },
      h(DesktopScreening, { door: "local" }),
    ));
  });
  /* One more turn: the pane reads its stored preference in an effect, so the first render is
     always the empty one and every assertion belongs after the answer has landed. */
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  return hostEl;
}

beforeEach(() => {
  shellHost.__TAURI_INTERNALS__ = {
    invoke: async (command) => (command === "engine_request" ? encode(200, PREFERENCE) : null),
  };
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  hostEl?.remove();
  delete shellHost.__TAURI_INTERNALS__;
});

describe("Settings → Screener on a reader install", () => {
  it("SAYS SO, above controls that are inert here — and keeps the controls", async () => {
    const el = await mountScreener([READER]);
    const text = el.textContent ?? "";
    expect(text, "the pane offered the posture with nothing said about it")
      .toContain(en.desktopScreener.readerNote.replace("{name}", "ohmail Cloud"));
    /* AND THE CONTROLS ARE STILL THERE. Removing them would make setting up ahead of a takeover
       impossible and would throw away the only record of what this machine believes. */
    expect(text).toContain(en.desktopScreener.postureLabel);
    expect(el.querySelectorAll('[role="switch"]').length).toBeGreaterThan(0);
  });

  it("CONTROL: an install that organizes it gets NEITHER note", async () => {
    /* BOTH keys, and the pair is the point — measured by a mutation. Asserting only the named
       sentence left `alwaysnote` GREEN: with the gate removed, `readOnly` is null, the named arm
       is skipped and `readerNoteUnknown` renders instead — a different string saying the same
       false thing to an install that organizes the mailbox. A control case for a two-armed
       render has to name both arms. */
    const el = await mountScreener([ORGANIZER]);
    const text = el.textContent ?? "";
    expect(text).toContain(en.desktopScreener.postureLabel);
    expect(text, "the named reader note was drawn over an install that organizes the mailbox")
      .not.toContain(en.desktopScreener.readerNote.replace("{name}", "ohmail Cloud"));
    expect(text, "the unnamed reader note was drawn over an install that organizes the mailbox")
      .not.toContain(en.desktopScreener.readerNoteUnknown);
    /* AND NOT THE CLAUSE THEY SHARE, so a third wording of the same sentence cannot slip past
       two exact-string checks. */
    expect(text).not.toContain("so these controls do nothing here yet");
  });

  it("THE PANE IS GERMAN IN GERMAN — the half that shipped in English", async () => {
    /* MEASURED on 0.13.7 with Language = Deutsch: "How your mail is filed", "Keep my Ohbox for
       what matters", "Suggest for new senders automatically" and "What reaches your Ohbox" all
       stayed English, because every one was a literal in the source rather than a key. */
    const el = await mountScreener([ORGANIZER], "de");
    const text = el.textContent ?? "";
    expect(text).toContain(de.desktopScreener.filedHead);
    expect(text).toContain(de.desktopScreener.postureLabel);
    expect(text, "the pane still ships its own copy in English")
      .not.toContain(en.desktopScreener.filedHead);
    expect(text).not.toContain(en.desktopScreener.postureLabel);
  });
});
