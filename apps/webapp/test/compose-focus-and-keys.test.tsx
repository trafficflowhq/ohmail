/** @vitest-environment jsdom */
/**
 * ═══ OPENING COMPOSE MEANS WRITING — the caret, and the keys that must go quiet ══════════
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────
 *
 * Measured on the deployed desktop: press `c`, start typing, and nothing you type appears —
 * the form opened with NO field focused. Worse, with focus nowhere the typing guard
 * (`isTypingTarget`) sees no field, so every letter was still a live mailbox shortcut acting
 * on the message selected BEHIND the form: `e` parked it, `b` resurfaced it, the digits
 * navigated the rail, `/` left for Search — letter by letter, while the placeholders stayed
 * empty. The composer looked open and idle; the mailbox behind it was being filed.
 *
 * ── THE TWO HALVES OF THE FIX, AND WHY BOTH ──────────────────────────────────────────────
 *
 *  1. FOCUS ON MOUNT (`ComposeView.initialFocus`): the caret lands in the first field with
 *     nothing in it — To, then Subject, then the body. Decided once, at mount, so a
 *     re-render can never steal the caret back.
 *  2. THE WRITING-SURFACE CLAIM (`keymap.useWritingSurface`): focus is one blur away from
 *     nowhere (a click on dead space), so while the composer is MOUNTED the dispatcher
 *     refuses every chord a person could TYPE — bare letters, shifted ones, punctuation and
 *     the `g …` sequences — and the two they EDIT with, ⌫ and ⌦, which are named keys the
 *     typeable test passed while the mailbox bound both to "file this message to Trash".
 *     Escape, Tab, Enter and `mod` chords pass; a binding the composer itself owns opts back
 *     in (`inWriting`: the send-later digits, the `?` sheet).
 *
 * Deliberately NOT the modal gate: the compose form was moved OUT of a dialog the keyboard
 * could not leave (`ComposeView`), and `modalIsOpen()` answering true for it would make
 * every other gate treat the composer as standing over the deck. The claim suspends exactly
 * the chords a writer could press and nothing else.
 *
 * Part one drives the DISPATCHER through fixture components (the `modal-suspends-keymap`
 * harness); part two drives the SHIPPED SHELL, because the wiring — ComposeView claiming the
 * surface, the mount focus finding the real inputs — is exactly what a unit fixture cannot
 * see.
 *
 * RE-POINTED (the older tests' sorting, share write-1): the registry stands as the frame stands
 * it (`KeymapContext` over `useKeymapStore`), never through today's KeymapProvider; part two
 * drives the new shell (`_mail-shell.js`), where the composer is Write's letter, the region
 * "New message", found by role and name: its To the combobox "To", its subject the textbox
 * "Subject", its text the textbox "Message". Every expectation stands as it stood.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const { useKeyBindings, useWritingSurface, useCursorPlacer, KeymapContext, useKeymapStore } =
  await import("@ohmail/app-logic/keys/keymap");
/** The key registry as the frame stands it. */
function KeymapProvider({ children }: { children: React.ReactNode }) {
  return h(KeymapContext.Provider, { value: useKeymapStore() }, children);
}

let roots: Root[] = [];
let ran: string[] = [];
let placed: string[] = [];

/* THE SHELL'S MODULES ARE LOADED ONCE, HERE, under their own bound. The first case used to pay
   the cold import of the whole shell inside its 5 s test timeout: at load 45+ it timed out, the
   stranded mount kept its keymap, and the five cases after it read `c` as not opening Compose.
   What the cases measure is the keys and the caret, never the compile. */
