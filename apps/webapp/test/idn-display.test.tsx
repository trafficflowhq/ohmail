/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { domainToASCII, domainToUnicode } from "node:url";
import { OhmailEngine, type EngineMessage, type EngineMutation, type MutationResult } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";
import type { MailboxFacts } from "../app/shell/mail-state";
import { displayAddress, displayDomain } from "../app/shell/idn";
import { recipientRows, rowAddress, senderName, sentRowRecipient } from "../app/shell/format";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * AN INTERNATIONALIZED DOMAIN, AS ITS OWNER WROTE IT.
 *
 * A mailbox on an IDN is stored and transported in its A-label form — `xn--mller-kva.example` —
 * because DNS, SMTP envelopes and IMAP accept nothing else. Every surface printed that form
 * verbatim: the compose From selector, the list rows, Settings → Mailboxes. The person whose
 * address it is could not recognise it.
 *
 * The fix is one display helper (`app/shell/idn.ts`) applied at render sites. So this file has two
 * halves, and the second is the one that matters:
 *
 *  · **The decoder**, pinned against `node:url`'s own `domainToUnicode` rather than against
 *    hand-written expectations — the reference implementation is available in Node and absent in
 *    the browser, which is the entire reason the decoder exists.
 *  · **The seams**, RENDERED: the From selector, a stream row and the Settings row, mounted from
 *    the shipped components. And the invariant in the other direction — the mutation a send
 *    dispatches must carry the STORED form, byte for byte. A helper that decoded one layer too
 *    early would pass every unit test above and corrupt an envelope.
 */

// A domain nobody owns, in the shape the report was about: `müller.example`.
const ACE = "xn--mller-kva.example";
const UNI = "müller.example";
const STORED = `sarada@${ACE}`;
const SHOWN = `sarada@${UNI}`;

/** The verb's LABEL, without the keycap the button also wears (`<Key chord>` / the send
 * chord's cap print the registry's key into the button, so textContent grew a suffix). */
const buttonLabel = (b: HTMLElement): string => {
  const kbd = b.querySelector("kbd")?.textContent ?? "";
  return (b.textContent ?? "").replace(kbd, "").trim();
};

describe("the decoder agrees with the platform's own ToUnicode", () => {
  // Built by encoding, so the corpus is exactly what a real mailbox could carry.
  const corpus = [
    "müller.example",
    "töpferei.example",
    "bücher.de",
    "日本語.jp",
    "ünïcödé.example",
    "παράδειγμα.δοκιμή",
    "пример.испытание",
    "mixed-ascii.müller.example",
    "xn--already-ascii.example",
    "plain.example.com",
  ];

  for (const unicode of corpus) {
    it(`decodes ${unicode}`, () => {
      const ace = domainToASCII(unicode);
      if (ace === "") return; // the platform refused it; nothing to compare against
      expect(displayDomain(ace)).toBe(domainToUnicode(ace));
    });
  }
});

describe("what the decode does NOT touch", () => {
  it("hands an ASCII address back byte-identical, and as the very same string", () => {
    for (const a of ["someone@example.test", "a.b+c@sub.domain.example.com", "root@localhost"]) {
      expect(displayAddress(a)).toBe(a);
      // Identity, not equality: nothing is rebuilt for the overwhelmingly common case.
      expect(Object.is(displayAddress(a), a)).toBe(true);
    }
  });

  it("leaves the LOCAL PART alone even when it looks like an A-label", () => {
    // The local part has no encoded form to undo — SMTPUTF8 carries UTF-8 as-is — so a local part
    // that happens to read `xn--…` is somebody's actual mailbox name, not something to rewrite.
    expect(displayAddress(`xn--mller-kva@${ACE}`)).toBe(`xn--mller-kva@${UNI}`);
  });

  it("takes the domain from the LAST @, so a quoted local part cannot move it", () => {
    expect(displayAddress(`"odd@name"@${ACE}`)).toBe(`"odd@name"@${UNI}`);
  });

  it("passes through anything with no @ at all", () => {
    expect(displayAddress(ACE)).toBe(ACE);
    expect(displayAddress("")).toBe("");
  });
});

