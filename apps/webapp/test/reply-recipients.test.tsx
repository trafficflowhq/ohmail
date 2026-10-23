/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import type { EmailAddress } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import {
  formatRecipientLine,
  replyEnvelopeOnWire,
  replyEnvelopePlan,
} from "../app/shell/compose-from";
import { parseRecipients } from "../app/shell/compose";
import { canSend } from "../app/shell/mail-send";

/**
 * THE REPLY'S RECIPIENTS ARE ALWAYS EDITABLE — and until they are edited, NOTHING changed.
 *
 * Reported: *"if reply or reply all, the receivers should always be editable, also cc and bcc,
 * no matter if reply, reply all or wherever this appears."* The head that names the audience
 * is a button now; pressing it opens the same To/Cc/Bcc chip rows Compose has, prefilled with
 * exactly what the head claimed, and from then on the user's strings ARE the envelope.
 *
 * Two invariants carry this file:
 *
 *  1. UNTOUCHED ⇒ BYTE-IDENTICAL. `replyEnvelopePlan(…, edit: null)` must be the derivation
 *     `sendReply` always made — `inline-reply.test.ts` pins the wire's exact key set for the
 *     untouched path, and the pure half is pinned here.
 *  2. BCC IS NEVER DERIVED. No reply of any kind blind-copies anybody (`types.ts`): however
 *     rich the parent's To/Cc lists are, a blind recipient exists only when somebody TYPED
 *     one. Derive one from the parent and the first test below goes red.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const addr = (address: string, name: string | null = null): EmailAddress => ({ name, address });

/* ══ the pure plan ══════════════════════════════════════════════════════════════════════ */

describe("replyEnvelopePlan — untouched, the computed envelope stands", () => {
  const MINE = ["me@example.test"];
  const parent = {
    from: addr("lena@atelier.example", "Lena"),
    to: [addr("me@example.test"), addr("piet@atelier.example")],
    cc: [addr("dana@atelier.example")],
  };

  it("NEVER derives a bcc — not on a plain reply, not on a reply-all, whatever the parent holds", () => {
    // The invariant. The parent above carries plenty of recipients to be tempted by; a blind
    // recipient exists only when somebody typed one. Derive `bcc` from the parent's lists in
    // `replyEnvelopePlan` and both assertions go red.
    expect(replyEnvelopePlan(parent, MINE, false, null).bcc).toBeNull();
    expect(replyEnvelopePlan(parent, MINE, true, null).bcc).toBeNull();
    // …and off the wire entirely, not sent as an empty array.
    expect("bcc" in replyEnvelopeOnWire(replyEnvelopePlan(parent, MINE, true, null))).toBe(false);
  });

  it("plain reply: `to` stays null for the ordinary case — Engine.enrich keeps owning it", () => {
    const plan = replyEnvelopePlan(parent, MINE, false, null);
    expect(plan.to).toBeNull();
    expect(plan.cc).toBeNull();
    expect(replyEnvelopeOnWire(plan)).toEqual({});
  });

  it("reply-all: exactly `replyAllRecipients` — sender leads To, surviving Cc keeps its line", () => {
    const plan = replyEnvelopePlan(parent, MINE, true, null);
    expect(plan.to).toEqual([addr("lena@atelier.example", "Lena"), addr("piet@atelier.example")]);
    expect(plan.cc).toEqual([addr("dana@atelier.example")]);
  });

  it("a parent the mirror does not know puts nothing on the wire", () => {
    expect(replyEnvelopeOnWire(replyEnvelopePlan(null, MINE, true, null))).toEqual({});
  });
});

