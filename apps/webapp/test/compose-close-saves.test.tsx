/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  mutationEffects,
  type EngineMutation,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import { AUTOSAVE_DELAY_MS } from "../app/shell/compose-autosave";

/**
 * ═══ CLOSING THE COMPOSER SAVES WHAT IS IN IT ════════════════════════════════════════════
 *
 * Measured on the deployed managed web at 0.19.6: type into Compose, press Escape inside the
 * two-second debounce, and the message is gone from the account — while the composer's own foot
 * says "Saved to your drafts after a moment". Escape ran `go("ohbox")`, the route change turned
 * the autosave hook inactive, and its effect cleanup cleared the armed timer. A five-second wait
 * before the same Escape saved. One sentence, two outcomes, and nothing on screen to tell them
 * apart.
 *
 * The rule: closing the composer FLUSHES first. Escape and the close control await the write and
 * refuse to leave when it is refused; every other way out — the rail, a `g` jump, the browser's
 * Back, the shell unmounting — takes the hook's belt, which runs the same write.
 *
 * Driven through the shipped shell over a real engine: the claim spans a key binding, a callback
 * in a file thousands of lines long, one hook and one sentence, and each of those compiles alone.
 * The transport is the one thing stubbed, `cursorless-first-press.test.tsx`'s precedent.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-09T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** Every verb this shell put on the wire, in order. */
let sent: EngineMutation[] = [];
/** When true the adapter REFUSES a draft save, unretryably — the server's own "no". */
let refuseDraftSave = false;

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-09T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const,
  organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

const consentTransport = {
  foldersStorable: true,
  state: async () => ({
    seedConfirmedAt: "2026-09-01T00:00:00.000Z",
    screeningResetAt: null,
    dormancyDays: 90,
    foldersEnabledAt: "2026-09-01T00:00:00.000Z",
  }),
  setAutoSuggest: async () => ({ autoSuggestAt: null }),
  setDormancyDays: async () => ({}),
  setBlockRemoteImages: async () => ({ blockRemoteImagesAt: null }),
  setBlockTrackingPixels: async () => ({ loadTrackingPixelsAt: null }),
  setBlockAutoUnsubscribe: async () => ({ blockAutoUnsubscribeAt: null }),
  setFoldersEnabled: async () => ({ foldersEnabledAt: "2026-09-01T00:00:00.000Z" }),
  setMailboxFoldersEnabled: async () => ({ folderMailboxesOff: {} }),
  setMailboxSignature: async () => ({ signatures: {} }),
};

