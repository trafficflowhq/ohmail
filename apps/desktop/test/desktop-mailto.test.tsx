/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { fireEvent } from "@testing-library/react";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import messages from "../../webapp/messages/en.json";

/**
 * ═══ A MAILTO CLICK BECOMES THE COMPOSE FORM ════════════════════════════════════════════════
 *
 * The OS delivers a mailto to the SHELL, which holds it; the window claims it (take-once) and
 * seeds the compose form. `mailto.test.ts` proves the parser field by field; this file proves
 * the half only a mounted window can prove — that a claim actually becomes a compose on screen,
 * on both delivery paths, and that nothing is seeded twice or seeded from garbage.
 *
 *  1. WARM: the app is open, the shell pokes (`link:mailto`), the window claims and the compose
 *     opens prefilled — recipient, subject and body all on screen.
 *  2. COLD: the click STARTED the app, so the poke fired before this bundle's scripts ran. The
 *     window's mount-time claim finds the held link and the compose still opens.
 *  3. ONCE: the slot is take-once shell-side, and the window clears its copy after seeding — a
 *     second poke that claims nothing changes nothing.
 *  4. NOT CONNECTED: a click before any mailbox is connected parks the draft; the chooser stays
 *     the surface, and no compose is faked over a window with no engine behind it.
 *  5. GARBAGE: a claim that answers something that is not a mailto seeds nothing and breaks
 *     nothing — the parser refuses and the window carries on.
 *
 * ── THE MUTATIONS THESE WERE WATCHED AGAINST ────────────────────────────────────────────────
 *  · never claim on the poke                       → 1 goes red;
 *  · never claim at mount                          → 2 goes red;
 *  · keep the draft after seeding                  → 3 goes red (the second poke re-seeds over
 *    the edit the case plants);
 *  · seed while the gate shows the chooser         → 4 goes red.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const SERVING: EngineStatus = {
  state: "serving",
  mode: "local",
  address: "someone@example.test",
  mailboxId: "mbx-1",
  credentialState: "ready",
};

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({
  asOfSeq: 0,
  changes: [],
  nextCursor: null,
  window: { days: 90, minRows: 500 },
});

/**
 * The stand-in shell: a mutable engine status, a one-slot mailto pending exactly like the Rust
 * side's (take-once, newest wins), and the event registry the poke is delivered through.
 */
function fakeShell(initial: EngineStatus): {
  set(status: EngineStatus): void;
  hold(link: string): void;
  poke(): void;
  claims(): number;
} {
  let status = initial;
  let pending: string | null = null;
  let claims = 0;
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners = new Map<string, number>();
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command === "mailto_claim") {
        claims++;
        const link = pending;
        pending = null;
        return link;
      }
      if (command === "plugin:event|listen") {
        listeners.set(String(payload?.event ?? ""), payload?.handler as number);
        return null;
      }
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      // default_mail_status, set_badge, notify — granted, and nothing this file asserts on.
      return null;
    },
  };
  return {
    set: (next) => {
      status = next;
    },
    hold: (link) => {
      pending = link;
    },
    poke: () => {
      const handler = listeners.get("link:mailto");
      if (handler === undefined) throw new Error("nothing is listening for link:mailto");
      callbacks.get(handler)!({ event: "link:mailto", id: 1, payload: null });
    },
    claims: () => claims,
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null))),
      ),
    );
  });
  await settle();
  return mountPoint;
}

