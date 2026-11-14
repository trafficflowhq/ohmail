/** @vitest-environment jsdom */
import type { EngineMessage, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as screener from "@ohmail/app/screener";
import { NONE } from "@ohmail/app/host";
import { noSuggestionReason } from "@ohmail/app-logic/screener/no-suggestion";
import { within } from "@testing-library/react";
import { TextProvider, useText } from "@ohmail/app/text";
import type { Translator } from "@ohmail/app-logic/text/translator";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

function msg(
  id: string, from: string, hour: number, opts: { noAi?: boolean } = {},
): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [], cc: [],
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder: "ohmail/Screener",
    snippet: `snippet ${id}`,
    unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null,
      no_ai: opts.noAi === true,
      no_forward: false, no_kb: false, priority: false,
    },
    senderCheck: null,
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

let suggestReply: (body: { senders: string[]; dryRun?: boolean }) => Response | Promise<Response>;
let accessReply: () => Response;
let purchases = 0;
let host: HTMLElement | null = null;
let selected: string;
let model: React.ComponentProps<typeof screener.ScreenerAbove>;

beforeAll(warmCloudShell);
beforeEach(async () => {
  const { forgetAccess } = await import("../app/api-client");
  installConfirmEnv();
  forgetAccess();
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
  suggestReply = (body) => json({
    dryRun: body.dryRun === true, requested: body.senders.length,
    quoted: body.senders.length, quotedCredits: body.senders.length,
    charged: 0, suggestions: [], skipped: [],
  });
  accessReply = () => json({ aiEnabled: true });
  purchases = 0;
});

afterEach(async () => {
  await teardownConfirmEnv();
  host = null;
});

async function mountView(
  mail: EngineMessage[],
  opts: { optedIn?: boolean; subscriptionPane?: boolean; forgetOwner?: boolean; chooseSender?: boolean } = {},
): Promise<void> {
  const Above = screener.ScreenerAbove;
  vi.spyOn(screener, "ScreenerAbove").mockImplementation((props) => {
    model = props;
    return <Above {...props} />;
  });
  scriptSync(() => {
    const creates: SyncResponse["changes"]["creates"] = mail.map((entity, index) => ({
      type: "message", op: "create", id: entity.id, seq: index + 1, updatedAt: ISO, entity,
    }));
    return json({
      changes: { creates, updates: [], moves: [], deletes: [] },
      cursor: String(creates.length), hasMore: false, serverTime: ISO,
    } satisfies SyncResponse);
  });
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/mailboxes") {
      return json({ items: [{
        id: "mb_1", address: "mailbox@example.invalid", status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    if (method === "GET" && path === "/account/access") {
      return json({ ...(opts.subscriptionPane ? { metered: true } : {}), ...await accessReply().json() });
    }
    if (method === "GET" && path === "/consent") {
      const base = await (await fixture(input, init)).json();
      return json({ ...base, autoSuggestAt: opts.optedIn ? ISO : null });
    }
    if (method === "POST" && path === "/screener/suggest") {
      const body = JSON.parse(String(init?.body)) as { senders: string[]; dryRun?: boolean };
      if (body.dryRun !== true) purchases++;
      return suggestReply(body);
    }
    if (method === "GET" && path === "/screener" && !url.searchParams.has("live")) {
      return json({ items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 } });
    }
    if (method === "GET" && path.endsWith("/body")) return new Response(null, { status: 503 });
    return fixture(input, init);
  };
  window.location.hash = "#/ohbox";
  host = await mountCloudShell();
  await tick(3000);
  if (opts.forgetOwner) document.cookie = "tf_owner=; Path=/; Max-Age=0";
  const places = within(host).getByRole("navigation", { name: "Places" });
  const screenerButton = within(places).getByRole("button", { name: /^Screener/ });
  await act(async () => { screenerButton.click(); });
  await tick(1500);
  if (opts.chooseSender !== false) await selectSender(mail[0]!.from.address);
}

async function press(label: string | RegExp): Promise<void> {
  const button = within(document.body).getByRole("button", { name: label });
  await act(async () => { button.click(); });
  await tick(50);
}

const pressConfirm = () => press(/^Suggest for /);

async function selectSender(address: string): Promise<void> {
  const row = within(host!).getByRole("option", { name: (name) => name.includes(address) });
  await act(async () => { row.click(); });
  await tick(50);
  selected = address;
}

const selectLastRow = () => selectSender(MANY[MANY.length - 1]!.from.address);
const flush = () => tick(50);
const text = () => host?.textContent ?? "";
const copy = messages.screener;

/** Check the selected sender's model independently of the sentence rendered for them. */
function why() {
  const sender = model.model.waiting.find((row) => row.from.address === selected);
  expect(sender).toBeDefined();
  if (sender!.ai) return null;
  const suggest = model.beside.suggest;
  expect(suggest).not.toBe(NONE);
  if (suggest === NONE) throw new Error("No suggestion control mounted");
  const { standing, inFlight } = suggest.noAdvice;
  return noSuggestionReason(sender!, standing, inFlight.has(selected));
}

/** Twelve senders, newest first — enough that a bounded run cannot reach the back of the queue. */
const MANY = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `s${i}@ex.example`, 23 - i));

