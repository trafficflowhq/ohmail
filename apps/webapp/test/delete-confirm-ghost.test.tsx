/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ THE FOLDERS FLAG IS NOT A GATE ON THE DELETE CONFIRM ══════════════════════════════════
 *
 * ── WHAT THIS FILE WAS, AND WHY ITS CASES ARE NOW INVERSIONS ────────────────────────────────
 *
 * It was written for a real regression, in a world where the confirm strip was drawn only while
 * "Use folders" was on AND the local mirror held the row. Turning the flag off under an open
 * strip made the bar fall through to its resting row correctly — and left the STATE behind. The
 * shell's Escape list closes the innermost open thing and the bar's open panel sits above the
 * reply editor and the reader, so the next Escape was spent closing a layer nobody could see:
 * the reader stayed open, and a reader pressing Escape to leave a message got nothing the first
 * time, which is indistinguishable from a key that did not register. The withdrawal effect in
 * `MessagePane` is the fix and it is still there.
 *
 * The FLAG is no longer one of the strip's gates. Delete files the message to the mail server's
 * own \Trash — a system folder every account already has, discovered at connect beside \Junk —
 * never to a folder somebody made, so the USER-folders foundation was never a fact about whether
 * this verb may be offered; the engine's `message_delete` never read it, and the same verb over a
 * SELECTION never read it either, which left one account able to delete a picked pile and not the
 * row under its cursor. So the two flag cases below drive the SAME sequence and assert the
 * OPPOSITE outcome, and each says so in its name. They are kept rather than deleted because they
 * are what catches the term being re-added at the strip.
 *
 * ── WHERE THE INVARIANT IS WATCHED NOW ──────────────────────────────────────────────────────
 *
 * "A confirm whose gate closes under it is withdrawn, not remembered" is intact, over the one
 * operand that remains: the mirror. It is watched at the BAR — `action-bar.test.ts`, "a STALE
 * open confirm cannot dispatch after the MIRROR drops the row", which flips `chrome.mirrorHolds`
 * in place and then flips it BACK to prove the state was withdrawn and not merely undrawn.
 *
 * It is not watched here, for the reason this header always gave from the other side: taking a
 * row out of a real mirror also moves the cursor, and the shell clears the bar's panel whenever
 * the cursor moves (`useEffect(…, [focusedId])`), so a shell-level mirror version of the
 * regression would go green with the effect under test deleted. A flag flip changed exactly one
 * fact and left the focused message where it was — which is precisely what made it the right
 * lever, and precisely why it can no longer be one. The Escape ORDERING that the regression was
 * about is still asserted here, by the surviving positive control.
 *
 * The flip is the real one: a `settings` row arriving on the sync channel is the doorbell for a
 * consent write made on another surface, and `useConsentState` re-asks `GET /consent` when its
 * stamp moves. So the transport answers folders-off and the row is written — which is what a
 * person toggling the setting in a second window produces here.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Re-add `chrome.foldersEnabled === true &&` to `deleteConfirmAdmitted` and the two inverted
 * cases go red: the first with the strip gone after the flip, the second with it gone as well.
 * THE CONTROL is untouched by that mutation and is meant to be — it is the positive control for
 * the layer itself: while the strip is drawn, Escape closes the strip and NOT the reader, so the
 * inverted first case cannot be satisfied by an Escape that has stopped reaching the bar at all.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** Every verb this shell put on the wire — nothing in this file may reach it. */
let sent: EngineMutation[] = [];
/** The mirror behind the mounted shell, and the engine that publishes over it. */
let store: MirrorStore | null = null;
let engine: OhmailEngine | null = null;
/**
 * Changes the next `/sync` answers with — the channel, as a cell.
 *
 * The doorbell has to arrive THROUGH a drain and not by a write into the store: the mirror's own
 * version bump notifies nobody (the listener set lives on the engine), so a row applied to the
 * store directly is invisible to React and the settings stamp never moves. Measured here: the
 * first version of this file did exactly that and the strip stayed up for the full timeout.
 */
let pending: SyncChange[] = [];
/** What the consent transport currently answers for the folders foundation. */
let foldersOn = true;
/**
 * How many live consent reads have ANSWERED — the settle signal for a flag flip.
 *
 * The re-ask is a promise, so an assertion made straight after the doorbell would read the tree
 * before the answer reached it and pass for the wrong reason. Counting resolutions (and not
 * calls) makes the wait a fact about the read rather than about this machine's speed.
 */
let consentReads = 0;

