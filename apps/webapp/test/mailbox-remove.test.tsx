/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO, SubscriptionStatus } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";
import { fillFrom } from "../app/shell/locale";
import { formalAddress } from "./_formal-address";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  REMOVING A MAILBOX — the door that was missing on every surface
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `DELETE /mailboxes/:id` has been served since the mailbox surface was built, is step-up gated,
 * and had NO CALLER IN ANY CLIENT — the webapp, the desktop and the phone between them offered no
 * way to disconnect a mailbox, so the only route out was somebody with database access. This is
 * the webapp's door.
 *
 * ── WHAT THIS FILE PINS, AND WHY IT IS THE COPY AND NOT ONLY THE CALL ──────────────────────
 *
 * A removal is destructive and irreversible in one respect (the stored password), harmless in the
 * one people fear most (the mail itself), and consequential in a third nobody would guess
 * (queued scheduled sends). A confirmation that only asked "are you sure" would be worse than
 * none, so the confirmation states consequences — and the moment it states them, **the copy is a
 * claim about the server and has to be true of it**. That is what most of this file asserts.
 *
 * The sharpest case is `removeCopyStays`. The removal that KEEPS ohmail's copy (the default)
 * leaves the mail already synced in the account, so a confirmation saying the copy goes would be
 * a false statement about somebody's data at the moment they make a privacy decision. The copy
 * says it stays, and the guard below reads `MailboxService.delete` to hold that: the per-mailbox
 * erase is the other choice on the same confirmation (`mailbox-erase-press.test.tsx`), asked for
 * with the address typed, and a keep removal that reached the stamp would red here.
 */

const copy = messages.mailboxes as unknown as Record<string, string>;
const copyDe = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;
/* The repo root. `import.meta.url` is not a file URL under this file's jsdom environment, and
   vitest always runs from the repo root here (running it through `-F <pkg> exec` cannot load the
   root config's setup at all), so the working directory is the honest anchor. */
const SERVICE = "packages/services/src/mailbox-service.ts";

/**
 * The removal method's own body, and it REFUSES when the anchor is gone.
 *
 * `indexOf` of a signature that had been reflowed returned -1, `slice(-1)` handed back one
 * character, and the two guards below then read an empty string: one `toContain` reds, the other
 * is a `not.toContain` and passed for nothing. A signature change must red here instead.
 */
function removalMethod(src: string): string {
  const at = src.indexOf("  async delete(");
  expect(at, `${SERVICE} no longer declares \`async delete(\` — the guards below would read ''`)
    .toBeGreaterThan(0);
  const body = src.slice(at);
  return body.slice(0, body.indexOf("\n  /**", 10));
}

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;

const healthy = {
  status: "active", plan: "pro", credits: 100,
} as unknown as SubscriptionStatus;

let mockListed: MailboxDTO[] = [];
let mockRemoveCalls: string[] = [];
let mockRemoveThrows: unknown = null;
/** A closed step-up window: every DELETE is refused until the prompt's factor verifies. */
let mockWindowClosed = false;
let mockRefreshes = 0;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, twofaEnrolled: { webauthn: false, totp: true } },
        scope: "full",
      }),
      stepUpTotp: async () => { mockWindowClosed = false; return { ok: true }; },
    },
    billing: { subscription: async () => healthy },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      create: async () => mockListed[0]!,
      resync: async () => undefined,
      update: async () => mockListed[0]!,
      remove: async (id: string) => {
        if (mockWindowClosed) throw new actual.ApiError(403, "step_up_required", "recent two-factor authentication required");
        mockRemoveCalls.push(id);
        if (mockRemoveThrows) throw mockRemoveThrows;
        return undefined;
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => { mockRefreshes += 1; } }),
}));

/** The window's engine, as far as the pane uses it: the post-commit drain. */
let mockDrains = 0;
vi.mock("../app/shell/engine", async () => {
  const actual = await vi.importActual<typeof import("../app/shell/engine")>("../app/shell/engine");
  const engine = { syncOnce: async () => { mockDrains += 1; } };
  return { ...actual, useEngineOrNull: () => engine };
});

