/** @vitest-environment jsdom */
import type { EngineMessage, Folder, MessageBodyWire, UnsubscribeHeaderState } from "@ohmail/wire";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import type { SyncChange } from "@ohmail/client-engine";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

// Exercise disclosure before a decision through the Web entry. Past-gate and claim-only
// decisions also check which writes reach the Web API after the Undo window.
interface Held {
  id: string;
  from: string;
  posture: UnsubscribeHeaderState;
  folder?: Folder;
  verdict?: EngineMessage["authVerdict"];
  check?: EngineMessage["senderCheck"];
}

let host: HTMLElement | null = null;
let mounting = false;
let writes: { path: string; body: unknown }[] = [];
let heldById = new Map<string, Held>();
const copy = messages.screener;

beforeAll(warmCloudShell, 30_000);
afterEach(async () => {
  if (mounting) await teardownConfirmEnv();
  mounting = false;
  host = null;
  vi.unstubAllGlobals();
});

function message(letter: Held): EngineMessage {
  return {
    id: letter.id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${letter.id}`, from: { name: null, address: letter.from }, to: [], cc: [],
    date: ISO, folder: letter.folder ?? "ohmail/Screener", snippet: `snippet ${letter.id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
    ...(letter.verdict === undefined ? {} : { authVerdict: letter.verdict }),
    ...(letter.check === undefined ? {} : { senderCheck: letter.check }),
  };
}

function bodyOf(id: string): MessageBodyWire | null {
  const posture = heldById.get(id)?.posture;
  if (posture === undefined) return null;
  return { text: "body", html: null, loadedRemoteContent: false, unsubscribe: posture, unsubscribeUrl: null };
}

async function mount(opts: {
  held: Held[]; width: 1280 | 390; suggestions?: Record<string, string>;
  claimsOnly?: readonly string[];
}): Promise<void> {
  installConfirmEnv();
  mounting = true;
  writes = [];
  heldById = new Map(opts.held.map((letter) => [letter.id, letter]));
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  vi.stubGlobal("innerWidth", opts.width);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];

  const creates = opts.held.flatMap((letter, index): SyncChange[] => [
    { type: "message", op: "create", id: letter.id, seq: index * 2 + 1, updatedAt: ISO, entity: message(letter) },
    {
      type: "message_body", op: "create", id: letter.id, seq: index * 2 + 2, updatedAt: ISO,
      entity: { ...bodyOf(letter.id), messageId: letter.id, state: "ready", withheld: null },
    },
  ]);
  let seq = creates.length;
  scriptSync(() => Response.json({
    changes: { creates, updates: [], moves: [], deletes: [] },
    cursor: String(creates.length), hasMore: false, serverTime: ISO,
  }));

  const reply = (body: unknown, status = 200, written = false) => Response.json(body, {
    status,
    headers: { "X-Ohmail-Account": ACCOUNT, ...(written ? { "X-Sync-Seq": String(++seq) } : {}) },
  });
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/messages/bodies") {
      const ids = url.searchParams.get("ids")?.split(",") ?? [];
      return reply({ items: ids.flatMap((id) => {
        const body = bodyOf(id);
        return body === null ? [] : [{ messageId: id, ...body }];
      }) });
    }
    const bodyId = /^\/api\/messages\/([^/]+)\/body$/.exec(path)?.[1];
    if (method === "GET" && bodyId !== undefined) {
      const body = bodyOf(bodyId);
      return body === null ? new Response(null, { status: 404 }) : reply(body);
    }
    if (method === "GET" && path === "/api/mailboxes") {
      return reply({ items: [{
        id: "mb_1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO, providerConfirms: true,
      }] });
    }
    if (method === "GET" && path === "/api/screener" && (opts.claimsOnly || opts.suggestions)) {
      const items = opts.held.map((letter) => {
        const destination = opts.suggestions?.[letter.from];
        return {
          id: letter.id, messageId: letter.id, mailboxId: "mb_1",
          sender: { name: null, address: letter.from }, subject: `Subject ${letter.id}`,
          snippet: "", receivedAt: ISO, updatedAt: ISO,
          ...(letter.check && { checked: { ...letter.check, claimsOnly: opts.claimsOnly?.includes(letter.from) === true } }),
          aiSuggestion: destination ? {
            decision: destination === "ohmail/Screened" ? "no" : "yes", destination,
            confidence: 0.9, rationale: "because",
          } : null,
        };
      });
      return reply({ items, nextCursor: null, total: items.length, suggestable: { senders: [], maxPerRequest: 50 } });
    }
    if (method !== "GET" && /^\/api\/(rules|messages|screener)(?:\/|$)/.test(path)) {
      const body = JSON.parse(String(init?.body ?? "null"));
      writes.push({ path, body });
      if (path === "/api/rules") {
        return reply({
          id: "rule-new", kind: body.kind, match: body.match, destination: body.destination,
          priority: 0, enabled: true, provenance: "manual", createdAt: ISO, updatedAt: ISO,
          stats: { hits: 0, lastHitAt: null, demotions: 0 },
        }, 201, true);
      }
      if (path.endsWith("/move")) return reply({ ...message(opts.held[0]!), folder: body.folder }, 200, true);
      return reply({ messageId: path.split("/").at(-1), appliedFolder: body.dest, createdRuleId: null }, 200, true);
    }
    return fixture(input, init);
  };
  window.location.hash = opts.suggestions ? "#/ohbox" : "#/screener";
  host = await mountCloudShell();
  await tick(3000);
  if (opts.suggestions) {
    const rail = within(screen().getByRole("navigation", { name: "Places" }));
    await click(rail.getByRole("button", { name: /^Screener/ }));
    await tick(1000);
  }
  expect(host.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe(opts.width === 390 ? "1" : "2");
  await click(rowOf(opts.held[0]!.from));
}