beforeEach(() => {
  window.location.hash = "";
  /* The 390px arm: under 700px the reading column is `display:none` and the reader IS a sheet,
     which is the layer the Escape assertions are about. */
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: /max-width/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  // jsdom gaps, stubbed at their narrowest — see `delete-key-shell.test.tsx`.
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  sent = [];
  seq = 0;
  store = null;
  engine = null;
  pending = [];
  foldersOn = true;
  consentReads = 0;
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ── the account this shell is mounted over (the shape `delete-key-shell.test.tsx` uses) ───── */

const address = (id: string): string => `p${id}@example.invalid`;

const msg = (id: string): EngineMessage => ({
  id, accountId: "a1", mailboxId: "mb1", threadId: `t-${id}`, folder: "INBOX",
  subject: `Subject ${id}`, from: { address: address(id), name: `Person ${id}` },
  to: [], date: "2026-09-03T09:00:00.000Z", unread: false,
  updatedAt: "2026-09-03T09:00:00.000Z",
} as unknown as EngineMessage);

/** A mirror holding `ids`, each from a CONSENTED sender — without the rule the pile is empty. */
async function storeWith(ids: string[]): Promise<MirrorStore> {
  const s = new MemoryMirrorStore();
  await s.load();
  for (const id of ids) {
    const m = msg(id);
    await s.applyChanges([
      { type: "message", op: "create", id, seq: ++seq, updatedAt: m.updatedAt, entity: m },
      {
        type: "rule", op: "create", id: `r-${id}`, seq: ++seq, updatedAt: m.updatedAt,
        entity: {
          id: `r-${id}`, kind: "sender", match: address(id),
          destination: "INBOX", enabled: true, createdAt: "2026-09-01T00:00:00.000Z",
        },
      },
    ] as SyncChange[]);
  }
  return s;
}

function engineOver(s: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store: s,
    now: () => NOW,
    adapter: {
      sync: async () => {
        const creates = pending;
        pending = [];
        return {
          changes: { creates, updates: [], moves: [], deletes: [] },
          cursor: s.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        };
      },
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        const changes = mutationEffects(s, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type,
            op: e.entity === null ? "delete" : e.move ? "move" : "update",
            id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          })) as SyncChange[];
        await s.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

/**
 * A consent wire whose folders answer is READ AT CALL TIME from `foldersOn`.
 *
 * The mutable cell is what lets a case flip the flag under an open strip: a transport that
 * closed over its answer at mount could only ever describe the state the shell started in.
 */
const consentTransport = {
  foldersStorable: true,
  state: async () => {
    const answer = {
      seedConfirmedAt: "2026-09-01T00:00:00.000Z",
      screeningResetAt: null,
      dormancyDays: 90,
      foldersEnabledAt: foldersOn ? "2026-09-01T00:00:00.000Z" : null,
    };
    consentReads += 1;
    return answer;
  },
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: foldersOn ? "2026-09-01T00:00:00.000Z" : null }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};

const ORGANIZER_ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-04T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

const rowIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")].map((r) => r.dataset.id ?? "");

async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  store = await storeWith(["m1", "m2", "m3"]);
  engine = engineOver(store);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        children: h(ToastHost, {
          children: h(AppShell as never, {
            demo: false,
            engine,
            consentTransport,
            mailboxFacts: async () => ORGANIZER_ROSTER,
          } as never),
        }),
      }),
    }));
  });
  await waitFor(() => rowIds(container).length > 0, "rows in the Ohbox");
  return container;
}

/** A keypress on the DOCUMENT, where the registry listens. */
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