beforeAll(async () => {
  await import("./_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);

beforeEach(() => {
  ran = [];
  placed = [];
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the shell still boots */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/** Dispatch a keydown the way the registry hears it — on `document`, i.e. focus NOWHERE. */
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
};

/* ─────────────────────────────────────────────────────────────────────────────────────────
   PART ONE — the dispatcher's rule, through fixture components.
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** The mailbox verbs a blurred composer must silence — every shape the rule judges. */
function Mailbox() {
  useKeyBindings([
    { chord: "e", group: "message", label: "Park", run: () => ran.push("park") },
    { chord: "shift+o", group: "message", label: "File read", run: () => ran.push("file-read") },
    { chord: "d d", group: "message", label: "Delete", run: () => ran.push("delete") },
    { chord: "Enter", group: "message", label: "Open", run: () => ran.push("open") },
    { chord: "Tab", group: "navigate", label: "Walk", run: () => ran.push("tab") },
    { chord: "Escape", group: "app", label: "Close", run: () => ran.push("escape") },
    { chord: "mod+k", group: "app", label: "Palette", inInput: true, run: () => ran.push("palette") },
    // The composer's own chrome opts back in — the send-later digits' shape.
    { chord: "1", group: "message", label: "Preset", inWriting: true, run: () => ran.push("preset") },
    // A field-scoped letter (none ships today, but the rule must not eat typing-target keys).
    { chord: "z", group: "message", label: "Typed verb", inInput: true, run: () => ran.push("typed-z") },
    /* THE NAMED DESTRUCTIVE KEYS, in `delete-undo.ts`'s own shape — a message verb behind a
       `when` against auto-repeat. Not typeable, so the writing claim did not reach them. */
    { chord: "Backspace", group: "message", label: "Trash", when: (e: KeyboardEvent) => !e.repeat, run: () => ran.push("trash-back") },
    { chord: "Delete", group: "message", label: "Trash", when: (e: KeyboardEvent) => !e.repeat, run: () => ran.push("trash-del") },
  ], "view");
  return h("div", { className: "app-root" }, h("input", { "aria-label": "field" }));
}

/**
 * A list with no cursor yet: ⌫ is declared and RESTING, and the first press is meant to place
 * the cursor rather than file (`keymap.tsx`'s parked walk). The dispatcher reaches it by the
 * same reachability rule as a live binding, so a blurred composer must not reach it either.
 */
function ParkedMailbox() {
  useKeyBindings([
    { chord: "Backspace", group: "message", label: "Trash", disabled: true, disabledReason: "no_cursor", run: () => ran.push("trash-parked") },
  ], "view");
  useCursorPlacer((label) => {
    placed.push(label);
    return true;
  });
  return h("div", { className: "app-root" });
}

/** Stands where ComposeView stands: mounted ⇒ the claim is held. */
function Writer() {
  useWritingSurface();
  return h("div", { className: "writer" });
}

async function mountFixture(writing: boolean, opts: { parked?: boolean } = {}): Promise<Root> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(h(KeymapProvider, {
      children: [
        h(opts.parked === true ? ParkedMailbox : Mailbox, { key: "m" }),
        ...(writing ? [h(Writer, { key: "w" })] : []),
      ],
    }));
  });
  return root;
}

describe("without a writing surface the mailbox keys work — otherwise part one proves nothing", () => {
  it("`e`, `⇧O` and `d d` all run", async () => {
    await mountFixture(false);
    await key("e");
    await key("O", { shiftKey: true });
    await key("d");
    await key("d");
    expect(ran).toEqual(["park", "file-read", "delete"]);
  });

  it("⌫ and ⌦ file the message — the keys the claim has to take away", async () => {
    await mountFixture(false);
    await key("Backspace");
    await key("Delete");
    expect(ran).toEqual(["trash-back", "trash-del"]);
  });

  it("a resting ⌫ places the cursor — the other half the claim has to take away", async () => {
    await mountFixture(false, { parked: true });
    await key("Backspace");
    expect(placed, "the parked walk never ran — the silenced case would be green for nothing")
      .toEqual(["Trash"]);
  });
});

describe("a mounted writing surface silences every chord a writer could press", () => {
  beforeEach(() => {
    ran = [];
  });

  it("a bare letter reaches no binding", async () => {
    await mountFixture(true);
    await key("e");
    expect(ran, "a blurred composer let a letter park the message behind it").toEqual([]);
  });

  it("a SHIFTED letter is typing too — capitals are written with Shift", async () => {
    await mountFixture(true);
    await key("O", { shiftKey: true });
    expect(ran, "⇧O filed the message behind a blurred composer").toEqual([]);
  });

  it("a sequence never arms — its first key is a typed character", async () => {
    await mountFixture(true);
    await key("d");
    await key("d");
    expect(ran, "`d d` ran its ceremony behind a blurred composer").toEqual([]);
  });

  it("⌫ and ⌦ reach no binding — a blurred reply may not file the message behind it", async () => {
    await mountFixture(true);
    await key("Backspace");
    await key("Delete");
    expect(ran, "a blurred composer let a named key file the message behind it").toEqual([]);
  });

  it("⌫ places no cursor either — a resting message verb is out of reach too", async () => {
    await mountFixture(true, { parked: true });
    await key("Backspace");
    expect(placed, "⌫ behind a blurred composer put a cursor on the list it would file from")
      .toEqual([]);
  });

  it("Escape, Tab, Enter and mod chords pass — the keys that are not prose", async () => {
    await mountFixture(true);
    await key("Escape");
    await key("Tab");
    await key("Enter");
    await key("k", { metaKey: true });
    expect(ran, "a named or modified chord was eaten — the composer became a modal")
      .toEqual(["escape", "tab", "open", "palette"]);
  });

  it("a binding that declares `inWriting` still runs — the send-later digits' door", async () => {
    await mountFixture(true);
    await key("1");
    expect(ran, "the composer's own picker key was suppressed by the composer's own claim")
      .toEqual(["preset"]);
  });

  it("keys typed INTO a field are untouched — the claim judges blurred keys only", async () => {
    await mountFixture(true);
    const field = document.querySelector<HTMLInputElement>("input[aria-label=field]")!;
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true }));
    });
    expect(ran, "an inInput binding stopped firing for a key typed into a field").toEqual(["typed-z"]);
  });

  it("⌫ INTO a field is left to the field — nothing is claimed, nothing is consumed", async () => {
    await mountFixture(true);
    const field = document.querySelector<HTMLInputElement>("input[aria-label=field]")!;
    const e = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    await act(async () => {
      field.dispatchEvent(e);
    });
    expect(e.defaultPrevented, "⌫ typed into a field was eaten — the character cannot be taken back")
      .toBe(false);
    expect(ran, "⌫ typed into a field filed the message behind the composer").toEqual([]);
  });

  it("the keys come back when the writing surface unmounts — no claim outlives its owner", async () => {
    const root = await mountFixture(true);
    await key("e");
    expect(ran).toEqual([]);
    await act(async () => {
      root.render(h(KeymapProvider, { children: [h(Mailbox, { key: "m" })] }));
    });
    await key("e");
    expect(ran, "the claim was never released — the mailbox is dead after one compose").toEqual(["park"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   PART TWO — the shipped shell: the wiring a fixture cannot see.
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** The shipped shell on the fixture world — the new shell's own demo mount. */
async function shell(): Promise<HTMLElement> {
  const { MailShell } = await import("./_mail-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(MailShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
  return container;
}

const rows = (c: HTMLElement): HTMLElement[] =>
  [...c.querySelectorAll<HTMLElement>('section[aria-label="Messages"] [role=option][data-id]')];

/* Write's letter, by role and name (today's `.view-compose`, `#compose-to`, `#compose-subject`, `.compose-editor`). */
const letter = (c: HTMLElement): HTMLElement | null =>
  c.querySelector<HTMLElement>('[role="region"][aria-label="New message"]');
const composing = (c: HTMLElement): boolean => letter(c) != null;
const toField = (c: HTMLElement): HTMLInputElement | null =>
  letter(c)?.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]') ?? null;
/** The letter's subject is a one-row text area in Write (a reply's is an input): either, by its name. */
const subjectField = (c: HTMLElement): HTMLInputElement | null =>
  letter(c)?.querySelector<HTMLInputElement>('[aria-label="Subject"]') ?? null;
const textField = (c: HTMLElement): HTMLElement | null =>
  letter(c)?.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]') ?? null;
/** The people on the To line: each is a press "Remove <address>" (today's `.rcp-chip`). */
const people = (c: HTMLElement): number =>
  [...(letter(c)?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .filter((b) => /^Remove .+@/.test(b.getAttribute("aria-label") ?? "")).length;
/** The key sheet (today's `.ks`) and the palette (today's `.palette`), by role and name. */
const sheetOpen = (): boolean =>
  [...document.querySelectorAll('[role="dialog"]')].some((d) => /keyboard/i.test(d.getAttribute("aria-label") ?? d.textContent ?? ""));
const paletteOpen = (): boolean =>
  document.querySelector('[role="dialog"][aria-label="Command palette"]') != null;

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  // Bounded by TIME, not by a tick count: 40 zero-delay ticks read as "never" at load 100.
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (cond()) return;
    // A real task, not a microtask: `go()` assigns `location.hash`, and jsdom delivers the
    // `hashchange` that re-renders the route as a TASK — a microtask drain never sees it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(cond(), what).toBe(true);
}

describe("pressing Compose puts the caret in To, and the mailbox keys go quiet", () => {
  it("`c` mounts the composer with the To field focused", async () => {
    const container = await shell();
    await key("c");
    await waitFor(() => composing(container), "`c` did not open Compose");
    expect(
      document.activeElement,
      "the composer opened with nothing focused — typing goes nowhere, and every letter is a shortcut",
    ).toBe(toField(container));
  });

  it("blurred, typed characters navigate nothing — `/`, `g o` and the pile digits go quiet", async () => {
    // The filing half of the accident (`e` parked, `b` resurfaced the message behind the form)
    // is proven at the dispatcher in part one: in this browser shell the route transition to
    // Compose closes the reader and the message verbs read `focused == null`, so a filing key
    // here would be refused by its own `disabled` gate whether or not the claim exists — a
    // green with two causes measures neither. What IS live behind the composer in this shell,
    // and was red before the claim, is navigation: `/` left for Search, `g o` for the Ohbox,
    // and a digit walked the rail — each taking the half-written message off the screen.
    const container = await shell();
    await waitFor(() => rows(container).length > 0, "the demo Ohbox never grew rows");
    await key("c");
    await waitFor(() => composing(container), "`c` did not open Compose");
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur?.();
    });

    /** Give a navigation its hashchange TASK, then insist nothing moved. */
    const still = async (after: string): Promise<void> => {
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      expect(
        window.location.hash,
        `${after} typed at a blurred composer changed the route`,
      ).toBe("#/compose");
      expect(
        letter(container),
        `${after} typed at a blurred composer took the composer off the screen`,
      ).not.toBeNull();
    };

    await key("/");
    await still("`/`");
    await key("g");
    await key("o");
    await still("`g o`");
    await key("2");
    await still("`2`");
  });

  it("Escape, ⌘K and `?` still work over the composer — it is not a modal", async () => {
    const container = await shell();
    await key("c");
    await waitFor(() => composing(container), "`c` did not open Compose");
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur?.();
    });

    await key("?");
    /* The frame's overlays are lazy parts: they settle across real tasks (the press is one). */
    await waitFor(() => sheetOpen(), "`?` no longer opens the sheet over Compose");
    await key("Escape"); // the sheet dismisses
    await waitFor(() => !sheetOpen(), "Escape did not close the sheet");

    await key("k", { metaKey: true });
    await waitFor(() => paletteOpen(), "⌘K no longer opens the palette over Compose");
    await key("Escape"); // the palette closes
    await waitFor(() => !paletteOpen(), "Escape did not close the palette");

    await key("Escape");
    await waitFor(
      () => !composing(container),
      "Escape stopped leaving Compose — the cascade broke",
    );
  });

  it("keys typed INTO the To field stay typing — the claim never reaches a focused field", async () => {
    const container = await shell();
    await key("c");
    await waitFor(() => composing(container), "`c` did not open Compose");
    const to = toField(container)!;
    const e = new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true });
    await act(async () => {
      to.dispatchEvent(e);
    });
    expect(e.defaultPrevented, "a letter headed into the To field was claimed by the registry").toBe(false);
    expect(letter(container), "`r` typed in To navigated or filed").not.toBeNull();
  });

  it("⌫ in the focused To field still takes the recipient back — the editing key edits", async () => {
    // The shipped positive control for the named keys: `RecipientField` answers ⌫ on an empty
    // input by removing the last chip, which is an edit jsdom really performs. If the writing
    // claim ever reached a FOCUSED field, this chip would survive and a message would go instead.
    const container = await shell();
    await key("c");
    await waitFor(() => composing(container), "`c` did not open Compose");
    const to = toField(container)!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value",
    )!.set!;
    await act(async () => {
      setter.call(to, "sam@example.com, ");
      to.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const chips = () => people(container);
    await waitFor(
      () => chips() > 0,
      "the typed recipient never became a chip — the control has nothing to take back",
    );
    const before = chips();
    await act(async () => {
      to.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    expect(chips(), "⌫ in the focused To field stopped removing the recipient").toBe(before - 1);
    expect(letter(container), "⌫ in To left the composer").not.toBeNull();
  });
});

describe("where the caret lands is the first empty field, decided once", () => {
  /** Type into an input the way React sees it — the native setter, then an input event. */
  async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("with To already answered, reopening lands on Subject; with both answered, in the body", async () => {
    const container = await shell();
    const reopen = async (subject: string): Promise<void> => {
      await act(async () => { window.location.hash = "#/drafts"; });
      const list = await within(container).findByRole("listbox", { name: messages.drafts.title });
      const saved = await within(list).findByRole("option", { name: `sam@example.com: ${subject}` });
      await act(async () => saved.click());
      await waitFor(() => composing(container), "the saved draft did not reopen");
    };

    // First open: To is empty, To gets the caret (asserted above; the premise here).
    await key("c");
    await waitFor(() => composing(container), "`c` did not open Compose");
    await typeInto(toField(container)!, "sam@example.com, ");

    // Leave and reopen from Drafts — the view remounts and the decision reruns.
    await key("Escape");
    await waitFor(() => !composing(container), "Escape did not leave Compose");
    await reopen(messages.drafts.noSubject);
    expect(
      document.activeElement,
      "with To answered the caret belongs in Subject — the writing resumes where it stopped",
    ).toBe(subjectField(container));

    await typeInto(subjectField(container)!, "Friday");
    await key("Escape");
    await waitFor(() => !composing(container), "Escape did not leave Compose");
    await reopen("Friday");
    // The body focus is the editor's own `autoFocus`, which fires when the editor exists —
    // after `immediatelyRender: false` resolves. Wait for it, then ask where the caret is.
    await waitFor(
      () => textField(container)?.getAttribute("contenteditable") === "true",
      "the editor never mounted",
    );
    await waitFor(
      () => textField(container)?.contains(document.activeElement) === true,
      "with To and Subject answered the caret belongs in the body",
    );
    // And the caret STAYS there across a re-render: the decision must not rerun.
    await typeInto(subjectField(container)!, "Friday again");
    expect(
      toField(container) === document.activeElement,
      "a re-render moved the caret back to To — the mount decision reran",
    ).toBe(false);
  });
});