describe("a malformed A-label falls back to the raw form, and never throws", () => {
  const garbage = [
    "xn--",
    "xn---",
    "xn--.example",
    "xn--!!!!.example",
    "xn--a b.example",
    "xn--zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.example",
    "xn--0000000000000000000000000000.example",
    // A raw NUL inside a label, written as an escape: the point is that nothing here throws
    // and nothing reaches the screen, and a literal NUL in a source file breaks `grep`.
    "xn--a-ecp\u0000.ru",
  ];
  for (const domain of garbage) {
    it(`shows ${JSON.stringify(domain)} raw`, () => {
      expect(() => displayDomain(domain)).not.toThrow();
      expect(displayDomain(domain)).toBe(domain);
    });
  }

  it("refuses a label that decodes to pure ASCII — `xn--a.b-` is two labels wearing one mask", () => {
    // Split on "." happens first, so this is really the `xn--a` label; either way the answer is raw.
    expect(displayDomain("xn--a.b-")).toBe("xn--a.b-");
  });

  it("refuses a label whose Unicode form smuggles in a separator or a bidi override", () => {
    // FULLWIDTH FULL STOP, RIGHT-TO-LEFT OVERRIDE, ZERO WIDTH SPACE and IDEOGRAPHIC FULL STOP all
    // change what the address APPEARS to be, which is a different problem from a lookalike letter.
    // Written as escapes on purpose: a literal invisible character in a source file makes `file`
    // report it as data, after which plain `grep` silently skips the whole file (see CLAUDE.md).
    for (const cp of ["\uFF0E", "\u202E", "\u200B", "\u3002"]) {
      const forged = domainToASCII(`a${cp}b.example`);
      if (forged === "" || !forged.includes("xn--")) continue;
      expect(displayDomain(forged)).toBe(forged);
    }
  });
});

describe("the shared display helpers decode; the identity fields do not", () => {
  const msg = (over: Partial<EngineMessage>): EngineMessage =>
    ({
      id: "m", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
      subject: "s", from: { name: null, address: STORED }, to: [], cc: [],
      date: "2026-08-05T14:32:00.000Z", folder: "INBOX", snippet: "snip", unread: false, labels: [],
      ...over,
    }) as unknown as EngineMessage;

  it("senderName shows the readable address when there is no display name", () => {
    expect(senderName(msg({}))).toBe(SHOWN);
  });

  it("senderName leaves a display name exactly as the sender wrote it", () => {
    expect(senderName(msg({ from: { name: "Sarada", address: STORED } }))).toBe("Sarada");
  });

  it("rowAddress shows the readable address under the name", () => {
    expect(rowAddress(msg({ from: { name: "Sarada", address: STORED } }))).toBe(SHOWN);
  });

  it("recipientRows carries the STORED address — a chip's VALUE is the wire form, only its face decodes", () => {
    // The round trip a contact chip must survive (viewer): the face shows `sarada@müller…`
    // (`displayAddress`, at the render site — `contact-chips.test.tsx` renders it), while the
    // value every popover verb acts on — copy, write, screening — is this field, verbatim. A
    // helper that decoded here would pass every face assertion and corrupt every dispatch.
    const s = recipientRows(msg({ to: [{ name: null, address: STORED }] }), []);
    expect(s.to).toEqual([{ me: false, name: null, address: STORED }]);
    expect(s.to[0]!.address).not.toBe(SHOWN);
  });

  it("recipientRows still folds MY OWN address to me — the fold is on the STORED form", () => {
    // `ownAddresses` comes from `GET /mailboxes`, which answers A-labels. A fold done on the
    // decoded string would stop recognising the reader on their own IDN mailbox.
    const s = recipientRows(msg({ to: [{ name: null, address: STORED }] }), [STORED]);
    expect(s.to[0]!.me).toBe(true);
  });

  it("sentRowRecipient splits display from identity: a readable name, the stored address", () => {
    // `isOwnSent` asks whether the row's folder is the mailbox's Sent folder, and a real Sent row
    // carries a server folder outside the `Folder` union — `client-engine/src/mutations.ts:72`
    // names this exact case.
    const r = sentRowRecipient(
      msg({
        folder: "Sent" as unknown as EngineMessage["folder"],
        from: { name: null, address: "me@example.test" },
        to: [{ name: null, address: STORED }],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.name, "the row's label is what a human reads").toBe(SHOWN);
    expect(r!.address, "the hue key must stay the stored address, or one person gets two colours")
      .toBe(STORED);
  });
});

// ── RENDERED: the three surfaces the report named ───────────────────────────────────────

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let roots: Root[] = [];
let host: HTMLDivElement | null = null;
let dispatched: EngineMutation[] = [];
const REAL_MUTATE = OhmailEngine.prototype.mutate;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, blockedReason: null, mailboxCount: 1, settled: true,
} as unknown as MailState;

const listed: MailboxDTO[] = [];

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  // The Screener's refusal copy reads this constant to give an unreachable server its own
  // sentence; the value is asserted against the real export in `owner-marker-three-states`.
  OFFLINE_CODE: "network_unreachable",
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
  messageOf: (e: unknown) => String(e),
  auth: {
    session: async () => ({ user: { email: "owner@example.test", emailVerified: true }, scope: "full" }),
  },
  billing: {
    subscription: async () => ({
      subscription: {
        plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
        currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
      },
      balance: 0,
      plans: {},
      entitlements: {
        mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active",
      },
    }),
  },
  mailboxes: { list: async () => ({ items: listed }), create: async () => listed[0]!, resync: async () => undefined },
}));