const screen = () => within(host!);
const page = () => within(document.body);
function rowOf(address: string): HTMLElement {
  const list = within(screen().getByRole("listbox", { name: copy.title }));
  const row = list.queryByRole("option", { name: (name) => name.startsWith(`${address}:`) });
  expect(row, "the sender is waiting in the Screener").toBeTruthy();
  return row!;
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => { el.click(); });
  await tick(50);
}

const cardLine = (): string | null => {
  const card = screen().queryByRole("region", { name: messages.frame.landmark.reading })
    ?? screen().queryByRole("dialog", { name: messages.frame.landmark.reading });
  return (card ? within(card) : screen()).queryByText(/^(Screen out and Spam also (?:send|ask to unsubscribe)|Where .* offers one-click unsubscribe)/)?.textContent ?? null;
};
const capsule = (label: RegExp) => within(screen().getByRole("toolbar", { name: copy.place.panel }))
  .getByRole("button", { name: label });
function report(): string {
  const status = host!.querySelector('.fr-report [role="status"]:not([data-leaving])');
  expect(status, "the filing decision is reported").toBeTruthy();
  const sentence = status!.cloneNode(true) as HTMLElement;
  sentence.querySelectorAll("button, kbd").forEach((node) => node.remove());
  return sentence.textContent ?? "";
}
async function screenOut(): Promise<void> {
  await click(capsule(/^Screen out/));
  const confirmation = page().queryByRole("dialog", { name: copy.place.unsub.screened });
  if (confirmation) {
    await click(within(confirmation).getByRole("button", {
      name: (name) => name === copy.place.unsub.screened || name === messages.screening.unsubCommitMaybe,
    }));
  }
}

async function expectScreenOutRequest(id: string): Promise<void> {
  expect(writes, "nothing is sent during Undo").toEqual([]);
  await tick(COMMIT_MS + 800);
  expect(writes).toEqual([{
    path: `/api/screener/${id}`,
    body: { decision: "no", dest: "ohmail/Screened", scope: "sender", applyRetro: false },
  }]);
}

const ONE_CLICK = "news@list.example";
const NO_OFFER = "person@plain.example";