/** A press, as a pointing device makes one — down, up, then click (the More menu needs all three). */
async function pointer(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const reader = (el: HTMLElement): Element | null => el.querySelector(".reader");
const confirm = (el: HTMLElement): Element | null => el.querySelector(".reader .abar-panel.abar-delete");

/** Open the reader on the row under the cursor, then open the delete confirm from More. */
async function readerWithConfirm(): Promise<HTMLElement> {
  const container = await shell();
  await key("j");
  await key("Enter");
  expect(reader(container), "no reader opened at 390px").not.toBeNull();
  const more = container.querySelector<HTMLElement>(".reader .abar-more");
  expect(more, "the reader's bar has no More disclosure").not.toBeNull();
  await pointer(more!);
  const item = document.querySelector<HTMLElement>('[role="menu"] [data-item="delete"]');
  expect(item, "More offers no Delete with the folders foundation on").not.toBeNull();
  await pointer(item!);
  expect(confirm(container), "the confirm strip did not open").not.toBeNull();
  return container;
}

/**
 * Turn the folders foundation off the way another window does: the transport starts answering
 * `null`, and a `settings` row lands on the sync channel so the stamp moves and the live read
 * is re-asked.
 */
async function settingsDoorbell(at: string): Promise<void> {
  pending = [{
    type: "settings", op: "create", id: "s1", seq: ++seq, updatedAt: at,
    entity: { id: "s1", updatedAt: at },
  }] as SyncChange[];
  await act(async () => { await engine!.syncOnce(); });
}

async function foldersOffElsewhere(container: HTMLElement): Promise<void> {
  foldersOn = false;
  const before = consentReads;
  await settingsDoorbell("2026-09-04T09:05:00.000Z");
  await waitFor(() => consentReads > before, "the live consent read after the doorbell");
  await act(async () => {});
}

describe("the delete confirm and the folders flag going off under it", () => {
  /**
   * ── BOTH FLAG CASES BELOW ARE INVERSIONS, AND THE SEQUENCE THEY DRIVE IS UNCHANGED ────────
   *
   * The flag flip is no longer a gate on this verb, so the outcome it produces is the opposite
   * of what this file was written to assert, and the two cases now say so in as many words. They
   * are kept, not deleted, because they are the assertions that catch the term being re-added at
   * the strip: with `chrome.foldersEnabled === true &&` back in `deleteConfirmAdmitted`, the
   * first case's strip vanishes and both go red here.
   *
   * The INVARIANT the file was built for — a confirm whose gate closes under it is withdrawn,
   * not remembered, and the reader does not spend an Escape on an invisible layer — is intact
   * and is now watched over the surviving operand, the mirror. It is watched at the BAR
   * (`action-bar.test.ts`, "a STALE open confirm cannot dispatch after the MIRROR drops the
   * row") and not here, for the reason this file's own header gives: taking a row out of a real
   * mirror also moves the cursor, and the shell clears the bar's panel on a cursor move, so a
   * shell-level mirror version of the regression would go green with the effect under test
   * deleted. A flag flip changed exactly one fact, which is what made it the right lever — and
   * is exactly why it can no longer be one.
   */
  it("INVERTED (was: the strip is withdrawn) — the strip STANDS and Escape closes IT", async () => {
    const container = await readerWithConfirm();
    await foldersOffElsewhere(container);
    expect(
      confirm(container),
      "the folders flag closed the delete confirm — it is not a gate on this verb",
    ).not.toBeNull();

    /* And Escape is therefore spent on the strip, exactly as THE CONTROL below asserts for a
       strip nobody touched: the reader stays open, which is the one press the regression cost. */
    await key("Escape");
    expect(confirm(container), "Escape did not close the confirm strip").toBeNull();
    expect(
      reader(container),
      "Escape closed the reader out from under a confirm that was still drawn",
    ).not.toBeNull();
    /* Nothing was deleted along the way. The strip is the only dispatch site and it never ran.
       `kind` and NOT `type`: `EngineMutation` is a discriminated union keyed by `kind`, so a
       filter on `type` compares `undefined` for every member and reports an empty list whatever
       was dispatched — an assertion that cannot fail. Three lines in this file were written that
       way before a sibling case caught it. */
    expect(sent.filter((m) => m.kind === "message_delete")).toEqual([]);
  });

  it("INVERTED (was: nothing to re-ask) — the verb never left, and the strip never doubled", async () => {
    const container = await readerWithConfirm();
    await foldersOffElsewhere(container);

    // The setting goes back on, same window, same message under the cursor.
    const before = consentReads;
    foldersOn = true;
    await settingsDoorbell("2026-09-04T09:07:00.000Z");
    await waitFor(() => consentReads > before, "the live consent read after the doorbell");
    await act(async () => {});

    /* The strip that was standing is still standing — ONE of it, the same question, not a second
       copy re-opened by the gate reopening. */
    expect(confirm(container), "the confirm is gone after the flag came back").not.toBeNull();
    expect(
      container.querySelectorAll(".reader .abar-panel.abar-delete"),
      "the flag coming back re-asked a question that was already on screen",
    ).toHaveLength(1);
    expect(sent.filter((m) => m.kind === "message_delete")).toEqual([]);

    /* …and the verb is reachable throughout, so neither assertion is about a verb that has gone
       away: the strip's Cancel puts the resting bar back and its disclosure offers Delete. */
    const cancel = [...container.querySelectorAll<HTMLButtonElement>(".reader .abar-delete button")]
      .find((b) => (b.textContent ?? "").trim() === "Cancel");
    expect(cancel, "the confirm has no Cancel").not.toBeUndefined();
    await act(async () => { cancel!.click(); });
    const more = container.querySelector<HTMLElement>(".reader .abar-more");
    expect(more, "the resting bar is gone — something is standing in its place").not.toBeNull();
    await pointer(more!);
    expect(
      document.querySelector('[role="menu"] [data-item="delete"]'),
      "Delete is not in More, so nothing above was about the confirmation",
    ).not.toBeNull();
  });

  it("THE CONTROL: while the strip IS drawn, Escape closes the strip and leaves the reader", async () => {
    /* Without this the first case would also pass for a build where Escape had stopped reaching
       the action bar at all — an Escape that closes the reader because the panel is no longer a
       layer for any reason, rather than because this one was withdrawn. */
    const container = await readerWithConfirm();
    await key("Escape");
    expect(confirm(container), "Escape did not close the confirm strip").toBeNull();
    expect(reader(container), "Escape closed the reader out from under the confirm").not.toBeNull();
    expect(sent.filter((m) => m.kind === "message_delete")).toEqual([]);
  });
});