describe("why a waiting sender has no suggestion", () => {
  it("PENDING — nobody has asked, and that is the one state that may say 'yet'", async () => {
    await mountView(MANY);
    expect(why()).toBe("pending");
    expect(text()).toContain("No suggestion yet for this sender");
  });

  it("NO_AUTO_AI — nothing was suggested by itself, and the row says that instead of 'yet'", async () => {
    // The representative is the newest held message, which is the row selected first.
    const held = [msg("nx", "quiet@ex.example", 23, { noAi: true }), ...MANY.slice(1)];
    await mountView(held);
    expect(why()).toBe("no_auto_ai");
    expect(text()).toContain("kept out of automatic AI");
    expect(text(), "the promise is what this case exists to remove").not.toContain("No suggestion yet");
  });

  it("UNAVAILABLE — a run stopped on the spend gate, and the rows it never reached say so", async () => {
    await mountView(MANY);
    // Before the run, the same row says "yet" — the control that this is the run's doing.
    await selectLastRow();
    expect(why()).toBe("pending");

    suggestReply = (body) => json({
      dryRun: body.dryRun === true, requested: body.senders.length,
      quoted: body.senders.length, quotedCredits: body.senders.length,
      charged: 0,
      // The gate refused before anything was answered, which is the entitlement shape.
      ...(body.dryRun === true ? {} : { stopped: "spend_unavailable" }),
      suggestions: [], skipped: [],
    });
    await press("Suggest…");
    /* TEN OF TWELVE, deliberately. A purchase is bounded, so the senders it never reaches are the
       majority of a real queue and the whole point of this state — buying "all" would leave no
       such row and the case would be satisfiable by the run’s own `noAnswer` chips. */
    await press("10");
    await pressConfirm();

    await selectLastRow();
    expect(why()).toBe("unavailable");
    expect(text()).toContain("AI suggestions are not available for this account");
    expect(text()).not.toContain("No suggestion yet");
  });

  it("A RUN THAT ASKED ABOUT THIS SENDER OUTRANKS BOTH — the nearer, more specific fact", async () => {
    /* The precedence, stated because it is the one a reader would get wrong: a sender the run
       ASKED about carries the run’s own `noAnswer` and renders that, not a standing state — it
       describes an attempt that actually happened. The two states this file is about are for rows
       no run has reached, which on a bounded purchase is most of the queue. Without this case the
       `unavailable` assertion could be satisfied by a row that was asked about. */
    const held = [msg("nx", "quiet@ex.example", 23, { noAi: true }), ...MANY.slice(1)];
    await mountView(held);
    suggestReply = (body) => json({
      dryRun: body.dryRun === true, requested: body.senders.length,
      quoted: body.senders.length, quotedCredits: body.senders.length, charged: 0,
      ...(body.dryRun === true ? {} : { stopped: "spend_unavailable" }),
      suggestions: [], skipped: [],
    });
    await press("Suggest…");
    await pressConfirm();
    // The first row was in the asked set, so it now carries the run’s reason and this branch is
    // not rendered at all.
    expect(why()).toBeNull();
    expect(text()).toContain("AI is switched off or unavailable for this account");
  });
});