describe("replyEnvelopePlan — edited, the user's strings are the envelope", () => {
  const parent = { from: addr("lena@atelier.example"), to: [addr("me@example.test")], cc: [] };

  it("carries what was typed: to, cc and a TYPED bcc all reach the wire", () => {
    const plan = replyEnvelopePlan(parent, ["me@example.test"], false, {
      to: "piet@atelier.example, Dana <dana@atelier.example>",
      cc: "carla@atelier.example",
      bcc: "blind@example.test",
    });
    expect(plan.to?.map((a) => a.address)).toEqual(["piet@atelier.example", "dana@atelier.example"]);
    expect(plan.cc?.map((a) => a.address)).toEqual(["carla@atelier.example"]);
    expect(plan.bcc?.map((a) => a.address)).toEqual(["blind@example.test"]);
  });

  it("an emptied Cc leaves the key off the wire — removing everyone from a line removes the line", () => {
    const wire = replyEnvelopeOnWire(
      replyEnvelopePlan(parent, [], true, { to: "piet@atelier.example", cc: "", bcc: "" }),
    );
    expect(wire.to?.map((a) => a.address)).toEqual(["piet@atelier.example"]);
    expect("cc" in wire).toBe(false);
    expect("bcc" in wire).toBe(false);
  });

  it("a typo in ANY row empties the whole envelope — the compose rule, not 'send the valid ones'", () => {
    const plan = replyEnvelopePlan(parent, [], false, {
      to: "piet@atelier.example", cc: "nope", bcc: "",
    });
    expect(plan.to).toEqual([]);
    expect(plan.invalid.cc).toEqual(["nope"]);
    // …and the emptied set is refused at the one predicate every caller consults.
    expect(canSend({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: "m1", body: "text", ...replyEnvelopeOnWire(plan),
    })).toBe(false);
  });

  it("removing every recipient blocks the send — an edited reply cannot go to nobody", () => {
    const plan = replyEnvelopePlan(parent, [], false, { to: "", cc: "", bcc: "" });
    expect(plan.to).toEqual([]);
    expect(canSend({ phase: "idle" }, {
      kind: "mail_send", inReplyTo: "m1", body: "text", ...replyEnvelopeOnWire(plan),
    })).toBe(false);
    // The UNTOUCHED reply still needs no recipient of its own — absent means enrich decides.
    expect(canSend({ phase: "idle" }, { kind: "mail_send", inReplyTo: "m1", body: "text" }))
      .toBe(true);
  });
});

describe("formatRecipientLine — the prefill round-trips through the parser", () => {
  it("keeps a safe display name and reads back to the same addresses", () => {
    const line = formatRecipientLine([addr("lena@atelier.example", "Lena"), addr("p@q.example")]);
    const parsed = parseRecipients(line);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.addresses).toEqual([addr("lena@atelier.example", "Lena"), addr("p@q.example")]);
  });

  it("drops a name the blind comma-split would shred — the address is the envelope", () => {
    // "Doe, John" would come back as two broken entries; the bare address survives instead.
    const line = formatRecipientLine([addr("doe@example.test", "Doe, John")]);
    expect(line).toBe("doe@example.test");
    expect(parseRecipients(line).invalid).toEqual([]);
  });
});

/* ══ through the shell — the head opens, the edit reaches the adapter ═══════════════════ */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  // Open a message (the resting Ohbox opens none by itself), then its reply editor.
  await key("j");
  await key("r");
}

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const reply = (): HTMLElement => host!.querySelector<HTMLElement>(".read-col .reply")!;

/** The recipient row input labelled `label` inside the opened editor. */
function rowInput(label: string): HTMLInputElement {
  const l = [...reply().querySelectorAll<HTMLLabelElement>(".reply-rcpt label")]
    .find((el) => el.textContent === label)!;
  return document.getElementById(l.htmlFor) as HTMLInputElement;
}

async function typeRecipient(label: string, text: string): Promise<void> {
  const el = rowInput(label);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

/**
 * Open the subject input, retrying once per settle: the rich editor's DEFERRED init focuses
 * itself exactly once, and a press that lands before that moment has its input blurred shut —
 * the component's documented one-time race, which a person recovers from by clicking again.
 */
async function openSubjectInput(): Promise<HTMLInputElement> {
  for (let i = 0; i < 10; i++) {
    const btn = reply().querySelector<HTMLButtonElement>(".reply-subject");
    if (btn) await act(async () => { btn.click(); });
    const input = reply().querySelector<HTMLInputElement>(".reply-subject-input");
    if (input) return input;
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  throw new Error("the subject input never opened");
}

const sendButton = (): HTMLButtonElement =>
  [...host!.querySelectorAll<HTMLButtonElement>(".read-col .msg .reply-actions button")]
    .find((b) => b.textContent?.trim().startsWith("Send"))!;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  setViewport();
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
});