/**
 * The mailbox facts, as `useMailState()` answers them.
 *
 * A holder rather than a `let` because the mock factory is hoisted above every declaration in this
 * file, and it must also carry `mailboxes` — `AppShell` reads its From options from
 * `useMailState().mailboxes` (`AppShell.tsx:666`, `:1604`) and falls back to the FIXTURE mailboxes
 * when that is null. A mock that returned only `state` therefore mounted a shell whose From line
 * offered `someone@example.test`, which looks exactly like a decode that did not happen.
 */
const seen: { facts: MailboxFacts[] | null } = { facts: null };

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, mailboxes: seen.facts, refresh: () => {} }),
  // `AppShell` mounts the provider itself, so the stub has to supply it as well as the hook —
  // the mock replaces the whole module, and a missing export is a render-time throw.
  MailStateProvider: ({ children }: { children?: unknown }) => children,
}));

beforeEach(() => {
  dispatched = [];
  seen.facts = null;
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the in-memory half still runs */ }
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
  vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(async function patched(
    this: OhmailEngine, m: EngineMutation,
  ): Promise<MutationResult> {
    dispatched.push(m);
    return REAL_MUTATE.call(this, m);
  });
});

afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

const fact = (over: Partial<MailboxFacts>): MailboxFacts => ({
  id: "mb1", address: STORED, status: "connected", createdAt: "2024-01-05T00:00:00.000Z",
  lastSyncAt: "2026-08-01T00:00:00.000Z", provider: "imap", displayName: null,
  ...over,
} as unknown as MailboxFacts);

/** The shipped shell on the fixture world over the facts a Cloud account would report. */
async function mountShell(facts: MailboxFacts[]): Promise<void> {
  seen.facts = facts;
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, {
            children: h(AppShell, { demo: true, mailboxFacts: async () => facts }),
          }),
        }),
      }),
    );
  });
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}