/**
 * ═══ COMING — only while a run is buying this sender (ruled) ════════════════════════════════════
 *
 * The opt-in alone used to say a suggestion was coming, and on an account with no credits the paired
 * desktop said it for minutes while the web said none were left. A row now says one is coming only
 * while a run of this surface is buying that sender; otherwise it offers the press.
 *
 * MUTATIONS WATCHED RED: answering `coming` from the opt-in again reddens the second case; dropping
 * the in-flight arm reddens the first; the chip case reddens if a suggestion stops replacing it.
 */
describe("the coming state — a run is buying this sender", () => {
  it("while the automatic batch is buying the row, it says a suggestion is coming", async () => {
    suggestReply = (body) => body.dryRun === true
      ? json({ dryRun: true, requested: body.senders.length, quoted: body.senders.length,
          quotedCredits: body.senders.length, charged: 0, suggestions: [], skipped: [] })
      : new Promise<Response>(() => {});
    await mountView(MANY, { optedIn: true });
    expect(purchases, "the batch left — this case would measure nothing").toBe(1);
    expect(why()).toBe("coming");
    expect(text()).toContain("A suggestion is coming for this sender");
  });

  it("an opted-in account with no run buying the row promises nothing", async () => {
    await mountView(MANY, { optedIn: true, forgetOwner: true });
    expect(purchases).toBe(0);
    expect(why()).toBe("pending");
    expect(text()).not.toContain("A suggestion is coming");
  });

  it("…and it outranks nothing: no_ai mail and a stopped run keep their own sentences", async () => {
    const held = [msg("nx", "quiet@ex.example", 23, { noAi: true }), ...MANY.slice(1)];
    await mountView(held, { optedIn: true });
    // The selected (newest) row is the no_ai one — the opt-in does not promise what the
    // sensitivity pass keeps away from every model.
    expect(why()).toBe("no_auto_ai");
    expect(text()).not.toContain("A suggestion is coming");
  });

  it("…and it disappears with the chip", async () => {
    suggestReply = (body) => json({
      dryRun: body.dryRun === true, requested: body.senders.length,
      quoted: body.senders.length, quotedCredits: body.senders.length,
      charged: body.dryRun ? 0 : body.senders.length,
      suggestions: body.dryRun ? [] : body.senders.map((s) => ({
        sender: s, messageId: `m-${s}`, decision: "no" as const,
        confidence: 0.9, rationale: "stranger",
      })),
      skipped: [],
    });
    await mountView(MANY);
    expect(why()).toBe("pending");
    await press("Suggest…");
    await press("10");
    await pressConfirm();
    // The selected row is in the front ten, so it now carries an answer: the coming sentence is
    // gone and the chip's own block renders in its place.
    expect(why()).toBeNull();
    expect(text()).toContain("“stranger”");
  });
});

/**
 * ═══ A REFUSED REQUEST TELLS THE TRUTH — thrown or answered, it is never "coming" ═══════════════
 *
 * A request the route refuses OUTRIGHT (a 402 for budget, 409, 503) throws, and only an answered
 * run's `stopped` used to reach the standing: an opted-in account toasted "No AI budget left" while
 * every waiting row said a suggestion was coming. Each refusal now sets the standing, and the row
 * names the reason. MUTATIONS WATCHED RED: the automatic batch's `writeStanding(stood)` removed →
 * the thrown-402 automatic case; the confirm's removed → the manual case; `standingOfRefusal`
 * answering `refused` for every code → the per-reason table.
 */
const refusal = (status: number, code: string, message: string) => () =>
  json({ error: { code, message } }, status);