describe("ONE set of own addresses decides who Reply all offers AND who it sends to", () => {
  /**
   * ── THE SCREEN AND THE WIRE HAD TWO DIFFERENT ANSWERS TO "WHO AM I" ────────────────────
   *
   * `compose-from.ts`'s header states the discipline: the surface renders from these functions
   * and the shell builds the mutation from them, "so there is no second implementation for one
   * of them to drift into". The comment above `sendReply`'s call says its resolution is "the
   * same call that let the button render". It was not the same ARGUMENT.
   *
   *   · the bar's predicate and the head read `ownAddresses` — `GET /mailboxes`, else a boot
   *     cache, else `[]`;
   *   · `sendReply` passed `fromOptions.map(o => o.address)` — the same facts when there are
   *     facts, but the MIRROR's mailbox rows when there are none.
   *
   * They differ on exactly the surfaces with no `GET /mailboxes`: `?demo=1` and the desktop
   * shell, where the mirror does carry addresses. There the bar computed with an unknown reader
   * and the send computed with a known one, and the first case below is what that costs.
   *
   * The fix is the argument, not the functions: both read `ownAddresses`. The better answer —
   * teaching `ownAddresses` the mirror fallback, so those surfaces know the reader everywhere —
   * is a wider change (it moves the "me" chip, the address book's exclusion and the screening
   * baseline on the desktop too) and is left for a slice that can measure it.
   */
  it("a self-authored parent: the two sources disagree, so the head and the wire would too", () => {
    // Sent by the reader to one other person. Two To slots, one of them the reader's own.
    const parent = {
      from: addr("me@example.test"),
      to: [addr("me@example.test"), addr("piet@atelier.example")],
      cc: [] as EmailAddress[],
    };
    // KNOWN reader (facts present): "all" adds nobody the plain reply misses, so there is no
    // reply-all envelope and the plan falls through to the plain answer — Piet alone.
    const known = replyEnvelopePlan(parent, ["me@example.test"], true, null);
    expect(known.to).toEqual([addr("piet@atelier.example")]);
    // UNKNOWN reader (`[]`): the reader cannot be filtered, so the envelope keeps the reader's
    // own address on it. That is the documented degradation — and it is a DIFFERENT envelope.
    const unknown = replyEnvelopePlan(parent, [], true, null);
    expect(unknown.to).toEqual([addr("me@example.test"), addr("piet@atelier.example")]);
    expect(unknown.to, "the two sources are not interchangeable").not.toEqual(known.to);
  });

  it("so `sendReply` resolves the envelope from `ownAddresses` — the predicate's own source", () => {
    /**
     * A source guard, because the failure is quiet: both arguments are a `string[]` of the
     * account's addresses and they agree wherever `GET /mailboxes` answers, which is every
     * surface a test like this normally mounts. `fromOptions` is the FROM selector's list — what
     * this account may send AS — and it is the right answer to a different question.
     */
    const src = readFileSync(
      [
        resolve(process.cwd(), "app/shell/shell-compose.ts"),
        resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts"),
      ].find(existsSync)!,
      "utf8",
    );
    const call = /replyEnvelopePlan\(\s*([\s\S]*?)\)\s*;/.exec(src);
    expect(call, "sendReply no longer builds the envelope through replyEnvelopePlan").not.toBeNull();
    expect(
      call![1],
      "the wire resolves who the reader is from the FROM selector, not from the identity the bar used",
    ).not.toMatch(/fromOptions/);
    expect(call![1], "the wire must read the same `ownAddresses` the predicate does")
      .toMatch(/\bownAddresses\b/);
  });
});

