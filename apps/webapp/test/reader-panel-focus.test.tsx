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
 * ═══ THE ACTION BAR'S CEREMONIES, AND WHERE THE KEYBOARD IS DURING ONE ═════════════════════
 *
 * Three verbs replace the bar with a strip that asks a question: Move asks WHERE, Resurface asks
 * WHEN, Delete asks whether you meant it. Two of the three landed the keyboard in the strip they
 * opened; Resurface had no focus line at all, so opening the horizon chooser left focus on a
 * button that had just unmounted and the chooser could only be reached by Tabbing in from the top
 * of the document.
 *
 * And all three did the opposite of opening when they closed. Cancelling put the strip away and
 * left focus nowhere: the person was returned to the document, several stops from the bar they
 * had been operating. Escape is worse than the Cancel button here, because Escape is what people
 * actually press and it does not go through the bar at all — the shell closes the innermost open
 * layer by clearing the panel itself.
 *
 * ── WHAT IS ASSERTED, AND BY NODE IDENTITY ──────────────────────────────────────────────────
 *
 * The strip REPLACES the row, so the button that was pressed is gone from the document while the
 * strip is up and comes back as a NEW node. Every assertion here therefore re-queries the trigger
 * after the close and compares `document.activeElement` to the node that is on screen NOW. An
 * assertion against the node captured before the press would compare against a detached element
 * and could only ever fail; one against `textContent` would pass with focus on the body, because
 * the document contains the word "Resurface" either way.
 *
 * ── AND THE ONE ASYMMETRY, ON PURPOSE ───────────────────────────────────────────────────────
 *
 * ANSWERING is not cancelling. Choosing a horizon or a destination spends the verb on a message
 * that then moves out from under the bar, so focus is not sent back to the control that asked;
 * that was the behaviour before this and the last case pins it, so the restore cannot quietly
 * become "whenever the panel closes".
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Remove the `panel === "resurface"` focus effect and exactly the first case goes red. Remove the
 * restore effect (the one that spends `panelTriggerRef` when the panel goes null) and exactly the
 * four cancel cases go red — Escape included, which is the one that matters most and the one a
 * restore hung off the Cancel button would have missed. Remove `MoreMenu`'s single-character key
 * arm and the last describe's one case goes red at "expected [ 'reply_later' ] to deeply equal
 * []": the shell really did file the message under an open menu.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T09:00:00.000Z");
let roots: Root[] = [];
let seq = 0;
/** Every verb this shell put on the wire — the answer cases read it, the cancel cases require none. */
let sent: EngineMutation[] = [];