describe.each([1280, 390] as const)("the Screener card at %i says the unsubscribe before the press", (width) => {
  it("a row past the gate takes the rule path, which asks nothing: no line, and no request named", async () => {
    await mount({ held: [{ id: "p1", from: ONE_CLICK, posture: "one_click", folder: "INBOX" }], width });
    expect(capsule(/^Screen out/), "premise: the card is on screen").toBeTruthy();
    expect(cardLine()).toBeNull();
    await screenOut();
    await tick(COMMIT_MS + 800);
    expect(writes).toContainEqual({
      path: "/api/rules",
      body: { kind: "sender", match: ONE_CLICK, destination: "ohmail/Screened", applyRetro: false },
    });
    expect(writes.some(({ path }) => path.startsWith("/api/screener/") || path.endsWith("/unsubscribe"))).toBe(false);
    expect(report()).not.toContain("unsubscrib");
  });
});

describe("a claim through a list's address: Screen out files those letters alone and asks nothing", () => {
  const CLAIM = { reason: "impersonation", brand: "PostFinance", domainShared: false, list: true } as const;
  const genericRuleLine = () => screen().queryByText(/^Becomes a rule/i);

  it("a list the person let in: the card says what Screen out files, promises no rule and names no unsubscribe, nor does the press", async () => {
    await mount({ held: [{ id: "l1", from: ONE_CLICK, posture: "one_click", verdict: "pass", check: CLAIM }], width: 1280, claimsOnly: [ONE_CLICK] });
    expect(cardLine()).toBeNull();
    expect(screen().getByText(
      "Screen out and Spam are the exception here: they set aside only the messages that claim to be PostFinance, and make no rule.",
    )).toBeTruthy();
    expect(genericRuleLine()).toBeNull();
    expect(screen().getByText(`Ohbox, News and Receipts become a rule — future mail from ${ONE_CLICK} files automatically. Screen out and Spam write no rule here.`)).toBeTruthy();
    await click(capsule(/^Screen out/));
    expect(page().queryByRole("dialog", { name: copy.place.unsub.screened })).toBeNull();
    expect(report()).toBe(`Screened out — only the messages from ${ONE_CLICK} that claim to be PostFinance. No rule was made, so the list's other mail stays where it is.`);
    await expectScreenOutRequest("l1");
    const destinations = [
      ["Ohbox", "INBOX"], ["News", "ohmail/News"], ["Receipts", "ohmail/Receipts"], ["Spam", "ohmail/Quarantine"],
    ] as const;
    for (const [name, dest] of destinations) {
      await teardownConfirmEnv();
      vi.unstubAllGlobals();
      await mount({ held: [{ id: "l1", from: ONE_CLICK, posture: "one_click", verdict: "pass", check: CLAIM }], width: 1280, claimsOnly: [ONE_CLICK] });
      expect(screen().getByText(`Ohbox, News and Receipts become a rule — future mail from ${ONE_CLICK} files automatically. Screen out and Spam write no rule here.`)).toBeTruthy();
      await click(capsule(new RegExp(`^${name}$`)));
      expect(page().queryByRole("dialog", { name: /unsubscribe/i })).toBeNull();
      expect(writes).toEqual([]);
      const spam = name === "Spam";
      expect(report()).toBe(spam
        ? `Marked spam — only the messages from ${ONE_CLICK} that claim to be PostFinance. No rule was made, so the list's other mail stays where it is.`
        : `${name} — filed. Future mail from ${ONE_CLICK} files there automatically.`);
      await tick(COMMIT_MS + 800);
      expect(writes).toEqual([{
        path: "/api/screener/l1",
        body: { decision: spam ? "no" : "yes", dest, scope: spam ? "confirmed_sender" : "sender", applyRetro: false,
          ...(spam ? { confirmedIds: ["l1"] } : {}) },
      }]);
    }
  }, 30_000);

  it("CONTROL: a list the person never let in is screened out as an address: the rule, the unsubscribe, and no list-claim line", async () => {
    await mount({ held: [{ id: "l3", from: ONE_CLICK, posture: "one_click", verdict: "pass", check: CLAIM }], width: 1280, claimsOnly: [] });
    expect(cardLine()).toBe(`Screen out and Spam also send ${ONE_CLICK} a one-click unsubscribe request for the waiting mail.`);
    expect(screen().queryByText(/they set aside only the messages that claim to be/)).toBeNull();
    expect(genericRuleLine()).toBeNull();
    await click(capsule(/^Screen out/));
    const confirmation = within(page().getByRole("dialog", { name: copy.place.unsub.screened }));
    expect(confirmation.getByText("Once sent, it cannot be undone.")).toBeTruthy();
    expect(confirmation.getByText(
      `Screen out and unsubscribe. ${ONE_CLICK} is still waiting. Later mail from them follows this rule. Confirming also sends them a one-click unsubscribe request for the waiting mail.`,
    )).toBeTruthy();
    expect(writes, "nothing is sent before Yes").toEqual([]);
    await click(confirmation.getByRole("button", { name: copy.place.unsub.screened }));
    expect(report()).toContain(`Screened out — ${ONE_CLICK}.`);
    await tick(COMMIT_MS + 800);
    expect(writes).toEqual([{
      path: "/api/screener/l3",
      body: {
        decision: "no", dest: "ohmail/Screened", scope: "sender", applyRetro: false,
        unsubscribeIds: ["l3"],
      },
    }]);
  });

  it("CONTROL: the same claim at an address no list posts as says the unsubscribe, and no list line", async () => {
    await mount({ held: [{ id: "l2", from: ONE_CLICK, posture: "one_click", verdict: "pass", check: { ...CLAIM, list: false } }], width: 1280 });
    expect(cardLine()).toBe(`Screen out and Spam also send ${ONE_CLICK} a one-click unsubscribe request for the waiting mail.`);
    expect(screen().queryByText(/they set aside only the messages that claim to be/)).toBeNull();
  });
});