describe("the reply's subject edits in place — and threading never depends on it", () => {
  /**
   * ITEM: SUBJECT EDITABLE-IN-PLACE ON REPLY. The subject renders as calm plain text (a button
   * wearing prose, `.reply-subject`), never a form field; pressing it swaps in an input holding
   * the FULL subject — the `Re:` prefix exposed, handled rather than fought. The edited text
   * rides the mutation's `subject`; `inReplyTo` rides regardless, which is what the server's
   * `In-Reply-To`/`References` derivation reads — the conversation stays whole whatever the
   * subject says, so no warning banner is owed and none renders.
   */
  it("plain text → input on press; the FULL subject (Re: exposed); the edit rides the wire beside inReplyTo", async () => {
    const { FixturesAdapter } = await import("@ohmail/client-engine");
    const seen: Array<Record<string, unknown>> = [];
    const real = FixturesAdapter.prototype.mutate;
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (
      this: unknown, m: unknown, opts: unknown,
    ) {
      seen.push(m as Record<string, unknown>);
      return (real as (this: unknown, m: unknown, o: unknown) => Promise<unknown>).call(this, m, opts);
    } as never);

    await mountShell();
    // Write the body FIRST — it settles the rich editor (its deferred init focuses itself
    // once, exactly as it does for a person who opens a reply and starts typing). The surface
    // mounts deferred (`immediatelyRender: false`), so wait for it within a bounded loop.
    let editor = host!.querySelector<HTMLElement>(".read-col .msg .rte-surface");
    for (let i = 0; i < 20 && !editor; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      editor = host!.querySelector<HTMLElement>(".read-col .msg .rte-surface");
    }
    expect(editor, "the reply's rich editor never mounted").not.toBeNull();
    await act(async () => { typeInto(editor!, "Passt."); });
    await settle();

    // Calm plain text: a button, not an input, and no input on screen yet.
    const subjectBtn = reply().querySelector<HTMLButtonElement>(".reply-subject");
    expect(subjectBtn, "the reply renders no subject line").not.toBeNull();
    expect(reply().querySelector(".reply-subject-input")).toBeNull();
    const derived = subjectBtn!.querySelector(".reply-subject-text")!.textContent!;
    expect(derived.startsWith("Re: "), `the derived subject exposes the prefix (${derived})`).toBe(true);

    // Press → an input, in place, holding the FULL subject.
    const input = await openSubjectInput();
    expect(input.value).toBe(derived);

    // Edit it — the whole line is the user's, prefix included.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Thursday works (was: planning)");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // No warning chrome: the subject edit is an ordinary act, not a hazard — checked while
    // the editor is still open (a settled send closes it).
    expect(reply().querySelector("[role='alert']")).toBeNull();

    await act(async () => { sendButton().click(); });
    await settle();

    const sends = seen.filter((m) => m.kind === "mail_send");
    expect(sends).toHaveLength(1);
    const payload = sends[0]! as { subject?: string; inReplyTo?: string | null };
    // The edited subject IS the wire's — not re-prefixed, not restored to the derived one.
    expect(payload.subject).toBe("Thursday works (was: planning)");
    // …and the threading anchor rides regardless of what the subject says.
    expect(typeof payload.inReplyTo).toBe("string");
    expect((payload.inReplyTo as string).length).toBeGreaterThan(0);
  });

  it("the edit SURVIVES close-and-reopen — Escape must not un-title the reply", async () => {
    // Review round 1: closing the editor nulls `replyTo` and the retarget effect used to
    // blind-reset the edit while the BODY survived through its own scratch — so Escape
    // silently restored the derived subject. The edit now lives in the per-message meta
    // (`replyMetaKey`) on the body scratch's lifecycle: reopen restores it, a settled send
    // spends it.
    await mountShell();
    let editor = host!.querySelector<HTMLElement>(".read-col .msg .rte-surface");
    for (let i = 0; i < 20 && !editor; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
      editor = host!.querySelector<HTMLElement>(".read-col .msg .rte-surface");
    }
    await act(async () => { typeInto(editor!, "Passt."); });
    await settle();

    const input = await openSubjectInput();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Kept across a close");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Close (Escape falls to the view's binding from outside the input), then reopen.
    await key("Escape");
    expect(host!.querySelector(".read-col .reply"), "the editor did not close").toBeNull();
    await key("r");
    const shown = reply().querySelector(".reply-subject-text")?.textContent
      ?? reply().querySelector<HTMLInputElement>(".reply-subject-input")?.value;
    expect(shown, "the reopened reply lost its retitled subject").toBe("Kept across a close");
  });

  it("untouched, the wire carries the DERIVED subject — the edit state attaches nothing", async () => {
    const { FixturesAdapter } = await import("@ohmail/client-engine");
    const seen: Array<Record<string, unknown>> = [];
    const real = FixturesAdapter.prototype.mutate;
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (
      this: unknown, m: unknown, opts: unknown,
    ) {
      seen.push(m as Record<string, unknown>);
      return (real as (this: unknown, m: unknown, o: unknown) => Promise<unknown>).call(this, m, opts);
    } as never);

    await mountShell();
    const shown = reply().querySelector(".reply-subject-text")!.textContent!;
    const editor = host!.querySelector<HTMLElement>(".read-col .msg .rte-surface")!;
    await act(async () => { typeInto(editor, "Passt."); });
    await act(async () => { sendButton().click(); });
    await settle();

    const payload = seen.filter((m) => m.kind === "mail_send")[0]! as { subject?: string };
    // The adapter sees the ENRICHED mutation, whose subject is the derivation the line showed —
    // the line on screen and the subject on the wire are one answer.
    expect(payload.subject).toBe(shown);
  });
});