beforeEach(() => {
  window.location.hash = "";
  /* The 390px arm, so the reader is a sheet and there is exactly ONE action bar in the document.
     At desktop width the reading column and the sheet can both be mounted, and "the trigger" would
     be an ambiguous phrase. */
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
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: s.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
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

/** A consent wire that says the folders foundation is on — the flag Delete is gated behind. */
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
  const engine = engineOver(await storeWith(["m1", "m2", "m3"]));
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

/** A press, as a pointing device makes one — down, up, then click. */
async function pointer(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/* ── reading the one bar in the document ────────────────────────────────────────────────────
 *
 * There is no stylesheet under jsdom, so the admission rules do not fold anything: every group
 * stands in the row AND its menu half is present. That is why the row's own Resurface and Move
 * are pressable here, and why a "which one is on screen" question is not being asked.
 */
const rowButton = (el: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll<HTMLButtonElement>(".reader .abar-row button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
  expect(found, `no row button labelled ${label}`).toBeTruthy();
  return found!;
};
const panelButton = (el: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll<HTMLButtonElement>(".reader .abar-panel button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
  expect(found, `no panel button labelled ${label}`).toBeTruthy();
  return found!;
};
const panel = (el: HTMLElement): Element | null => el.querySelector(".reader .abar-panel");
const more = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>(".reader .abar-more")!;

/** The reader open on the row under the cursor — the surface every case below runs on. */
async function readerOpen(): Promise<HTMLElement> {
  const container = await shell();
  await key("j");
  await key("Enter");
  expect(container.querySelector(".reader"), "no reader opened at 390px").not.toBeNull();
  expect(container.querySelector(".reader .abar-row"), "no action bar in the reader").not.toBeNull();
  return container;
}

describe("opening a bar ceremony puts the keyboard in it", () => {
  it("RESURFACE lands on Now — the answer that costs nothing to change your mind about", async () => {
    const container = await readerOpen();
    await pointer(rowButton(container, "Resurface"));
    expect(panel(container)?.textContent, "the chooser did not open").toContain("Resurface when?");
    // Node identity, not text: the document contains the word "Now" whether or not focus moved.
    expect(document.activeElement).toBe(panelButton(container, "Now"));
  });

  it("MOVE lands on its first destination — the behaviour Resurface was missing", async () => {
    /* The positive control for the pair. Without it, "Resurface focuses its first control" could
       be satisfied by a change that focuses the first control of EVERY strip by accident, and the
       two verbs' focus lines would have no evidence of being the same rule. */
    const container = await readerOpen();
    await pointer(rowButton(container, "Move"));
    const first = [...container.querySelectorAll<HTMLButtonElement>(".reader .abar-panel button")]
      .find((b) => (b.textContent ?? "").trim().startsWith("→"))!;
    expect(first, "the destination strip has no destinations").toBeTruthy();
    expect(document.activeElement).toBe(first);
  });
});

describe("cancelling a ceremony puts the keyboard back on the control that opened it", () => {
  it("RESURFACE, by its Cancel button", async () => {
    const container = await readerOpen();
    await pointer(rowButton(container, "Resurface"));
    await pointer(panelButton(container, "Cancel"));
    expect(panel(container), "the chooser is still open").toBeNull();
    // Re-queried: the row came back as new nodes, so the pre-press node is detached by now.
    expect(document.activeElement).toBe(rowButton(container, "Resurface"));
    expect(sent, "cancelling put something on the wire").toEqual([]);
  });

  it("RESURFACE, by ESCAPE — which never travels through the bar at all", async () => {
    /* The case the fix exists for. Escape is handled by the shell's ordered list of open layers,
       which clears the bar's panel directly; a restore written into the Cancel button's handler
       would leave exactly this press unfixed, and Escape is the one people use. */
    const container = await readerOpen();
    await pointer(rowButton(container, "Resurface"));
    await key("Escape");
    expect(panel(container), "Escape did not close the chooser").toBeNull();
    expect(container.querySelector(".reader"), "Escape closed the reader as well").not.toBeNull();
    expect(document.activeElement).toBe(rowButton(container, "Resurface"));
  });

  it("MOVE, by its Cancel button", async () => {
    const container = await readerOpen();
    await pointer(rowButton(container, "Move"));
    await pointer(panelButton(container, "Cancel"));
    expect(panel(container)).toBeNull();
    expect(document.activeElement).toBe(rowButton(container, "Move"));
    expect(sent).toEqual([]);
  });

  it("DELETE, back to More — the disclosure is the only door the verb has", async () => {
    const container = await readerOpen();
    await pointer(more(container));
    const item = document.querySelector<HTMLElement>('[role="menu"] [data-item="delete"]');
    expect(item, "More offers no Delete with the folders foundation on").not.toBeNull();
    await pointer(item!);
    expect(container.querySelector(".reader .abar-delete"), "the confirm did not open").not.toBeNull();
    await pointer(panelButton(container, "Cancel"));
    expect(panel(container)).toBeNull();
    expect(document.activeElement).toBe(more(container));
    expect(sent.filter((m) => m.kind === "message_delete")).toEqual([]);
  });
});

describe("an open disclosure keeps the keys, on the shipped shell", () => {
  it("a letter pressed inside the More menu does not reach the mail underneath", async () => {
    /* The other half of the widen report, measured where the registry actually is. `a` is Answer
       Later on the shell's own map; with the menu open and the keyboard in it, the key used to
       travel to the document and park the message the menu was standing over — the menu still up
       afterwards, over mail that had changed.
     *
     * Dispatched on the FOCUSED ITEM and not on `document`: an event dispatched on the document
     * never travels down into the menu, so a press written that way would bypass the handler
     * under test and report a pass for a rule that had never run.
     *
     * The unit half of this — the claim on the native event, which is what stops the registry's
     * listener where React's root container IS the document — is in `menu-focus-on-widen.test.tsx`.
     */
    const container = await readerOpen();
    await pointer(more(container));
    const first = document.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]');
    expect(first, "the menu opened with no items").not.toBeNull();
    expect(document.activeElement, "the menu did not take the keyboard").toBe(first);
    await act(async () => {
      first!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    });
    expect(
      sent.flatMap((m) => (m.kind === "triage_set" ? [m.state] : [])),
      "`a` reached the shell and filed the message under the open menu",
    ).toEqual([]);
    expect(document.querySelector('[role="menu"]'), "the letter closed the menu").not.toBeNull();
  });
});

describe("answering is not cancelling", () => {
  it("choosing a horizon does NOT send the keyboard back to the trigger", async () => {
    /* The asymmetry, pinned. The verb has been spent and the message moves out from under the
       bar, so the control that asked is not where the keyboard belongs. Without this case the
       restore could quietly become "whenever the panel closes" and nothing would notice. */
    const container = await readerOpen();
    const trigger = rowButton(container, "Resurface");
    await pointer(trigger);
    await pointer(panelButton(container, "Now"));
    expect(panel(container), "the chooser stayed open after an answer").toBeNull();
    /* The horizon's own mutation. `EngineMutation` is keyed by `kind` and NOT by `type` — a
       filter on `type` compares `undefined` for every member of the union, so it answers
       "nothing was dispatched" whatever happened. Not hypothetical: the first version of this
       line and three in `delete-confirm-ghost.test.tsx` were written that way, and each was an
       assertion that could not fail. */
    expect(
      sent.flatMap((m) => (m.kind === "triage_set" ? [m.state] : [])),
      "the answer never reached the engine",
    ).toContain("resurfaced");
    expect(
      document.activeElement === rowButton(container, "Resurface"),
      "an answered ceremony returned the keyboard to the control that asked",
    ).toBe(false);
  });
});