describe("a refused suggest request sets the standing, and the row says why", () => {
  it("the AUTOMATIC batch refused for budget (402, thrown): unavailable with the reason, never coming", async () => {
    suggestReply = refusal(402, "insufficient_credits", "no AI credits remain on this account");
    await mountView(MANY, { optedIn: true });
    expect(purchases, "the automatic batch never asked — this case would measure nothing").toBe(1);
    expect(why()).toBe("unavailable");
    expect(text()).toContain(messages.screener.noSuggestionNoBudget);
    expect(text()).not.toContain(messages.screener.noSuggestionNoBudgetWhere);
    expect(text()).not.toContain("A suggestion is coming");
  });

  it("…and says where credits come from only where Settings lists the Subscription pane", async () => {
    suggestReply = refusal(402, "insufficient_credits", "no AI credits remain on this account");
    await mountView(MANY, { optedIn: true, subscriptionPane: true });
    expect(purchases).toBe(1);
    expect(why()).toBe("unavailable");
    expect(text()).toContain(messages.screener.noSuggestionNoBudgetWhere);
    expect(messages.screener.noSuggestionNoBudgetWhere).toContain(messages.settings.billing);
  });

  it("a MANUAL purchase refused outright (402, thrown): the rows it never reached say so", async () => {
    await mountView(MANY);
    await selectLastRow();
    expect(why(), "the control: before the press this row is only pending").toBe("pending");
    suggestReply = (body) => body.dryRun === true
      ? json({ dryRun: true, requested: body.senders.length, quoted: body.senders.length,
          quotedCredits: body.senders.length, charged: 0, suggestions: [], skipped: [] })
      : json({ error: { code: "insufficient_credits", message: "no AI credits remain on this account" } }, 402);
    await press("Suggest…");
    await press("10");
    await pressConfirm();
    await selectLastRow();
    expect(purchases).toBe(1);
    expect(why()).toBe("unavailable");
    expect(text()).toContain(messages.screener.noSuggestionNoBudget);
    expect(text()).not.toContain("No suggestion yet");
  });

  /* Every refusal code the route answers, and the reason the row names for it. */
  const TABLE: Array<[string, () => Response, string]> = [
    ["409 ai_disabled", refusal(409, "ai_disabled", "managed AI is switched off"), "AI is switched off."],
    ["503 ai_unavailable", refusal(503, "ai_unavailable", "temporarily unavailable"), "AI is not answering"],
    ["409 organized_elsewhere", refusal(409, "organized_elsewhere", "another install organizes this mailbox"),
      "the server refused the request"],
  ];
  for (const [what, reply, sentence] of TABLE) {
    it(`${what} — unavailable, with its own reason`, async () => {
      suggestReply = reply;
      await mountView(MANY, { optedIn: true });
      expect(purchases).toBe(1);
      expect(why()).toBe("unavailable");
      expect(text()).toContain(sentence);
      expect(text()).not.toContain("A suggestion is coming");
    });
  }

  it("402 subscription_required — the account needs a subscription", async () => {
    const { standingOfRefusal } = await import("@ohmail/app-logic/screener/screener-suggest");
    const { noSuggestionKey } = await import("@ohmail/app-logic/screener/no-suggestion");
    const { ApiError } = await import("../app/api-client");
    const error = new ApiError(402, "subscription_required", "subscription required", undefined, { coded: true });
    const standing = standingOfRefusal(error);
    const reason = noSuggestionReason({}, standing, true);
    expect(reason).toBe("unavailable");
    expect(noSuggestionKey(reason, standing)).toBe("noSuggestionRefused");
    expect(copy.noSuggestionRefused).toContain("the server refused the request");

    suggestReply = refusal(402, "subscription_required", "subscription required");
    await mountView(MANY, { optedIn: true, chooseSender: false });
    expect(purchases).toBe(1);
    const page = within(host!);
    expect(page.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(page.queryByRole("navigation", { name: "Places" })).toBeNull();
    expect(text()).not.toContain("A suggestion is coming");
  });

  it("a request that never reached a server is not a fact about the account — no standing, no promise", async () => {
    // The positive control for the table: an unreachable server sets no standing, and its run is over.
    suggestReply = () => { throw new TypeError("Failed to fetch"); };
    await mountView(MANY, { optedIn: true });
    expect(purchases).toBe(1);
    expect(text()).toContain(messages.screener.noSuggestion);
    expect(why()).toBe("pending");
  });

  it("the QUOTE's own stop is the number pressed, not the account — no standing", async () => {
    await mountView(MANY);
    suggestReply = (body) => json({
      dryRun: body.dryRun === true, requested: body.senders.length,
      quoted: body.senders.length, quotedCredits: body.senders.length, charged: 0,
      ...(body.dryRun === true ? {} : { stopped: "over_quote" }),
      suggestions: [], skipped: [],
    });
    await press("Suggest…");
    await press("10");
    await pressConfirm();
    await selectLastRow();
    expect(why()).toBe("pending");
    expect(text()).not.toContain("AI suggestions are not available");
  });

  it("an access read that says AI is on takes the ai_disabled reason down again", async () => {
    suggestReply = refusal(409, "ai_disabled", "managed AI is switched off");
    accessReply = () => json({ metered: false });
    await mountView(MANY, { optedIn: true });
    expect(purchases).toBe(1);
    await flush();
    expect(text()).toContain(messages.screener.noSuggestion);
    expect(why()).toBe("pending");
  });
});

describe("standingOfRefusal / standingOfStop — the two doors into the standing", () => {
  it("reads the envelope's code on either transport, and nothing a server did not state", async () => {
    const { standingOfRefusal, standingOfStop } = await import("@ohmail/app-logic/screener/screener-suggest");
    const { ApiError } = await import("../app/api-client.js");
    const coded = (status: number, code: string) => new ApiError(status, code, "m", undefined, { coded: true });
    expect(standingOfRefusal(coded(402, "insufficient_credits"))).toBe("no_budget");
    expect(standingOfRefusal(coded(409, "ai_disabled"))).toBe("ai_disabled");
    expect(standingOfRefusal(coded(503, "ai_unavailable"))).toBe("ai_unavailable");
    expect(standingOfRefusal(coded(503, "suggest_unconfigured"))).toBe("refused");
    // The desktop bridge's refusal is not an `ApiError`, and carries the same code off the same envelope.
    expect(standingOfRefusal(Object.assign(new Error("m"), { status: 402, code: "insufficient_credits" })))
      .toBe("no_budget");
    // Nothing a server stated: a client-side refusal, a platform page, a bridge that never answered.
    expect(standingOfRefusal(new ApiError(0, "network_unreachable", "m"))).toBeNull();
    expect(standingOfRefusal(new ApiError(502, "internal", "m", undefined, { coded: false }))).toBeNull();
    expect(standingOfRefusal(new TypeError("Failed to fetch"))).toBeNull();
    expect(standingOfStop("out_of_credits")).toBe("no_budget");
    expect(standingOfStop("spend_unavailable")).toBe("spend_unavailable");
    expect(standingOfStop("over_quote")).toBeNull();
    expect(standingOfStop(undefined)).toBeNull();
  });
});

describe("absorbStanding — a host control's refusal reaches the shell's rows", () => {
  it("the shell's hook reads a standing put in from outside, and does not publish it back", async () => {
    const { useScreenerSuggestions } = await import("@ohmail/app-logic/screener/screener-suggest");
    const { CLOUD_WIRE } = await import("../app/(product)/mailbox/suggest-wire.js");
    const published: unknown[] = [];
    let api: { standing: unknown; absorbStanding: (s: "no_budget" | null) => void } | null = null;
    function Probe(): null {
      const screenerText = useText("screener") as unknown as Translator;
      const aiRefusal = useText("aiRefusal") as unknown as Translator;
      const s = useScreenerSuggestions({
        text: { screener: screenerText, aiRefusal },
        wire: CLOUD_WIRE,
        active: false, toast: (() => {}) as never, publishStanding: (x) => { published.push(x); },
      });
      api = s as never;
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<TextProvider locale="en" messages={messages} timeZone="UTC">
          <Probe />
        </TextProvider>);
      });
      expect(api!.standing).toBeNull();
      await act(async () => { api!.absorbStanding("no_budget"); });
      expect(api!.standing).toBe("no_budget");
      // A sink that echoed it back would loop between two hooks that both publish.
      expect(published).toEqual([]);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});

/**
 * A WHOLE-DOMAIN CARD NAMES WHAT ELSE IT FILES before the press: the other waiting senders at the
 * domain and how many of their letters move (`state.reachOf`), the set the press moves. Nothing is
 * said at sender scope.
 */
describe("the whole-domain card names the other senders before the press", () => {
  it("says nothing at sender scope, then names the other sender and the count at domain scope", async () => {
    // Checked at ingest and clean (`senderCheck: null`), as production rows are: the press moves them.
    const checked = (m: EngineMessage): EngineMessage => ({ ...m, senderCheck: null });
    await mountView([checked(msg("da", "a@letters.example", 22)), checked(msg("db", "b@letters.example", 21))]);
    const reach = "Also files 1 letter from others at this domain: b@letters.example (1).";
    expect(text()).not.toContain(reach);
    await press("Decision scope");
    const menu = within(document.body).getByRole("menu", { name: "Decision scope" });
    await act(async () => { within(menu).getByRole("menuitemradio", { name: "whole domain" }).click(); });
    expect(within(host!).getByText(reach).textContent).toBe(reach);
  });
});
