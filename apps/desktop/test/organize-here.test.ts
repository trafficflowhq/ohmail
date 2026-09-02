/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import type { MailboxFacts } from "../../webapp/app/shell/mail-state";

/**
 * ═══ "ORGANIZE HERE INSTEAD" — THE EXIT FROM READING SOMEBODY ELSE'S MAILBOX ══════════════
 *
 * `QAR-DESKTOP-CANNOT-RECLAIM-MAILBOX`. Measured on the released 0.13.2 AppImage against a real
 * mailbox whose `ohmail/_meta` carried a 25-minute-stale local claim: the install stood down
 * (`verdict=available`, `organized_elsewhere:local`, `heldBy=zorin-9950`) and had **no way back at
 * all**. Three exits were walked and all three are closed:
 *
 *  1. This pane rendered NO control on a `disabled` row.
 *  2. The remedy the pane's own comment named — reconnect the address — goes through the door
 *     chooser and is refused with *"This mailbox is disconnected. Reconnect it before setting new
 *     credentials."*, whose own invariant is that a disabled mailbox holds no credential. The
 *     instruction was circular.
 *  3. The authorized takeover existed on the Cloud webapp only; `en.json` carried no takeover
 *     string for this surface at all.
 *
 * The asymmetry was measured live in one mailbox inside ten minutes: at 15:05 the desktop could
 * not take the stale claim; by 15:14 `ohmail-cloud:production` had. Retire a machine, install on
 * another, and that mailbox could never be organized again without deleting a message from an IMAP
 * folder by hand.
 *
 * `verdict=available` is NOT the defect and is not changed: becoming an organizer always requires
 * an explicit human action, which is exactly why a crashed machine's mailbox is not seized. What
 * was missing is the action. This file is the assertion that it is on screen, that it is offered
 * for a STAND-DOWN and not for a removal, that it is the local door's alone, and that it says what
 * actually has to happen next.
 *
 * ── AND THE ROW IT WAS OFFERED ON WAS THE WRONG ONE, WHICH IS WHY THIS FILE MOVED ───────────
 *
 * The control was gated on `status === "disabled" && disabledReason` — a stand-down as the OLD
 * schema encoded it, and the shape these fixtures used to carry. The role is its own column now:
 * the migration's backfill moved every stood-down row to `status='connected',
 * organizer_role='reader'`, because **a reader is connected and syncing** — that is the whole
 * point of splitting the connection from the role. So the old guard named a state nothing writes
 * any more, AND `organizeHere` REFUSES a `disabled` row, which is a tombstone. The control was
 * offered on exactly the set the handler declines.
 *
 * It is the banner's action now, stated where the fact is. The fixtures below carry the shape the
 * server actually sends.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop `!cloud` from `claimable`                 → the hosted case goes red (a claim offered on
 *    a mirror this install does not own, whose route the hosted door does not even serve);
 *  · drop `m.status !== "disabled"`                 → the tombstone case goes red, which is the one
 *    that matters: offering a claim on a removal resurrects a mailbox somebody deliberately took
 *    off this machine, and the handler refuses it anyway;
 *  · make `claimable` test `organizerRole !== "reader"` → the organizer case goes red (a claim
 *    banner over a mailbox this machine already organizes);
 *  · post to `/mailboxes/:id/organize` instead      → the route case goes red (that is the
 *    ACCOUNT's ceremony; this door's authority is the machine's own login).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let FACTS: MailboxFacts[] | null = null;
let refreshed = 0;

vi.mock("../../webapp/app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: { key: "quiet", clock: false, settled: true },
    mailboxes: FACTS,
    mirrored: 0,
    freshness: { state: "current" },
    refresh: () => { refreshed += 1; },
  }),
}));

/** Every request the pane put down the pipe, in order — the route is half of what is under test. */
let bridged: { url: string; method: string; body?: string }[] = [];
let bridgeReply: () => Response = () =>
  new Response(JSON.stringify({ outcome: "authorized", previousReason: "organized_elsewhere:local" }),
    { status: 200, headers: { "content-type": "application/json" } });

vi.mock("../src/bridge-fetch.js", () => ({
  bridgeFetch: async (url: string, init?: { method?: string; body?: string }) => {
    bridged.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
    return bridgeReply();
  },
}));

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: unknown, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

/**
 * A mailbox ANOTHER INSTALL ORGANIZES, in the shape the server sends: `connected` — because a
 * reader reads, searches and marks seen exactly like any other mail client — with the role and the
 * holder in their own columns.
 */
const READER: MailboxFacts = {
  id: "mbx-reader",
  address: "owner@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-09-01T13:05:00.000Z",
  initialImportCompletedAt: "2026-08-01T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
  organizerRole: "reader",
  organizedBy: { kind: "local", name: "zorin-9950", since: "2026-08-28T09:00:00.000Z" },
  organizerState: "held",
};

