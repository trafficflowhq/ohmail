/** @vitest-environment jsdom */
import type { EngineMessage, Folder, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import * as React from "react";
import { within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { REASON_CODES, toSuggestion } from "@ohmail/app-logic/screener/screener-suggest";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

/**
 * **THE ROW SAYS WHAT OHMAIL CHECKED ABOUT THE SENDER.**
 *
 * A suggestion the server bounded on a fact of its own — the sending address against the company
 * the mail names, one subject from a crowd of strangers, a failed authentication — renders the
 * fact, in the reader's own language. The wire carries a CODE and two facts of ohmail's own (a
 * brand out of the curated dictionary, a count the server measured); it never carries a sentence,
 * so nothing a sender wrote can reach the screen through this path.
 */

type Change = SyncResponse["changes"]["creates"][number];
let seq = 0;

function held(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `${ISO.slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

const FORGED = "info@domain-renewals-ch.example";
const CLEAN = "anna@studio-nord.example";

let host: HTMLElement | null = null;
let mounted = false;
let addressesById = new Map<string, string>();
let writes: { path: string; body: unknown }[] = [];

beforeAll(warmCloudShell);
afterEach(async () => {
  if (mounted) await teardownConfirmEnv();
  mounted = false;
  host = null;
  window.localStorage.clear();
});

async function click(button: HTMLElement): Promise<void> {
  await act(async () => { button.click(); });
  await tick(50);
}

/** The same sync and stored-advice reads the Web entry uses. */
async function mount(
  locale: "en" | "de" = "en",
  mail: EngineMessage[] = [held("m0", FORGED, 9), held("m1", CLEAN, 10)],
  extra: Change[] = [],
  advised = true,
  claimsOnly: readonly string[] = [],
): Promise<void> {
  installConfirmEnv();
  mounted = true;
  window.localStorage.clear();
  addressesById = new Map(mail.map(({ id, from }) => [id, from.address]));
  writes = [];
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
  const creates: Change[] = [
    ...mail.map((entity): Change => ({ type: "message", op: "create", id: entity.id, seq: 0, updatedAt: ISO, entity })),
    ...extra,
  ].map((change, index) => ({ ...change, seq: index + 1 }));
  scriptSync(() => Response.json({
    changes: { creates, updates: [], moves: [], deletes: [] },
    cursor: String(creates.length), hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const { pathname: path } = new URL(String(input), window.location.origin);
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb_1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    if (method === "GET" && path === "/api/screener" && (advised || claimsOnly.length > 0)) {
      const items = mail.filter((item) => item.folder === "ohmail/Screener").map((item) => ({
        id: item.id, messageId: item.id, mailboxId: item.mailboxId, sender: item.from,
        subject: item.subject, snippet: item.snippet, receivedAt: item.date, updatedAt: ISO,
        ...(item.senderCheck && { checked: { ...item.senderCheck, claimsOnly: claimsOnly.includes(item.from.address) } }),
        aiSuggestion: !advised ? null : item.from.address === FORGED ? {
          decision: "no", destination: "ohmail/Quarantine", confidence: 0.95,
          rationale: "", reasonCode: "impersonation", reasonBrand: "Metanet",
        } : {
          decision: "yes", destination: "INBOX", confidence: 0.92, rationale: "a real person writing",
        },
      }));
      return Response.json({ items, nextCursor: null, total: items.length, suggestable: { senders: [], maxPerRequest: 50 } });
    }
    if (method === "GET" && path.endsWith("/body")) return new Response(null, { status: 503 });
    if (method !== "GET" && /^\/api\/(rules|messages|screener)(?:\/|$)/.test(path)) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      writes.push({ path, body });
      return Response.json({ messageId: path.split("/").at(-1), appliedFolder: body?.dest, createdRuleId: null });
    }
    return fixture(input, init);
  };
  const catalogue = locale === "en" ? en : de;
  window.location.hash = advised ? "#/ohbox" : "#/screener";
  host = await mountCloudShell((shell) => React.createElement(NextIntlClientProvider, {
    locale, messages: catalogue, timeZone: "UTC", now: new Date(ISO), children: shell,
  }));
  await tick(3000);
  if (advised) {
    const rail = within(host).getByRole("navigation", { name: catalogue.frame.landmark.places });
    await click(within(rail).getByRole("button", { name: /^Screener/ }));
    await tick(1000);
  }
}

const screen = () => within(host!);
const reading = () => within(screen().getByRole("region", { name: /^(Reading|Lesen)$/ }));
function rowOf(address: string): HTMLElement {
  const row = screen().getAllByRole("option").find((node) => addressesById.get(node.dataset.id ?? "") === address);
  expect(row, "the sender has a Screener row").toBeTruthy();
  return row!;
}

async function open(address: string): Promise<void> {
  await click(rowOf(address));
}

describe("the reason on the row", () => {
  it("names the company the address does not belong to, and the pill reads Spam", async () => {
    await mount();
    const row = rowOf(FORGED);
    expect(row.textContent).toContain("Not Metanet");
    expect(within(row.parentElement!).getByRole("button", { name: en.screener.place.unsub.spam })).toBeTruthy();
    // …and the row a fact said nothing about is untouched.
    const clean = rowOf(CLEAN);
    expect(clean.textContent).not.toContain("Not Metanet");
  });

  it("says the whole sentence beside the sender, above the model's own", async () => {
    await mount();
    await open(FORGED);
    expect(reading().getByText("The sender's address is not Metanet's")).toBeTruthy();
  });

  it("says it in German on a German surface — the wire carries no sentence", async () => {
    await mount("de");
    await open(FORGED);
    expect(reading().getByText("Die Absenderadresse gehört nicht zu Metanet")).toBeTruthy();
  });

  it("says nothing at all for a suggestion no fact bounded", async () => {
    await mount();
    await open(CLEAN);
    expect(reading().getByText(/a real person writing/)).toBeTruthy();
    expect(reading().queryByText(/Metanet/)).toBeNull();
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
    const sentence = "This message claims to be from PostFinance, but anyone can register a gmail.com address.";
    expect(reading().getByText(sentence)).toBeTruthy();
    expect(reading().queryByText(/AI suggests/)).toBeNull();
    const row = within(rowOf(PHISH));
    expect(row.getByText("Not PostFinance")).toBeTruthy();
    expect(row.getByRole("img", { name: en.screener.place.lookalike })).toBeTruthy();
    expect(rowOf(PHISH).getAttribute("aria-description")).toContain(sentence);
  });

  it("says the other sentence for an address that is no shared provider's, in German too", async () => {
    await mount("de", [marked("p1", "kunden@postfinance-sicherheit.example", false)], [], false);
    await open("kunden@postfinance-sicherheit.example");
    expect(reading().getByText(
      "Diese Nachricht gibt sich als PostFinance aus, aber postfinance-sicherheit.example ist keine Adresse von PostFinance.",
    )).toBeTruthy();
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
    const identity = reading().getByText(/This message claims to be from PostFinance/);
    const list = reading().getByText("Sent through a mailing list — anyone on it can write as this address.");
    expect(identity.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says it in German too", async () => {
    await mount("de", [listed("l1", "list@lists.example")], [], false, ["list@lists.example"]);
    await open("list@lists.example");
    expect(reading().getByText("Über eine Mailingliste verschickt — alle auf der Liste können unter dieser Adresse schreiben.")).toBeTruthy();
    expect(reading().getByText(
      "Beim Aussortieren oder Markieren als Spam werden nur die Nachrichten beiseitegelegt, die vorgeben, von PostFinance zu sein. Es wird keine Regel erstellt.",
    )).toBeTruthy();
    expect(reading().queryByText(/^Wird zur Regel/)).toBeNull();
    expect(reading().getByText(/Ohbox, News und Belege werden zur Regel.*Aussortieren und Spam schreiben hier keine Regel/)).toBeTruthy();
    const panel = screen().getByRole("toolbar", { name: de.screener.place.panel });
    await click(within(panel).getByRole("button", { name: /^Aussortieren/ }));
    expect(within(document.body).queryByRole("dialog", { name: de.screener.place.unsub.screened })).toBeNull();
    const reports = [...host!.querySelectorAll('.fr-report [role="status"]')].map((node) => node.textContent ?? "");
    const address = addressesById.get("l1");
    expect(reports.join(" ")).toContain(
      `Aussortiert — nur die Nachrichten von ${address}, die sich als PostFinance ausgeben. `
      + "Es wurde keine Regel erstellt, die übrigen Mails der Liste bleiben, wo sie sind.",
    );
    expect(writes).toEqual([]);
    await tick(COMMIT_MS + 800);
    expect(writes).toEqual([{
      path: "/api/screener/l1", body: { decision: "no", dest: "ohmail/Screened", scope: "sender", applyRetro: false },
    }]);
  });

  it("CONTROL: a marked sender that is no list address has no list line", async () => {
    await mount("en", [marked("p2", "kunden@postfinance-sicherheit.example", false)], [], false);
    await open("kunden@postfinance-sicherheit.example");
    expect(reading().getByText(/This message claims to be from PostFinance/)).toBeTruthy();
    expect(reading().queryByText(/Sent through a mailing list/)).toBeNull();
    expect(reading().queryByText(/Screen out files only/)).toBeNull();
  });

  it("CONTROL: an unmarked sender has no identity line", async () => {
    await mount("en", [held("m1", CLEAN, 10)], [], false);
    await open(CLEAN);
    expect(reading().queryByText(/This message claims to be from/)).toBeNull();
    expect(screen().queryByText(/^Not (PostFinance|PayPal)$/)).toBeNull();
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
    expect(reading().getByText("This message says it is from PayPal. Your mail provider did not confirm that.")).toBeTruthy();
    expect(reading().queryByText(/This message claims to be from/)).toBeNull();
    expect(screen().queryByText(/^Not (PostFinance|PayPal)$/)).toBeNull();
  });

  it("says it in German too", async () => {
    await mount("de", [unconfirmed("v1")], [], false);
    await open("service@paypal.com");
    expect(reading().getByText("Diese Nachricht gibt an, von PayPal zu kommen. Dein Mailanbieter hat das nicht bestätigt.")).toBeTruthy();
  });

  it("says why an allow rule for everyone at gmail.com did not let the stranger through", async () => {
    const rule = {
      type: "rule", op: "create", id: "rule-gmail", seq: ++seq, updatedAt: "2026-08-02T09:00:00.000Z",
      entity: {
        id: "rule-gmail", kind: "domain", match: "gmail.com", destination: "INBOX", enabled: true, priority: 0,
        provenance: "manual", createdAt: "2026-08-01T09:00:00.000Z", subjectContains: null, bodyContains: null,
      },
    } as Change;
    await mount("en", [held("g0", personalAt("fixture.nadja", "gmail.com"), 10)], [rule], false);
    await open(personalAt("fixture.nadja", "gmail.com"));
    expect(reading().getByText("Everyone at gmail.com: a shared provider, so this rule admits nobody. Decide per address.")).toBeTruthy();
    expect(reading().queryByText(/This message claims to be from/)).toBeNull();
  });
});

describe("the sender card lists the mail covered by the decision", () => {
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
  } as Change;
  it("shows the two held claims and leaves the already filed mail out of the sender card", async () => {
    await mount("en", [held("in0", LISTED, 6, "INBOX"), held("in1", LISTED, 7, "INBOX"), claim("c0", 9), claim("c1", 10)], [allowed], false);
    await open(LISTED);
    expect(reading().getByRole("heading", { name: "Subject c0" })).toBeTruthy();
    expect(reading().getByRole("heading", { name: "Subject c1" })).toBeTruthy();
    expect(reading().queryByRole("heading", { name: /Subject in[01]/ })).toBeNull();
  });

  it("shows both letters from a sender whose mail is all still at the gate", async () => {
    await mount("en", [claim("c2", 9), claim("c3", 10)], [], false);
    await open(LISTED);
    const oldest = reading().getByRole("heading", { name: "Subject c2" });
    const newer = reading().getByRole("heading", { name: "Subject c3" });
    expect(oldest.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ["en", "2 messages", "2 held", "Unread"],
    ["de", "2 Nachrichten", "2 zurückgehalten", "Ungelesen"],
  ] as const)("%s: a letter still in the Inbox is counted as a message, never as held", async (locale, chip, heldLabel, readState) => {
    const stranger = [locale, "unknown.example"].join("@");
    await mount(locale, [held("s0", stranger, 9), held("i0", stranger, 10, "INBOX")], [], false);
    await open(stranger);
    expect(reading().getByRole("heading", { name: "Subject s0" })).toBeTruthy();
    expect(reading().getByRole("heading", { name: "Subject i0" })).toBeTruthy();
    const row = rowOf(stranger);
    expect(row.textContent).toContain(chip);
    expect(row.textContent).not.toContain(heldLabel);
    expect(row.getAttribute("aria-description")).toBe(`${readState} · ${chip}`);
    expect(reading().getByText(chip)).toBeTruthy();
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