describe("the row's menu, its Accept and the bulk strip say it before the press too", () => {
  const slot = (address: string) => within(rowOf(address).parentElement!);

  async function menuFor(address: string) {
    await click(slot(address).getByRole("button", { name: copy.place.choose }));
    return within(page().getByRole("menu", { name: copy.rowMoreAria }));
  }

  it("the menu that offers Screen out and Spam names the request: a fact for a one-click sender, the condition for one offering none", async () => {
    await mount({
      held: [{ id: "h1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }, { id: "h2", from: NO_OFFER, posture: "no_header" }],
      width: 1280,
    });
    const oneClick = await menuFor(ONE_CLICK);
    expect(oneClick.getByText(`Screen out and Spam also send ${ONE_CLICK} a one-click unsubscribe request for the waiting mail.`)).toBeTruthy();
    await act(async () => {
      oneClick.getByRole("menuitem", { name: copy.pileScreened }).dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      }));
    });
    await tick(50);
    const noOffer = await menuFor(NO_OFFER);
    expect(noOffer.getByRole("menuitem", { name: copy.pileScreened })).toBeTruthy();
    expect(noOffer.getByText(`Screen out and Spam also ask to unsubscribe you if the waiting mail from ${NO_OFFER} offers one-click unsubscribe.`)).toBeTruthy();
  });

  it("an Accept that screens out says it unsubscribes; an Accept that keeps says nothing", async () => {
    await mount({
      held: [{ id: "i1", from: ONE_CLICK, posture: "one_click", verdict: "pass" }, { id: "i2", from: "keep@shop.example", posture: "one_click", verdict: "pass" }],
      width: 1280,
      suggestions: { [ONE_CLICK]: "ohmail/Screened", "keep@shop.example": "ohmail/Receipts" },
    });
    expect(slot(ONE_CLICK).getByRole("button", { name: copy.place.unsub.screened })).toBeTruthy();
    const keep = [...heldById.values()][1]!.from;
    expect(slot(keep).getByRole("button", { name: "Receipts" })).toBeTruthy();
    expect(slot(keep).queryByRole("button", { name: /unsubscribe/i })).toBeNull();
  });
});