const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: "2026-08-04T11:00:00.000Z",
  createdAt: "2026-08-04T10:00:00.000Z", ...over,
} as MailboxDTO);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

/** The language the next {@link mount} renders in — German with English filled under it, as a tab has it. */
let mountLocale: "en" | "de" = "en";

async function mount(...items: MailboxDTO[]): Promise<HTMLDivElement> {
  await unmount();
  mockListed = items;
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: mountLocale,
      messages: (mountLocale === "de" ? fillFrom(messages as never, de as never) : messages) as never,
      children: h(MailboxSection),
    }));
  });
  await settle();
  return host;
}

function byText(el: HTMLElement, text: string): HTMLElement | null {
  return [...el.querySelectorAll("button, a")]
    .find((n) => (n.textContent ?? "").trim() === text) as HTMLElement | undefined ?? null;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field the walk needs is not on screen").toBeTruthy();
  const input = el as HTMLInputElement;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}

async function submit(form: Element | null): Promise<void> {
  expect(form, "a form the walk needs is not on screen").toBeTruthy();
  await act(async () => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** From the open confirmation to the DELETE: press it, and verify at the prompt if a closed window opens one. */
async function stepUp(el: HTMLElement): Promise<void> {
  await click(byText(el, copy.removeConfirm!)!);          // confirmation → DELETE (or the prompt)
  if (el.querySelector("#stepup-code")) {
    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form")); // factor → the parked DELETE
  }
}

beforeEach(() => {
  mockListed = [];
  mockRemoveCalls = [];
  mockRemoveThrows = null;
  mockWindowClosed = false;
  mockRefreshes = 0;
  mockDrains = 0;
});
afterEach(async () => { await unmount(); });

describe("the door exists at all", () => {
  it("a connected mailbox row offers Remove", async () => {
    const el = await mount(dto());
    expect(
      byText(el, copy.remove!),
      "a connected mailbox has no way to be removed — the route is served and nothing calls it",
    ).toBeTruthy();
  });

  it("Remove opens a CONFIRMATION and removes nothing by itself", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.remove!)!);
    const dialog = el.querySelector('[role="alertdialog"]');
    expect(dialog, "Remove did not open a confirmation").toBeTruthy();
    expect(mockRemoveCalls, "the first press must not destroy anything").toEqual([]);
  });

  it("Keep it removes nothing and returns to the list", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.remove!)!);
    await click(byText(el, copy.removeCancel!)!);
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mockRemoveCalls).toEqual([]);
    expect(byText(el, copy.remove!), "the row is still there and still removable").toBeTruthy();
  });
});