/** This install organizes it. Nothing to claim, and a banner here would be a lie about the row. */
const ORGANIZER: MailboxFacts = {
  ...READER, id: "mbx-mine", organizerRole: "organizer", organizedBy: null, organizerState: null,
};

/** A TOMBSTONE — removed from this machine. The handler refuses it and so must the pane. */
const REMOVED: MailboxFacts = { ...READER, id: "mbx-removed", status: "disabled", organizerRole: "reader" };

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(door: string | null): Promise<HTMLElement> {
  const { DesktopMailboxes } = await import("../src/DesktopMailboxes.js");
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(
          ThemeProvider,
          { storageKey: "ohmail.theme" },
          h(ToastHost, null, h(DesktopMailboxes, { door })),
        ),
      ),
    );
  });
  return mountPoint;
}

function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label)) ?? null
  );
}

const organizeButton = (el: HTMLElement) => buttonSaying(el, "Organize here instead");
const confirmButton = (el: HTMLElement) => buttonSaying(el, "Organize here");

beforeEach(() => {
  FACTS = [READER];
  refreshed = 0;
  bridged = [];
  bridgeReply = () =>
    new Response(JSON.stringify({ outcome: "authorized", previousReason: "organized_elsewhere:local" }),
      { status: 200, headers: { "content-type": "application/json" } });
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async () => null,
  };
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("an install that only READS a mailbox can ask to organize it", () => {
  it("names the holder and how long, and offers the one verb", async () => {
    const el = await render(null);
    const text = el.textContent ?? "";
    expect(text).toContain("owner@example.test");
    // WHO, AND SINCE WHEN — the holder's own machine name, not "another install".
    expect(text).toContain("Organized by zorin-9950");
    // WHAT THIS MACHINE IS AND IS NOT DOING. The row looks healthy because it IS healthy; what is
    // missing is that nothing here moves or screens anything, and only this sentence says so.
    expect(text).toContain("This computer reads the mailbox; it moves nothing and screens nothing.");
    expect(text).toContain("Reading only");
    expect(organizeButton(el), "a reader row offers nothing to press").not.toBeNull();
  });

  it("says the other side stands down rather than dies, before the press that does it", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    const text = el.textContent ?? "";
    // The cost to the other install, stated BEFORE the confirm — it becomes a reader and keeps
    // its copy. A ceremony that only said "are you sure" would make somebody guess at that.
    expect(text).toContain("zorin-9950 stands down the next time it checks");
    expect(text).toContain("Its copy of your mail is left alone.");
    expect(bridged, "the first press wrote something instead of asking").toEqual([]);
  });

  it("confirming authorizes ONE becoming through the local door, and says when it happens", async () => {
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });

    // THE ROUTE. The local door's own action, keyed on the mailbox id — not the account's
    // `POST /mailboxes/:id/organize`, which is a different ceremony with a different authority
    // and is not served on this door at all.
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.url).toBe("/local/organizer/takeover");
    expect(bridged[0]!.method).toBe("POST");
    expect(JSON.parse(bridged[0]!.body!)).toEqual({ mailboxId: "mbx-reader" });

    // THE SENTENCE, AND IT NO LONGER SENDS ANYBODY TO RESTART THE APP. "Quit and reopen" was true
    // when the engine read the lease only at launch; the gate spends the stamp on its next tick
    // now, so the instruction was to do something neither needed nor helpful.
    const text = el.textContent ?? "";
    expect(text).toContain("This computer takes over on its next pass");
    expect(text, "the retired restart instruction is still on screen").not.toContain("Quit and reopen");

    // The row's own state moved, so the pane re-reads rather than keeping the banner on screen.
    expect(refreshed).toBe(1);
  });

  it("quotes the engine's OWN answer when nothing was written", async () => {
    // `already_organizing`, `removed` and `no_mailbox` are answers about the row rather than
    // refusals of the request — the route returns 200 for all four — and each says its own true
    // thing rather than a generic success.
    bridgeReply = () =>
      new Response(JSON.stringify({ outcome: "already_organizing", previousReason: null }),
        { status: 200, headers: { "content-type": "application/json" } });
    const el = await render(null);
    await act(async () => { organizeButton(el)!.click(); });
    await act(async () => { confirmButton(el)!.click(); });
    expect(el.textContent).toContain("This machine already organizes that mailbox");
    expect(el.textContent).not.toContain("This computer takes over on its next pass");
  });

  it("is NOT offered on a TOMBSTONE — the handler refuses that row and so does the pane", async () => {
    FACTS = [REMOVED];
    const el = await render(null);
    expect(el.textContent).toContain("Disconnected");
    expect(organizeButton(el),
      "offering a claim on a removal resurrects a mailbox somebody took off this machine, and " +
        "`organizeHere` declines it anyway")
      .toBeNull();
  });

  it("is NOT offered on a mailbox this machine already organizes", async () => {
    FACTS = [ORGANIZER];
    const el = await render(null);
    expect(el.textContent).not.toContain("Organized by");
    expect(organizeButton(el), "a claim banner was drawn over a mailbox this machine organizes")
      .toBeNull();
    expect(buttonSaying(el, "Sync now")).not.toBeNull();
  });

  it("is NOT offered on the HOSTED door — the claim there is the account's ceremony", async () => {
    const el = await render("cloud");
    expect(el.textContent).toContain("owner@example.test");
    expect(organizeButton(el),
      "the local takeover route is not served on the hosted door; a button for it would 404")
      .toBeNull();
  });

  /**
   * AN ENGINE THAT PREDATES THE COLUMN IS AN ORGANIZER, NOT A READER.
   *
   * The desktop updates on its own schedule, so a window newer than its engine is an ordinary
   * state rather than an error. The absent field has to read as `organizer`: the other default
   * would put a claim banner over every mailbox on every older install.
   */
  it("treats an absent role as this install organizing, never as reading", async () => {
    const { organizerRole: _role, organizedBy: _by, organizerState: _st, ...older } = READER;
    FACTS = [older as MailboxFacts];
    const el = await render(null);
    expect(el.textContent).not.toContain("Organized by");
    expect(organizeButton(el)).toBeNull();
  });

  it("a holder that stopped renewing gets its own sentence, not the calm one", async () => {
    FACTS = [{ ...READER, organizerState: "stopped" }];
    const el = await render(null);
    const text = el.textContent ?? "";
    expect(text).toContain("has not since");
    expect(text).toContain("new mail waits in the inbox");
    expect(text, "a stopped holder was described with the steady-state sentence")
      .not.toContain("it moves nothing and screens nothing");
    expect(organizeButton(el), "the one state that most needs the claim did not offer it").not.toBeNull();
  });
});