function engineOver(store: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m: EngineMutation) => {
        if (refuseDraftSave && m.kind === "draft_save") {
          /* UNRETRYABLE on purpose: a retryable refusal is what the outbox is FOR — the verb is
             durable and on its way, and closing over it loses nothing. Only a refusal nothing
             will try again is the loss this door exists to refuse. */
          throw new MutationRejectedError("the server would not store this draft", {
            status: 422, code: "invalid", retryable: false,
          });
        }
        sent.push(m);
        const changes = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` })
          .map((e) => ({
            type: e.type,
            op: e.entity === null ? "delete" : e.move ? "move" : "update",
            id: e.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: e.entity,
            ...(e.move ? { move: e.move } : {}),
          })) as SyncChange[];
        await store.applyChanges(changes);
        const created = m.kind === "draft_save" && m.draftId === null
          ? changes.find((c) => c.type === "draft")?.id ?? null
          : null;
        return {
          changes,
          seq: changes[changes.length - 1]?.seq ?? null,
          ...(created ? { entityId: created } : {}),
        };
      },
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  } as never);
}

let container: HTMLElement;

async function mountCompose(extra: Record<string, unknown> = {}): Promise<void> {
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const store = new MemoryMirrorStore();
  await store.load();
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        storageKey: null,
        children: h(ToastHost, {
          children: h(AppShell as never, {
            demo: false,
            engine: engineOver(store),
            consentTransport,
            mailboxFacts: async () => ROSTER,
            ...extra,
          } as never),
        }),
      }),
    }));
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  await goHash("#/compose");
  await waitFor(() => container.querySelector(".view-compose") !== null, "the compose view");
}

async function goHash(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}

const q = <T extends Element>(sel: string): T | null => container.querySelector<T>(sel);

/** Type the way React sees it — the native setter, then an input event. */
async function typeInto(sel: string, value: string): Promise<void> {
  const input = q<HTMLInputElement>(sel)!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const escape = async (): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
};

async function waitFor(p: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (p()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

/** A beat for something that was NOT supposed to happen, so its absence means something. */
const settle = async (): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
};

const drafts = (): EngineMutation[] => sent.filter((m) => m.kind === "draft_save");
const subjectsSaved = (): string[] =>
  drafts().map((m) => (m as unknown as { subject: string }).subject);

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* blocked storage; the in-memory half still runs */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  sent = [];
  seq = 0;
  refuseDraftSave = false;
});

afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("the two-arm probe the review ran on the deployed build", () => {
  /**
   * ══ THE CENTRAL GUARD ══════════════════════════════════════════════════════════════════
   *
   * ARM ONE — type, Escape at once. Inside the debounce there is an ARMED save and nothing on
   * the account; leaving used to cancel it with the timer.
   *
   * It measures the DOOR's guarantee — the write is done before the close completes — so it
   * reddens for the removal of either owner: with the door alone gone (Escape back to
   * `go("ohbox")`) the belt's write is still on its way when the assertion reads, and with both
   * gone nothing is ever written. Both measured; the shipped 0.19.6 shape is both.
   *
   * Mutation: give `ComposeView`'s Escape `go("ohbox")` back in place of `onClose()`, with or
   * without the hook's belt effect. Real failure text:
   *   AssertionError: Escape inside the autosave window threw the message away — the composer
   *   said it was saved: expected [] to deeply equal [ 'Friday' ]
   */
  it("saves the message when Escape comes before the pause is over", async () => {
    await mountCompose();
    await typeInto("#compose-to", "sam@example.invalid");
    await typeInto("#compose-subject", "Friday");
    expect(drafts(), "the debounce did not hold — this arm measures nothing").toHaveLength(0);

    await escape();

    expect(
      subjectsSaved(),
      "Escape inside the autosave window threw the message away — the composer said it was saved",
    ).toEqual(["Friday"]);
    expect(window.location.hash, "the composer did not close after a save that succeeded")
      .toBe("#/ohbox");
  });

  /**
   * ARM TWO — the same press after the pause. It saved before this lane and must save exactly
   * once now: a flush that ignored the dedupe would write the row a second time.
   */
  it("saves once, not twice, when Escape comes after the pause", async () => {
    await mountCompose();
    await typeInto("#compose-to", "sam@example.invalid");
    await typeInto("#compose-subject", "Friday");
    await waitFor(() => drafts().length === 1, "the pause's own save", AUTOSAVE_DELAY_MS + 2000);

    await escape();
    await settle();

    expect(drafts(), "closing wrote the draft a second time").toHaveLength(1);
    expect(window.location.hash).toBe("#/ohbox");
  });

  /**
   * AN EMPTY COMPOSER IS NOT A DRAFT — `worthSaving`'s rule, unchanged by the flush. A close
   * that wrote a row for an untouched form would fill the Drafts list with "(no subject)".
   */
  it("writes nothing when Escape leaves an empty composer", async () => {
    await mountCompose();

    await escape();
    await settle();

    expect(drafts(), "leaving an untouched composer wrote a draft to the account").toHaveLength(0);
    expect(window.location.hash).toBe("#/ohbox");
  });
});

describe("words typed in To alone are typed words", () => {
  /** The To entries on screen: settled chips plus the input's tail (leaving the field makes a chip). */
  const toEntries = (): string => {
    const field = q<HTMLInputElement>("#compose-to")!;
    const chips = [...field.closest(".rcp")!.querySelectorAll(".rcp-chip-addr")].map((n) => n.textContent ?? "");
    return [...chips, field.value].filter(Boolean).join(", ");
  };
  const toSaved = (): string[][] => drafts()
    .map((m) => (m as unknown as { to: { address: string }[] }).to.map((a) => a.address));

  it("Escape keeps a draft for an address typed in To and nothing else", async () => {
    await mountCompose();
    await typeInto("#compose-to", "sam@example.invalid");
    await escape();
    expect(toSaved(), "Escape threw away the address typed in To").toEqual([["sam@example.invalid"]]);
    expect(window.location.hash).toBe("#/ohbox");
  });

  it("the pause keeps it too", async () => {
    await mountCompose();
    await typeInto("#compose-to", "sam@example.invalid");
    await waitFor(() => drafts().length === 1, "the pause's own save", AUTOSAVE_DELAY_MS + 2000);
    expect(toSaved()).toEqual([["sam@example.invalid"]]);
  });

  it("opening the draft from Drafts keeps a half-typed recipient on screen", async () => {
    await mountCompose();
    await typeInto("#compose-subject", "Friday");
    await typeInto("#compose-to", "sam@exa");
    await escape();
    expect(subjectsSaved()).toEqual(["Friday"]);
    await goHash("#/drafts");
    await waitFor(() => q(".draft-row .draft-open") !== null, "the draft in Drafts");
    await act(async () => { q<HTMLElement>(".draft-row .draft-open")!.click(); });
    await settle();
    await waitFor(() => q("#compose-to") !== null, "the composer");
    expect(toEntries(), "reopening the draft deleted the half-typed recipient").toBe("sam@exa");
  });

  it("CONTROL: a mail link's recipient alone is not a draft", async () => {
    await mountCompose({
      mailtoDraft: { to: ["sam@example.invalid"], cc: [], bcc: [], subject: "", body: "" },
      onMailtoDraftSeeded: () => {},
    });
    await waitFor(() => q("#compose-to") !== null && toEntries() === "sam@example.invalid", "the link's recipient");
    await escape();
    await settle();
    expect(drafts(), "a link's prefilled recipient became a Drafts row").toHaveLength(0);
  });
});

describe("a refused write keeps the composer", () => {
  /**
   * NEVER A SILENT LOSS. The account will not take the draft and nothing here will try again, so
   * leaving would be the loss the flush exists to prevent. The composer stays and says why —
   * staying without a sentence reads as a key that never registered.
   *
   * Mutation: in `closeCompose`, drop the `if (flushed.kind === "failed")` arm (always `go`).
   * Real failure text:
   *   AssertionError: the composer closed over a draft the server refused: expected '#/ohbox'
   *   to be '#/compose'
   */
  it("stays open with a sentence when the save is refused", async () => {
    await mountCompose();
    await typeInto("#compose-to", "sam@example.invalid");
    await typeInto("#compose-subject", "Friday");
    refuseDraftSave = true;

    await escape();
    await settle();

    expect(window.location.hash, "the composer closed over a draft the server refused")
      .toBe("#/compose");
    expect(q(".view-compose"), "the compose view is gone although the save was refused")
      .not.toBeNull();
    const notes = [...container.querySelectorAll(".send-note")].map((n) => n.textContent ?? "");
    expect(
      notes.some((n) => n.includes("couldn't be saved")),
      `the refusal was swallowed — the notes on screen were ${JSON.stringify(notes)}`,
    ).toBe(true);
    /* AND THE SENTENCE NAMES WHY, from the server's own words rather than a house phrase that
       would be the same for every refusal. */
    expect(notes.some((n) => n.includes("would not store this draft"))).toBe(true);
  });

  /**
   * AND THE SENTENCE GOES WHEN IT STOPS BEING TRUE — it was about the text as it stood, and an
   * edit makes it a stale claim sitting under a message somebody is still writing.
   */
  it("drops the sentence on the next edit", async () => {
    await mountCompose();
    await typeInto("#compose-to", "sam@example.invalid");
    await typeInto("#compose-subject", "Friday");
    refuseDraftSave = true;
    await escape();
    await settle();
    expect([...container.querySelectorAll(".send-note")]
      .some((n) => (n.textContent ?? "").includes("couldn't be saved"))).toBe(true);

    await typeInto("#compose-subject", "Friday lunch");

    expect(
      [...container.querySelectorAll(".send-note")]
        .some((n) => (n.textContent ?? "").includes("couldn't be saved")),
      "the refusal stood over text it was never about",
    ).toBe(false);
  });
});

describe("the belt under every exit no door owns", () => {
  /**
   * THE RAIL, A `g` JUMP, THE BROWSER'S BACK. Routing is hash-driven, so none of them passes
   * through a function the composer owns — the hook's own deactivate effect runs the write.
   *
   * Mutation: delete the belt effect in `useComposeAutosave` (the one returning
   * `() => { void writeNow(); }`). Real failure text:
   *   AssertionError: navigating out of the composer threw the message away: expected [] to
   *   deeply equal [ 'Friday' ]
   */
  it("saves when the route leaves the composer without a press", async () => {
    await mountCompose();
    await typeInto("#compose-to", "sam@example.invalid");
    await typeInto("#compose-subject", "Friday");
    expect(drafts(), "the debounce did not hold — this arm measures nothing").toHaveLength(0);

    await goHash("#/ohbox");
    await settle();

    expect(subjectsSaved(), "navigating out of the composer threw the message away")
      .toEqual(["Friday"]);
  });

  /**
   * AND IT MAY NOT RESURRECT A DISCARD — the positive control that the flush left this path
   * alone. Cancel releases the row and empties the form in one commit, so React's batching alone
   * keeps the belt from writing here and dropping `abandonedAt` does NOT redden this arm: the
   * guard that holds when those two land in separate renders is watched failing at the hook
   * instead (`compose-autosave.test.tsx`, "writes nothing for a form that was released"). Both
   * measured, 2026-09-19. This arm is what a person does, and it must stay true either way.
   */
  it("writes nothing when the exit was a discard", async () => {
    await mountCompose();
    await typeInto("#compose-to", "sam@example.invalid");
    await typeInto("#compose-subject", "Friday");

    await act(async () => { q<HTMLButtonElement>(".compose-foot .compose-cancel")!.click(); });
    const confirm = [...container.querySelectorAll<HTMLButtonElement>(".compose-confirm button")]
      .find((b) => b.textContent === "Discard message")!;
    expect(confirm, "the discard question never opened — this arm measures nothing").toBeTruthy();
    await act(async () => { confirm.click(); });
    await settle();

    expect(subjectsSaved(), "discarding the message wrote it to the account on the way out")
      .toEqual([]);
  });
});

describe("the sentence exists in both languages", () => {
  /**
   * A KEY THE SURFACE RENDERS AND A CATALOGUE DOES NOT CARRY IS A CRASH ON FIRST RENDER, and
   * this branch only shows up once somebody's account has refused a draft. Both keys, both
   * catalogues, and the placeholder the reason rides in.
   */
  it("carries both close sentences, with the reason placeholder", async () => {
    /* Through `unknown` on one line: the catalogues' inferred literal types nest objects, so the
       direct assertion is a TS2352 the webapp's own typecheck refuses — and a line break before
       the second `as` is a TSX parse error, not a style choice. */
    type Catalogue = Record<string, Record<string, string>>;
    const en = (await import("../messages/en.json")).default as unknown as Catalogue;
    const de = (await import("../messages/de.json")).default as unknown as Catalogue;
    for (const key of ["closeNotSaved", "closeNotSavedReason"]) {
      expect(en.compose?.[key], `en.compose.${key}`).toBeTruthy();
      expect(de.compose?.[key], `de.compose.${key}`).toBeTruthy();
      expect(de.compose![key], `de.compose.${key} is the English sentence`)
        .not.toBe(en.compose![key]);
    }
    for (const cat of [en, de]) {
      expect(cat.compose!.closeNotSavedReason, "the reason has nowhere to go").toContain("{reason}");
      expect(cat.compose!.closeNotSaved, "the bare sentence takes a reason it is never given")
        .not.toContain("{reason}");
    }
  });
});