describe("the confirmation states the consequences, and each one is true of the server", () => {
  it("names all five, in the person's own language", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.remove!)!);
    const said = (el.querySelector('[role="alertdialog"]') as HTMLElement).textContent ?? "";
    for (const key of [
      "removeStops", "removeMailSafe", "removeCredential", "removeScheduled", "removeCopyStays",
    ]) {
      expect(said, `the confirmation does not say ${key}`).toContain(copy[key]!);
    }
    // The address, so a two-mailbox account cannot confirm the wrong one.
    expect(said).toContain("person@example.test");
  });

  /**
   * THE LOAD-BEARING PROMISE. `MailboxService.delete` opens no IMAP connection at all, so no
   * folder and no message on the user's own server is reachable from this press. The guard reads
   * the service rather than trusting the sentence.
   */
  it("`removeMailSafe` is true: the service touches no mail on the server", () => {
    const src = readFileSync(SERVICE, "utf8");
    const method = removalMethod(src);
    expect(method, "the removal must not open a mail connection").not.toMatch(/probe|ImapAdapter|imapProbe/);
    expect(copy.removeMailSafe, "the promise must name where the mail stays")
      .toMatch(/mail server/);
  });

  /**
   * THE UNFLATTERING ONE, AND THE REASON IT IS WORDED THE WAY IT IS. A removal that keeps the copy
   * deletes credentials and nothing else, so the synced copy survives; only the erase arm stamps.
   */
  it("`removeCopyStays` is true: the service deletes credentials and not messages", () => {
    const src = readFileSync(SERVICE, "utf8");
    const method = removalMethod(src);
    expect(method).toContain("tx.delete(mailboxCredentials)");
    expect(method, "a removal that purged the mirror would make the confirmation's copy false")
      .not.toContain("tx.delete(messages)");
    // THE PER-MAILBOX ERASE EXISTS, and this sentence stays true of the removal that KEEPS the
    // copy because the caller has to ask for the other one: the statement before the erasure's
    // stamp is the early return that sends every ordinary removal home. Read as the LINE BEFORE
    // rather than as "a gate appears somewhere" — the method carries two other `opts.erase`
    // branches, either of which would satisfy that and say nothing about the stamp. The client's
    // keep path sends no erase; the erase is its own call (`mailbox-erase-press.test.tsx`).
    const lines = method.split("\n");
    const sweepAt = lines.findIndex((l) => l.includes("stampMailboxErasure("));
    expect(sweepAt, "the erasure's stamp is gone — this guard reads it").toBeGreaterThan(0);
    let before = sweepAt - 1;
    while (before > 0 && /^\s*(\/[/*]|\*|$)/.test(lines[before]!)) before -= 1;
    expect(lines[before], "every ordinary removal must return before the sweep")
      .toMatch(/^\s*if \(!opts\.erase\) return\b/);
    const client = readFileSync("apps/webapp/app/api-client.ts", "utf8");
    const removeLine = client.split("\n").find((l) => /^\s*remove: \(id: string\) =>/.test(l));
    expect(removeLine, "the keep path's call is gone — this guard reads it").toBeTruthy();
    expect(removeLine, "the removal that keeps the copy sends an erase").not.toMatch(/erase/);
    expect(copy.removeCopyStays).toMatch(/stays in your account/);
  });

  /** The consequence with no other surface — a queued send that will not happen. */
  it("`removeScheduled` is true: the removal closes the appointments it orphans", () => {
    const src = readFileSync(SERVICE, "utf8");
    expect(src).toContain("closeRemovedMailboxAppointments");
    expect(copy.removeScheduled).toMatch(/Drafts/);
  });

  it("the confirmation never says the mail is deleted", async () => {
    const el = await mount(dto());
    await click(byText(el, copy.remove!)!);
    const said = ((el.querySelector('[role="alertdialog"]') as HTMLElement).textContent ?? "")
      .toLowerCase();
    // The one sentence a removal confirmation must not contain, in either direction.
    expect(said).not.toMatch(/deletes your mail|your mail is deleted|removes your messages/);
  });
});

describe("the removal itself is behind the account's second factor", () => {
  it("on a closed window the confirm opens the step-up, and the DELETE lands only after the factor", async () => {
    mockWindowClosed = true;
    const el = await mount(dto({ id: "mb-target" }));
    await click(byText(el, copy.remove!)!);
    await click(byText(el, copy.removeConfirm!)!);
    // The server refused the DELETE for the window; the prompt asks for the factor, in place.
    expect(el.querySelector("#stepup-code"), "a closed window did not open the prompt").toBeTruthy();
    expect(el.querySelector('input[type="password"]'), "the confirm asked for a password").toBeNull();
    expect(mockRemoveCalls).toEqual([]);

    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    expect(mockRemoveCalls, "the removal did not reach the server").toEqual(["mb-target"]);
  });

  it("the prompt says it is authorising a REMOVAL, not a save", async () => {
    mockWindowClosed = true;
    const el = await mount(dto());
    await click(byText(el, copy.remove!)!);
    await click(byText(el, copy.removeConfirm!)!);
    const said = el.textContent ?? "";
    expect(said, "the prompt describes the wrong act").toContain(copy.factorBodyRemove!);
    expect(said).not.toContain(copy.factorBodyEdit!);
  });

  it("a refused removal returns to the confirmation with the server's sentence", async () => {
    const { ApiError } = await import("../app/api-client");
    mockRemoveThrows = new ApiError(500, "internal", "the removal could not be written");
    const el = await mount(dto());
    await click(byText(el, copy.remove!)!);
    await stepUp(el);
    // Still at the confirmation, not dropped onto a list that says nothing about what happened.
    expect(el.querySelector('[role="alertdialog"]'), "the refusal left the confirmation").toBeTruthy();
    expect(el.textContent).toContain("the removal could not be written");
  });

  it("a completed removal re-reads the list and the rail's strip", async () => {
    const el = await mount(dto({ id: "mb-target" }));
    await click(byText(el, copy.remove!)!);
    await stepUp(el);
    expect(mockRemoveCalls).toEqual(["mb-target"]);
    expect(mockRefreshes, "the strip would stay a poll behind").toBeGreaterThan(0);
  });

  /* The removal closes the mailbox's scheduled sends: rows the window's mirror carries. Without a
     drain here the Drafts list says "Sends Tue 14:50" until the next poll. A refusal drains nothing. */
  it("a completed removal drains the window's mirror once, and a refused one does not", async () => {
    const el = await mount(dto({ id: "mb-target" }));
    await click(byText(el, copy.remove!)!);
    await stepUp(el);
    expect(mockRemoveCalls).toEqual(["mb-target"]);
    expect(mockDrains, "the closed appointments wait for the next poll").toBe(1);

    const { ApiError } = await import("../app/api-client");
    mockRemoveThrows = new ApiError(500, "internal", "the removal could not be written");
    mockDrains = 0;
    const again = await mount(dto({ id: "mb-other" }));
    await click(byText(again, copy.remove!)!);
    await stepUp(again);
    expect(mockDrains, "a refused removal changed nothing to drain").toBe(0);
  });
});

describe("the copy exists in both catalogues", () => {
  it("every removal key the pane reads is translated", () => {
    const keys = [
      "remove", "removeTitle", "removeStops", "removeMailSafe", "removeCredential",
      "removeScheduled", "removeCopyStays", "removeReconnect", "removeConfirm",
      "removeCancel", "removeWorking", "factorBodyRemove",
    ];
    for (const k of keys) {
      expect(copy[k], `en is missing mailboxes.${k}`).toBeTruthy();
      expect(copyDe[k], `de is missing mailboxes.${k}`).toBeTruthy();
      expect(copyDe[k], `de.${k} was left in English`).not.toBe(copy[k]);
    }
    // The title interpolates the address in both, or one locale confirms an unnamed mailbox.
    expect(copy.removeTitle).toContain("{address}");
    expect(copyDe.removeTitle).toContain("{address}");
  });

  it("the German removal speaks to the reader as du, from the confirmation to the factor screen", async () => {
    mountLocale = "de";
    // A closed window, so the confirm opens the factor prompt in place (the walk the English cases take).
    mockWindowClosed = true;
    try {
      const el = await mount(dto());
      await click(byText(el, copyDe.remove!)!);
      const sheet = el.querySelector('[role="alertdialog"]') as HTMLElement;
      expect(sheet.textContent).toContain(copyDe.removeMailSafe);
      expect(formalAddress(sheet), "the confirmation says Sie").toEqual([]);
      await click(byText(el, copyDe.removeConfirm!)!);
      expect(el.querySelector("#stepup-code"), "a closed window did not open the prompt").toBeTruthy();
      expect(el.textContent).toContain(copyDe.factorBodyRemove);
      expect(formalAddress(el), "the factor screen says Sie").toEqual([]);
    } finally {
      mountLocale = "en";
    }
  });

  it("the German confirmation makes the same untouched-mail promise", () => {
    // The promise is the reason a person can press the button. A locale that dropped it would be
    // a different product in German.
    expect(copyDe.removeMailSafe).toMatch(/Mailserver/);
    expect(copyDe.removeCopyStays).toMatch(/Account/);
  });
});