describe("the reply head opens into editable recipients", () => {
  it("is a BUTTON naming the audience; pressing it swaps in prefilled chip rows", async () => {
    await mountShell();
    const head = reply().querySelector<HTMLButtonElement>(".reply-head-btn");
    expect(head, "the reply head is not a control — recipients are not editable").not.toBeNull();
    expect(head!.textContent).toContain("Reply to");

    await act(async () => { head!.click(); });

    // The head is gone; the rows are up; the To row holds the computed audience as a CHIP
    // whose entry parses to a real address — the prefill is the envelope, not a caption.
    expect(reply().querySelector(".reply-head-btn")).toBeNull();
    const chips = [...reply().querySelectorAll<HTMLElement>(".reply-rcpt .rcp-chip")];
    expect(chips.length).toBeGreaterThan(0);
    const entry = chips[0]!.dataset.entry!;
    expect(parseRecipients(entry).invalid).toEqual([]);
    // CC AND BCC ARE ALREADY OPEN — no second click (2026-08-27). Opening the stack IS the
    // "change recipients" act, so the blind-copy row is reachable the moment the head is
    // pressed; a toggle here was two clicks about one decision.
    expect(reply().querySelector(".reply-rcpt .c-ccbcc-toggle")).toBeNull();
    const labels = [...reply().querySelectorAll<HTMLLabelElement>(".reply-rcpt .c-field label")]
      .map((l) => l.textContent);
    expect(labels).toContain("Cc");
    expect(labels).toContain("Bcc");
  });

  it("Enter on the head opens the rows with focus IN the To field, never on the list row", async () => {
    await mountShell();
    const head = reply().querySelector<HTMLButtonElement>(".reply-head-btn")!;
    await act(async () => { head.focus(); });
    // The browser's own activation: the keydown, then the click it fires when nothing prevented it.
    const press = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { head.dispatchEvent(press); });
    if (!press.defaultPrevented) await act(async () => { head.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(reply().querySelector(".reply-rcpt"), "the rows did not open").not.toBeNull();
    expect(document.activeElement).toBe(rowInput("To"));
    expect(document.activeElement?.closest(".row[data-id]")).toBeNull();
  });

  it("an edited envelope reaches the adapter: recipients added, Bcc typed, all on the mutation", async () => {
    const { FixturesAdapter } = await import("@ohmail/client-engine");
    const seen: Array<Record<string, unknown>> = [];
    const real = FixturesAdapter.prototype.mutate;
    vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(function (
      this: unknown, m: unknown, opts: unknown,
    ) {
      seen.push(m as Record<string, unknown>);
      return (real as (this: unknown, m: unknown, o: unknown) => Promise<unknown>).call(this, m, opts);
    } as never);

    await mountShell();
    await act(async () => { reply().querySelector<HTMLButtonElement>(".reply-head-btn")!.click(); });
    const prefilled = reply().querySelector<HTMLElement>(".reply-rcpt .rcp-chip")!.dataset.entry!;

    // Add a second To recipient and blind-copy somebody — the Bcc row is already open
    // (no toggle stands between the head press and a blind copy).
    await typeRecipient("To", "extra@example.test");
    await typeRecipient("Bcc", "blind@example.test");

    const editor = host!.querySelector<HTMLElement>(".read-col .msg .rte-surface")!;
    await act(async () => { typeInto(editor, "Donnerstag passt."); });
    await act(async () => { sendButton().click(); });
    await settle();

    const sends = seen.filter((m) => m.kind === "mail_send");
    expect(sends, "the send never reached the adapter").toHaveLength(1);
    const payload = sends[0]! as { to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] };
    // The edited audience IS the wire: the prefilled recipient survived, the added one rides
    // beside it, and the typed Bcc reaches the mutation the adapter serialises — from here the
    // existing plumbing carries it to the SMTP envelope and never into a header
    // (`packages/core/test/outbound-cc-bcc.test.ts`).
    expect(payload.to?.map((a) => a.address)).toEqual([
      parseRecipients(prefilled).addresses[0]!.address,
      "extra@example.test",
    ]);
    expect(payload.bcc?.map((a) => a.address)).toEqual(["blind@example.test"]);
    expect("cc" in payload).toBe(false);
  });

  it("the edit dies with the editor — reopening computes the audience afresh", async () => {
    await mountShell();
    await act(async () => { reply().querySelector<HTMLButtonElement>(".reply-head-btn")!.click(); });
    await typeRecipient("To", "extra@example.test");

    await key("Escape");
    await key("r");

    // A fresh head, not the abandoned edit: an envelope edited for one reply must never
    // address the next one.
    expect(reply().querySelector(".reply-head-btn"), "the editor reopened without its head").not.toBeNull();
    expect(reply().querySelector(".reply-rcpt")).toBeNull();
  });
});