/** The status call, the drain, the claim and the hash-routed navigation all need timer turns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  localStorage.clear();
});

beforeEach(() => {
  window.location.hash = "";
  localStorage.clear();
});

describe("a mailto activation becomes the compose form", () => {
  it("warm: the poke is claimed and the compose opens prefilled", async () => {
    const shell = fakeShell(SERVING);
    const el = await render();

    shell.hold("mailto:ada@example.test?subject=Loom%20plans&body=First%20line%0D%0ASecond");
    await act(async () => shell.poke());
    await settle();

    expect(window.location.hash).toBe("#/compose");
    const text = el.textContent ?? "";
    expect(text).toContain("ada@example.test");
    const subject = el.querySelector<HTMLInputElement>("input[value='Loom plans']");
    expect(subject, "the subject did not reach its field").not.toBeNull();
    expect(text).toContain("First line");
    expect(text).toContain("Second");
  });

  it("cold: a link held before the window existed is claimed at mount", async () => {
    const shell = fakeShell(SERVING);
    shell.hold("mailto:cold@example.test?subject=Started%20the%20app");
    const el = await render();

    expect(window.location.hash).toBe("#/compose");
    expect(el.textContent ?? "").toContain("cold@example.test");
    expect(shell.claims()).toBeGreaterThanOrEqual(1);
  });

  it("once: a poke that claims nothing changes nothing", async () => {
    const shell = fakeShell(SERVING);
    const el = await render();

    shell.hold("mailto:first@example.test?subject=One");
    await act(async () => shell.poke());
    await settle();
    expect(el.textContent ?? "").toContain("first@example.test");

    // The person starts editing — the field the second poke must not overwrite.
    window.location.hash = "#/ohbox";
    await settle();

    // A second poke with an EMPTY slot (the shell's take-once already answered) seeds nothing:
    // the route stays where the person put it.
    await act(async () => shell.poke());
    await settle();
    expect(window.location.hash).toBe("#/ohbox");
  });

  it("not connected: the chooser stays the surface and no compose is faked", async () => {
    const shell = fakeShell({ state: "not_configured", credentialState: "absent" } as EngineStatus);
    const el = await render();
    expect(el.textContent ?? "").toContain("Which mailbox is this?");

    shell.hold("mailto:waiting@example.test");
    await act(async () => shell.poke());
    await settle();
    // The claim happened — the draft is parked in the window, not dropped shell-side —
    // and the surface stays the honest one: connecting comes first.
    expect(shell.claims()).toBeGreaterThanOrEqual(1);
    expect(el.textContent ?? "").toContain("Which mailbox is this?");
    expect(window.location.hash).not.toBe("#/compose");
  });

  it("parked during boot: the draft seeds the moment the engine serves", async () => {
    // `starting` with a chosen door: the gate shows the boot surface, no mail client is mounted,
    // and the settling poll is live — the state a mailto clicked mid-launch actually lands in.
    const shell = fakeShell({ state: "starting", mode: "local", credentialState: "ready" } as EngineStatus);
    const el = await render();
    expect(window.location.hash).not.toBe("#/compose");

    shell.hold("mailto:waiting@example.test?subject=Parked");
    await act(async () => shell.poke());
    await settle();
    expect(window.location.hash).not.toBe("#/compose");

    // The engine comes up; the settling poll (250ms) sees it, the client mounts, the draft seeds.
    shell.set(SERVING);
    for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(window.location.hash).toBe("#/compose");
    expect(el.textContent ?? "").toContain("waiting@example.test");
  });

  it("garbage: a claim that is not a mailto seeds nothing and breaks nothing", async () => {
    const shell = fakeShell(SERVING);
    const el = await render();

    shell.hold("javascript:alert(1)");
    await act(async () => shell.poke());
    await settle();

    expect(window.location.hash).not.toBe("#/compose");
    expect((el.textContent ?? "").length).toBeGreaterThan(0);
  });
});

/**
 * THE DESKTOP KEEPS A LETTER UNDER THE MAILBOX ITS GATE MOUNTED. The same real gate over the same stand-in shell, with
 * the real frame and today's views: the scope the gate hands its frame is the mailbox it mounted, so a letter typed
 * here is kept under that mailbox's keys; a mailbox switched in place keeps the first one's last words under the first
 * and opens the second composer empty; a door given up draws no mail and leaves the words where they were.
 * Seen red with either hand-over fixed to one value (the gate's `scope={shellKey}`, the frame's `scope: p.scope`): the
 * second mailbox's composer opens with the first one's last words.
 */