async function goCompose(): Promise<void> {
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

async function setValue(el: HTMLElement, proto: object, value: string, event: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

describe("ACCEPTANCE: the compose From selector", () => {
  it("names the mailbox the way its owner wrote it, not in punycode", async () => {
    await mountShell([fact({}), fact({ id: "mb2", address: "other@example.test", createdAt: "2025-03-02T00:00:00.000Z" })]);
    await goCompose();

    const control = host!.querySelector<HTMLElement>("#compose-from");
    expect(control, "compose rendered no From control at all").not.toBeNull();
    const texts = [...host!.querySelectorAll<HTMLOptionElement>("#compose-from option")].map((o) => o.textContent);
    expect(texts).toContain(SHOWN);
    expect(texts.join("|"), "the punycode form is still on screen").not.toContain("xn--");
  });

  it("states a single IDN mailbox readably, with no control to choose from", async () => {
    await mountShell([fact({})]);
    await goCompose();
    expect(host!.querySelector<HTMLElement>("#compose-from")!.textContent).toBe(SHOWN);
  });

  it("SENDS THE STORED FORM — the decode never reaches the wire", async () => {
    await mountShell([fact({})]);
    await goCompose();

    const to = host!.querySelector<HTMLInputElement>("#compose-to")!;
    // Typed exactly as a mailbox stores it: the recipient field's content IS the wire value and is
    // deliberately not decoded, so what the user typed is what leaves.
    await setValue(to, window.HTMLInputElement.prototype, `nora@${ACE}`, "input");
    await act(async () => { typeInto(host!.querySelector<HTMLElement>(".compose-editor .rte-surface")!, "Hallo."); });

    const send = [...host!.querySelectorAll<HTMLButtonElement>(".send-row button")]
      .find((b) => buttonLabel(b) === "Send")!;
    expect(send.disabled, "Send stayed locked with a recipient and a body").toBe(false);
    await act(async () => { send.click(); });

    const sent = dispatched.filter((m) => m.kind === "mail_send");
    expect(sent, "pressing Send dispatched no mutation").toHaveLength(1);
    const wire = JSON.stringify(sent[0]);
    expect(wire, "the A-label form is missing from the envelope").toContain(ACE);
    expect(wire, "a DISPLAY string reached the wire — the decode leaked past the render").not.toContain(UNI);
    // …while the screen said the readable thing at the same moment.
    expect(host!.textContent).toContain(UNI);
  });
});

describe("ACCEPTANCE: a list row", () => {
  it("prints the sender's readable address, and keeps the hue keyed on the stored one", async () => {
    const { StreamCardMemo } = await import("../app/shell/StreamCardMemo.js");
    const m = {
      id: "m1", accountId: "a", mailboxId: "mb1", threadId: null, messageIdHeader: null,
      subject: "Rechnung", from: { name: "Sarada", address: STORED }, to: [], cc: [],
      date: "2026-08-01T09:00:00.000Z", folder: "INBOX", snippet: "s", unread: false, labels: [],
    } as unknown as EngineMessage;

    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(StreamCardMemo, {
            m, now: new Date("2026-08-02T09:00:00.000Z"),
            current: false, expanded: false, viewer: true, unread: false,
            bodyText: "body", bodyState: "full" as const, bodyHtml: null, bodyLoadedRemote: false,
            loadingLabel: "…", failedLabel: "!", withheldKey: "withheld", onReask: () => {},
            onSelect: () => {}, onToggle: () => {},
          }),
        }),
      );
    });

    expect(host.querySelector(".addr")?.textContent).toBe(SHOWN);
    expect(host.textContent, "the punycode form is still on the row").not.toContain("xn--");
  });
});

describe("ACCEPTANCE: the Settings → Mailboxes row", () => {
  it("names the connected mailbox readably, in the row and in its hover title", async () => {
    listed.splice(0, listed.length, {
      id: "mb1", provider: "imap", address: STORED, displayName: null,
      status: "connected", lastSyncAt: "2026-08-01T00:00:00.000Z",
    } as MailboxDTO);
    const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

    const row = host.querySelector<HTMLElement>(".mbx-addr");
    expect(row, "the pane rendered no mailbox row").not.toBeNull();
    expect(row!.textContent).toBe(SHOWN);
    expect(row!.getAttribute("title")).toBe(SHOWN);
  });
});