/**
 * THE WIRE → FACTS MAPPER, driven directly.
 *
 * The cases above inject `MailboxFacts` through the mocked provider, so they exercise the PANE and
 * never reach `readMailboxFactsVia` — which is where the "absent reads as organizer" default
 * lives. Inverting that default left every case above green, which is how this block came to
 * exist: the component's own test could not see the mapper at all.
 *
 * The default matters more than it looks. A desktop updates on its own schedule, so a window newer
 * than its engine is ordinary, and every install predating the column sends no role. Reading that
 * as `reader` would put a claim banner over every mailbox on every one of them.
 */
describe("the mailbox wire is mapped with the safe default for an engine that predates the role", () => {
  const answer = (row: Record<string, unknown>) =>
    async (url: string): Promise<Response> => {
      expect(url).toBe("/mailboxes");
      return new Response(JSON.stringify({ items: [row] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
  const base = { id: "m1", address: "a@example.test", status: "connected", lastSyncAt: null };

  it("an absent role is an ORGANIZER, never a reader", async () => {
    const { readMailboxFactsVia } = await import("../src/DesktopMailboxes.js");
    const [row] = await readMailboxFactsVia(answer(base) as never);
    expect(row!.organizerRole, "an engine that predates the column demoted this install").toBe("organizer");
    expect(row!.organizedBy).toBeNull();
    expect(row!.organizerState).toBeNull();
  });

  it("a role the wire does send is carried through, holder and all", async () => {
    const { readMailboxFactsVia } = await import("../src/DesktopMailboxes.js");
    const [row] = await readMailboxFactsVia(
      answer({
        ...base,
        organizerRole: "reader",
        organizedBy: { kind: "local", name: "zorin-9950", since: "2026-08-28T09:00:00.000Z" },
        organizerState: "held",
      }) as never,
    );
    expect(row!.organizerRole).toBe("reader");
    expect(row!.organizedBy).toEqual({ kind: "local", name: "zorin-9950", since: "2026-08-28T09:00:00.000Z" });
    expect(row!.organizerState).toBe("held");
  });

  it("a role the wire sends that this build does not know is an ORGANIZER too", async () => {
    // The same argument in the other direction: a value from a NEWER engine must not be guessed
    // into the demoting branch.
    const { readMailboxFactsVia } = await import("../src/DesktopMailboxes.js");
    const [row] = await readMailboxFactsVia(answer({ ...base, organizerRole: "custodian" }) as never);
    expect(row!.organizerRole).toBe("organizer");
  });
});