describe("the desktop keeps words under the mounted mailbox", () => {
  const TWO: EngineStatus = { ...SERVING, mailboxId: "mbx-2", address: "other@example.test" };
  const pause = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= 50) await act(async () => { await new Promise((r) => setTimeout(r, Math.min(50, left))); });
  };
  const subject = (): HTMLInputElement | null => document.querySelector<HTMLInputElement>('input[aria-label="Subject"]');
  const type = async (words: string): Promise<void> => {
    await act(async () => { fireEvent.change(subject()!, { target: { value: words } }); });
  };
  const holding = (words: string): string[] =>
    Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? "").includes(words));
  /** As the key builders spell a mailbox: after a `.` or `:`, then a `.`, a `:` or the key's end. Never a substring. */
  const names = (key: string, mailbox: string): boolean => new RegExp(`[.:]${mailbox}([.:]|$)`).test(key);
  /** A key of a space that names nobody: `local`, `anon`, the bare look keys, the reply and compose keys with no account. */
  const namesNobody = (key: string): boolean =>
    /\.(local|anon)($|[.:])/.test(key) || key === "ohmail.ui.reader.afterVerb" || key === "ohmail.ui.compose.imageQuality"
    || key.startsWith("ohmail.ui.reply:") || key.startsWith("ohmail.ui.replymeta:") || key === "ohmail.ui.compose";
  /** Past the composer's own save. */
  const SAVED_MS = 2500;
  /** Past the gate's next look at the engine's status (`LIFECYCLE_POLL_MS`). */
  const NEXT_LOOK_MS = 6500;

  beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = "#/compose";
  });

  it("keeps a letter only under keys that name the mounted mailbox", async () => {
    fakeShell(SERVING);
    await render();
    await pause(500);
    expect(subject(), "the composer under the first mailbox").not.toBeNull();
    await type("Words under mailbox one");
    await pause(SAVED_MS);
    const keys = holding("Words under mailbox one");
    expect({ kept: keys.length > 0, underTheMailbox: keys.every((k) => names(k, "mbx-1")) })
      .toEqual({ kept: true, underTheMailbox: true });
  });

  it("a mailbox switched in place: the first one's last words stand under it, the second opens empty and keeps its own", async () => {
    const shell = fakeShell(SERVING);
    await render();
    await pause(500);
    await type("First words of mailbox one");
    await pause(SAVED_MS);
    /* The last keystroke is not saved yet when the status moves. */
    await type("Last words of mailbox one");
    shell.set(TWO);
    await pause(NEXT_LOOK_MS);
    const opened = subject()?.value ?? null;
    if (subject()) {
      await type("Words of mailbox two");
      await pause(SAVED_MS);
    }
    const one = holding("Last words of mailbox one");
    const two = holding("Words of mailbox two");
    expect({
      opened,
      oneKept: one.length > 0, oneUnderOne: one.every((k) => names(k, "mbx-1")),
      twoKept: two.length > 0, twoUnderTwo: two.every((k) => names(k, "mbx-2")),
      nobody: Object.keys(localStorage).filter(namesNobody),
    }).toEqual({ opened: "", oneKept: true, oneUnderOne: true, twoKept: true, twoUnderTwo: true, nobody: [] });
  }, 40_000);

  it("the door given up with words not yet saved: no mail is drawn, the words stand under their mailbox, no key names nobody", async () => {
    const shell = fakeShell(SERVING);
    await render();
    await pause(500);
    await type("First words");
    await pause(SAVED_MS);
    await type("Last words before the door went");
    shell.set({ state: "not_configured", credentialState: "absent" } as EngineStatus);
    await pause(NEXT_LOOK_MS);
    const keys = holding("Last words before the door went");
    expect({
      composer: subject() !== null,
      kept: keys.length > 0, underTheMailbox: keys.every((k) => names(k, "mbx-1")),
      nobody: Object.keys(localStorage).filter(namesNobody),
    }).toEqual({ composer: false, kept: true, underTheMailbox: true, nobody: [] });
  }, 40_000);
});
