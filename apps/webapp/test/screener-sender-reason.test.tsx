/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine, MemoryMirrorStore, senderKey, consentPartition, presentationReader,
  type EngineMessage, type Folder, type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import { REASON_CODES, toSuggestion } from "../app/shell/screener-suggest.js";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * **THE ROW SAYS WHAT OHMAIL CHECKED ABOUT THE SENDER.**
 *
 * A suggestion the server bounded on a fact of its own — the sending address against the company
 * the mail names, one subject from a crowd of strangers, a failed authentication — renders the
 * fact, in the reader's own language. The wire carries a CODE and two facts of ohmail's own (a
 * brand out of the curated dictionary, a count the server measured); it never carries a sentence,
 * so nothing a sender wrote can reach the screen through this path.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

function held(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

async function engineWith(mail: EngineMessage[], extra: SyncChange[] = []): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...mail.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    ...extra,
  ]);
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

const FORGED = "info@domain-renewals-ch.example";
const CLEAN = "anna@studio-nord.example";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/** Mount the REAL Screener over the REAL state hook, with one bounded suggestion in the overlay. */
async function mount(
  locale: "en" | "de" = "en",
  mail: EngineMessage[] = [held("m0", FORGED, 9), held("m1", CLEAN, 10)],
  extra: SyncChange[] = [],
  advised = true,
  presented = false,
): Promise<void> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  const engine = await engineWith(mail, extra);

  // Through `toSuggestion`, so the WIRE shape is what is under test and not a hand-built object.
  const suggestions = new Map<string, unknown>(advised ? [
    [senderKey(FORGED), toSuggestion({
      decision: "no", destination: "ohmail/Quarantine", confidence: 0.95,
      rationale: "", reasonCode: "impersonation", reasonBrand: "Metanet",
    })],
    [senderKey(CLEAN), toSuggestion({
      decision: "yes", destination: "INBOX", confidence: 0.92, rationale: "a real person writing",
    })],
  ] : []);

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const raw = engine.read();
    const state = useScreenerState(engine, v, (() => {}) as never, suggestions as never,
      presented ? presentationReader(raw, consentPartition(raw, { now: NOW })) : undefined);
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    return h(ScreenerView, {
      owed: false,
      state,
      segment: "waiting", settled: true, selection: sel as never,
      onSelect: (s: string, id: string | null) => setSel((m) => ({ ...m, [s]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: locale === "de" ? de : en, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  await flush();
  await settleFirstPaint();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

/** Select the bounded sender's row so the pane beside it describes that sender. */
async function open(address: string): Promise<void> {
  const row = [...host!.querySelectorAll<HTMLElement>(".rows .row")]
    .find((r) => (r.textContent ?? "").includes(address));
  if (!row) throw new Error(`no row for ${address}`);
  await act(async () => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

describe("the reason on the row", () => {
  it("names the company the address does not belong to, and the pill reads Spam", async () => {
    await mount();
    const row = [...host!.querySelectorAll<HTMLElement>(".rows .row")]
      .find((r) => (r.textContent ?? "").includes(FORGED))!;
    expect(row.textContent).toContain("Not Metanet");
    expect(row.textContent).toContain("Spam");
    // …and the row a fact said nothing about is untouched.
    const clean = [...host!.querySelectorAll<HTMLElement>(".rows .row")]
      .find((r) => (r.textContent ?? "").includes(CLEAN))!;
    expect(clean.textContent).not.toContain("Not Metanet");
  });

  it("says the whole sentence beside the sender, above the model's own", async () => {
    await mount();
    await open(FORGED);
    const why = host!.querySelector(".scn-why-checked");
    expect(why?.getAttribute("data-reason")).toBe("impersonation");
    expect(why?.textContent).toBe("The sender's address is not Metanet's");
  });

  it("says it in German on a German surface — the wire carries no sentence", async () => {
    await mount("de");
    await open(FORGED);
    expect(host!.querySelector(".scn-why-checked")?.textContent)
      .toBe("Die Absenderadresse gehört nicht zu Metanet");
  });

  it("says nothing at all for a suggestion no fact bounded", async () => {
    await mount();
    await open(CLEAN);
    expect(host!.querySelector(".scn-why-checked")).toBeNull();
  });
});

describe("the closed set and its words", () => {
  it("every code has a sentence and a chip in both catalogues, and nothing else does", async () => {
    for (const [name, cat] of [["en", en], ["de", de]] as const) {
      const ns = cat.screener as unknown as Record<string, Record<string, string>>;
      expect(Object.keys(ns.aiReason ?? {}).sort(), name).toEqual([...REASON_CODES].sort());
      expect(Object.keys(ns.aiReasonChip ?? {}).sort(), name).toEqual([...REASON_CODES].sort());
    }
  });

  it("drops a code it does not know rather than printing the token", () => {
    const out = toSuggestion({
      decision: "no", destination: "ohmail/Quarantine", confidence: 0.9, rationale: "",
      reasonCode: "a_reason_from_a_newer_server",
    });
    expect("reasonCode" in out).toBe(false);
  });

  it("carries the code and both of ohmail's own facts, and nothing else", () => {
    expect(toSuggestion({
      decision: "no", destination: "ohmail/Quarantine", confidence: 0.9, rationale: "",
      reasonCode: "campaign", reasonCount: 2,
    })).toEqual({ dest: "spam", confidence: 0.9, rationale: "", reasonCode: "campaign", reasonCount: 2 });
  });
});

/* ══ THE IDENTITY FACT ON THE ROW (mail 0148, acceptance 16) ══ The sentence is ohmail's own and
   renders whether or not a suggestion was ever bought: here no suggestion exists at all. */
describe("the identity fact, outside the AI advice", () => {
  const PHISH = personalAt("fixture.mila", "gmail.com");
  const marked = (id: string, from: string, shared: boolean): EngineMessage => ({
    ...held(id, from, 11), from: { name: "PostFinance", address: from },
    senderCheck: { reason: "impersonation", brand: "PostFinance", domainShared: shared },
  });

  it("renders the shared-provider sentence for a marked sender with no suggestion bought", async () => {
    await mount("en", [marked("p0", PHISH, true), held("m1", CLEAN, 10)], [], false);
    await open(PHISH);
    const line = host!.querySelector('.scn-why-checked[data-reason="identity"]');
    expect(line?.textContent).toBe("This message claims to be from PostFinance, but anyone can register a gmail.com address.");
    expect(host!.querySelector(".scn-why-checked:not([data-reason='identity']):not([data-reason='shared-provider'])")).toBeNull();
    // The sender's row carries the chip, its sentence as the title.
    const chip = host!.querySelector(".bdg-check");
    expect(chip?.textContent).toBe("Not PostFinance");
    expect(chip?.getAttribute("title")).toBe("This message claims to be from PostFinance, but anyone can register a gmail.com address.");
  });

  it("says the other sentence for an address that is no shared provider's, in German too", async () => {
    await mount("de", [marked("p1", "kunden@postfinance-sicherheit.example", false)], [], false);
    await open("kunden@postfinance-sicherheit.example");
    expect(host!.querySelector('.scn-why-checked[data-reason="identity"]')?.textContent)
      .toBe("Diese Nachricht gibt sich als PostFinance aus, aber postfinance-sicherheit.example ist keine Adresse von PostFinance.");
  });

  /* A LIST ADDRESS (mail 0150): the mirrored fact says a mailing list posts as it, and the row says
     why one press will not open it to every name — beneath the identity line, in both languages. */
  const listed = (id: string, from: string): EngineMessage => ({
    ...held(id, from, 11), from: { name: "PostFinance", address: from },
    senderCheck: { reason: "impersonation", brand: "PostFinance", domainShared: false, list: true },
  });

  it("a claim under a list address carries the list sentence beneath the identity line", async () => {
    await mount("en", [listed("l0", "list@lists.example")], [], false);
    await open("list@lists.example");
    const lines = [...host!.querySelectorAll(".scn-why-lines .scn-why-checked")].map((e) => e.getAttribute("data-reason"));
    expect(lines).toEqual(["identity", "list"]);
    expect(host!.querySelector('.scn-why-checked[data-reason="list"]')?.textContent)
      .toBe("Sent through a mailing list — anyone on it can write as this address.");
  });

  it("says it in German too", async () => {
    await mount("de", [listed("l1", "list@lists.example")], [], false);
    await open("list@lists.example");
    expect(host!.querySelector('.scn-why-checked[data-reason="list"]')?.textContent)
      .toBe("Über eine Mailingliste verschickt — alle auf der Liste können unter dieser Adresse schreiben.");
  });

  it("CONTROL: a marked sender that is no list address has no list line", async () => {
    await mount("en", [marked("p2", "kunden@postfinance-sicherheit.example", false)], [], false);
    await open("kunden@postfinance-sicherheit.example");
    expect(host!.querySelector('[data-reason="identity"]')).not.toBeNull();
    expect(host!.querySelector('[data-reason="list"]')).toBeNull();
  });

  it("CONTROL: an unmarked sender has no identity line", async () => {
    await mount("en", [held("m1", CLEAN, 10)], [], false);
    await open(CLEAN);
    expect(host!.querySelector('[data-reason="identity"]')).toBeNull();
    expect(host!.querySelector(".bdg-check")).toBeNull();
  });

  /* AN UNCONFIRMED SENDER AT A BRAND'S OWN DOMAIN: the row says the provider did not confirm it, and
     draws no chip, since the address is the brand's. */
  const unconfirmed = (id: string): EngineMessage => ({
    ...held(id, "service@paypal.com", 11), from: { name: "PayPal", address: "service@paypal.com" },
    senderCheck: { reason: "unverified", brand: "PayPal", domainShared: false },
  });

  it("an unconfirmed brand sender's row says so, with no chip", async () => {
    await mount("en", [unconfirmed("v0"), held("m1", CLEAN, 10)], [], false);
    await open("service@paypal.com");
    expect(host!.querySelector('.scn-why-checked[data-reason="unverified"]')?.textContent)
      .toBe("This message says it is from PayPal. Your mail provider did not confirm that.");
    expect(host!.querySelector('[data-reason="identity"]')).toBeNull();
    expect(host!.querySelector(".bdg-check")).toBeNull();
  });

  it("says it in German too", async () => {
    await mount("de", [unconfirmed("v1")], [], false);
    await open("service@paypal.com");
    expect(host!.querySelector('.scn-why-checked[data-reason="unverified"]')?.textContent)
      .toBe("Diese Nachricht gibt an, von PayPal zu kommen. Dein Mailanbieter hat das nicht bestätigt.");
  });

  it("says why an allow rule for everyone at gmail.com did not let the stranger through", async () => {
    const rule = {
      type: "rule", op: "create", id: "rule-gmail", seq: ++seq, updatedAt: "2026-08-02T09:00:00.000Z",
      entity: {
        id: "rule-gmail", kind: "domain", match: "gmail.com", destination: "INBOX", enabled: true, priority: 0,
        provenance: "manual", createdAt: "2026-08-01T09:00:00.000Z", subjectContains: null, bodyContains: null,
      },
    } as unknown as SyncChange;
    await mount("en", [held("g0", personalAt("fixture.nadja", "gmail.com"), 10)], [rule], false);
    await open(personalAt("fixture.nadja", "gmail.com"));
    expect(host!.querySelector('[data-reason="shared-provider"]')?.textContent)
      .toBe("Everyone at gmail.com: a shared provider, so this rule admits nobody. Decide per address.");
    expect(host!.querySelector('[data-reason="identity"]')).toBeNull();
  });
});

/* ══ THE HELD CAPTION NAMES A FIRST CONTACT ONLY WHEN IT IS ONE (R32-03) ══ A list address the person
   allowed to the Ohbox, two claims under another name held: its letters past the gate make it no
   first contact, here as on the phone's sheet. The control has nothing past the gate. */
describe("the held caption names a first contact only when it is one", () => {
  const LISTED = "list@lists.example";
  const claim = (id: string, hour: number): EngineMessage => ({
    ...held(id, LISTED, hour), from: { name: "PayPal Service", address: LISTED },
    senderCheck: { reason: "impersonation", brand: "PayPal", domainShared: false, list: true },
  });
  const allowed = {
    type: "rule", op: "create", id: "rule-list", seq: ++seq, updatedAt: "2026-08-02T08:00:00.000Z",
    entity: {
      id: "rule-list", kind: "sender", match: LISTED, destination: "INBOX", enabled: true, priority: 0,
      provenance: "manual", createdAt: "2026-08-02T08:00:00.000Z", subjectContains: null, bodyContains: null,
    },
  } as unknown as SyncChange;
  const captionText = () => [...host!.querySelectorAll(".scn-caption")].map((e) => e.textContent ?? "")
    .find((s) => /messages? —/.test(s));

  it("R32-03: claims held under an address whose letters the person's rule filed in the Ohbox", async () => {
    await mount("en", [held("in0", LISTED, 6, "INBOX"), held("in1", LISTED, 7, "INBOX"), claim("c0", 9), claim("c1", 10)], [allowed], false);
    await open(LISTED);
    expect(captionText()).toBe("2 messages — all shown");
  });

  it("CONTROL: two letters held and nothing past the gate is a first contact, at the oldest", async () => {
    await mount("en", [claim("c2", 9), claim("c3", 10)], [], false);
    await open(LISTED);
    const oldest = host!.querySelector(".hmail .t")?.textContent ?? "NO HELD LETTER";
    expect(captionText()).toBe(`2 messages — all shown · first contact ${oldest}`);
  });

  /* An undecided sender's letter still in the server's Inbox is listed on the card and moved by the
     decision, but it is not held: the count says what the card lists, not "held". */
  it.each([
    ["en", "2 messages — all shown · first contact", "2 messages"],
    ["de", "2 Nachrichten — alle gezeigt · erster Kontakt", "2 Nachrichten"],
  ] as const)("%s: a letter still in the Inbox is counted as a message, never as held", async (locale, caption, chip) => {
    const STRANGER = "new@stranger.example";
    await mount(locale, [held("s0", STRANGER, 9), held("i0", STRANGER, 10, "INBOX")], [], false, true);
    await open(STRANGER);
    expect(host!.querySelectorAll(".hmail")).toHaveLength(2);
    const oldest = host!.querySelector(".hmail .t")?.textContent ?? "NO LETTER";
    expect([...host!.querySelectorAll(".scn-caption")].map((e) => e.textContent)).toContain(`${caption} ${oldest}`);
    const row = [...host!.querySelectorAll<HTMLElement>(".rows .row")].find((r) => r.textContent!.includes(STRANGER))!;
    expect([...row.querySelectorAll(".badge")].map((b) => b.textContent)).toContain(chip);
    expect(row.getAttribute("aria-description")).toMatch(new RegExp(`· ${chip}$`));
  });
});

describe("the new keys are du-form German, and only du-form", () => {
  const ADDED = [
    ["screener", "senderCheck", "impersonation"], ["screener", "senderCheck", "impersonationShared"],
    ["screener", "senderCheck", "chip"], ["screening", "scopeShared"], ["rules", "sharedProviderInert"],
    ["screener", "senderCheck", "list"], ["screener", "senderCheck", "unverified"],
  ] as const;
  const SIE = /\b(Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)\b/;
  const at = (cat: unknown, path: readonly string[]): string =>
    path.reduce((o: unknown, k) => (o as Record<string, unknown>)[k], cat) as string;

  it("no added German key addresses the reader as Sie", () => {
    const sie = ADDED.filter((p) => SIE.test(at(de, p)));
    expect(sie).toEqual([]);
    // Every added key exists in both catalogues.
    for (const p of ADDED) { expect(typeof at(en, p)).toBe("string"); expect(typeof at(de, p)).toBe("string"); }
  });

  it("CONTROL: the census reads a planted Sie-form sentence", () => {
    expect(SIE.test("Entscheiden Sie hier pro Adresse.")).toBe(true);
    expect(SIE.test("Entscheide hier pro Adresse.")).toBe(false);
  });
});
