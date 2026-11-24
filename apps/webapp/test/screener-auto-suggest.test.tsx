/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder, SyncResponse } from "@ohmail/wire";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createElement, Fragment, useLayoutEffect } from "react";
import { within } from "@testing-library/react";
import { OhmailEngine } from "@ohmail/client-engine";
import * as screener from "@ohmail/app/screener";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

/**
 * THE AUTO-SUGGEST OPT-IN, ON THE WIRE — mail 0040.
 *
 * The opt-in lets ohmail buy a classifier suggestion for waiting senders WITHOUT a press. That is
 * money moving with no click behind it, so every property worth having is a property of the
 * requests the app issues, and this file asserts them there rather than through a rendered label.
 *
 * ── THE FIVE THINGS THAT MUST BE TRUE ────────────────────────────────────────────────────
 *
 *  1. OFF BY DEFAULT, AND OFF MEANS SILENT. With the flag absent — the demo, the desktop, a shell
 *     whose `GET /consent` failed, an API from before 0040 — not one request is issued. The
 *     default has to be the one that spends nothing, because the alternative is a fetch error that
 *     costs the user money.
 *  2. IT SUGGESTS, IT NEVER DECIDES. The automatic path may reach `POST /screener/suggest` and
 *     nothing else. No `POST /screener/:id`, and no engine mutation — so no rule, no contact, no
 *     move. This is the invariant the whole feature stands on: the opt-in buys WORK, not a
 *     decision, and a stranger still waits for a human. Asserted by watching the calls, because
 *     "there is no line that does that" is not something a reader can verify later.
 *  3. ONE BATCH, BOUNDED. Exactly one purchase per mounted Screener, of at most
 *     `AUTO_BATCH_SIZE` senders, taken from the FRONT of the queue in the queue's own order.
 *     Re-renders, effect re-runs and a warming mirror must not each buy a batch.
 *  4. A REFUSAL DISARMS AND DOES NOT RETRY. On 402/409/503 the automatic path stops for the
 *     session. An automatic loop against a standing refusal is a flood against a wall.
 *  5. A COLD MIRROR STILL GETS ITS BATCH. On a live account the queue is EMPTY for the first few
 *     renders while the mirror fills. An implementation that looks once and gives up would do
 *     nothing on every live account and pass every test with a pre-warmed fixture — which is the
 *     shape of the "eight of twenty-four journeys went red against a cold account" lesson, run in
 *     reverse.
 *
 * `apps/webapp` typechecks its tests, so the wire shapes below are checked as well as the values.
 */

/**
 * The bound the automatic batch must respect, restated here as a LITERAL.
 *
 * Deliberately not imported from the module under test: importing it would make the assertion
 * "the code agrees with itself", and this number is a spend ceiling. Raising it in the
 * implementation has to stop this suite and make somebody argue for the new figure.
 */
const AUTO_BATCH_SIZE = 10;

function msg(id: string, from: string, hour: number, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-09-03T${String(hour).padStart(2, "0")}:00:00.000Z`,
    folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-09-03T09:00:00.000Z",
  };
}

interface Recorded {
  method: string;
  path: string;
  body: { senders?: string[]; dryRun?: boolean; automatic?: boolean } | null;
  idempotencyKey: string | null;
}

let calls: Recorded[] = [];
let sent: EngineMutation[] = [];
/** Everything the surface said out loud. The automatic path's ONLY way to be heard. */
let toasts: string[] = [];
let host: HTMLElement | null = null;
let suggestReply: (body: { senders: string[]; dryRun?: boolean }, n: number) => Response;

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The server's refusal envelope, exactly as `packages/api` writes it. */
const refusal = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const suggestCalls = () => calls.filter((c) => c.path === "/screener/suggest");
const purchases = () => suggestCalls().filter((c) => c.body?.dryRun !== true);
const dryRuns = () => suggestCalls().filter((c) => c.body?.dryRun === true);
const decides = () => calls.filter((c) => c.method === "POST" && c.path !== "/screener/suggest");

let mounted = false;

async function mountView(
  initial: EngineMessage[],
  opts: { autoSuggest?: boolean; subscriptionPane?: boolean } = {},
) {
  installConfirmEnv();
  mounted = true;
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];

  let unsuggested: string[] = [];
  const Above = screener.ScreenerAbove;
  function Observe() {
    const model = screener.useScreener();
    useLayoutEffect(() => { unsuggested = model.unsuggestedSenders; }, [model]);
    return null;
  }
  vi.spyOn(screener, "ScreenerAbove").mockImplementation(({ children, ...props }) =>
    createElement(Above, { ...props, children: createElement(Fragment, null, createElement(Observe), children) }),
  );
  const mutate = OhmailEngine.prototype.mutate;
  vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(function (this: OhmailEngine, ...args) {
    sent.push(args[0]);
    return mutate.apply(this, args);
  });

  const mail = [...initial];
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
        id: "mb_1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    if (method === "GET" && path === "/account/access") {
      return json({ metered: opts.subscriptionPane === true, aiEnabled: true });
    }
    if (method === "GET" && path === "/consent") {
      const base = await (await fixture(input, init)).json();
      return json({
        ...base,
        ...(opts.autoSuggest === undefined ? {} : { autoSuggestAt: opts.autoSuggest ? ISO : null }),
      });
    }
    if (path.startsWith("/screener") || (method !== "GET" && /^\/(rules|messages|contacts)(?:\/|$)/.test(path))) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Recorded["body"] : null;
      calls.push({ method, path, body, idempotencyKey: new Headers(init?.headers).get("idempotency-key") });
      if (path === "/screener/suggest") {
        return suggestReply(body as { senders: string[]; dryRun?: boolean }, suggestCalls().length);
      }
      // The advice read has no stored suggestions. The queue reader falls back to the synced mail.
      if (method === "GET" && path === "/screener" && !url.searchParams.has("live")) {
        return json({ items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 } });
      }
    }
    if (method === "GET" && path.endsWith("/body")) return new Response(null, { status: 503 });
    return fixture(input, init);
  };

  window.location.hash = "#/ohbox";
  host = await mountCloudShell();
  await tick(3000);
  sent = [];
  calls = [];
  const go = async (place: "Ohbox" | "Screener") => {
    const rail = within(host!).getByRole("navigation", { name: "Places" });
    const target = within(rail).getByRole("button", {
      name: (name) => name === place || name.startsWith(`${place} `),
    });
    await act(async () => { target.click(); });
    await tick(1000);
  };
  const readReport = () => {
    const report = host?.querySelector('.fr-report [role="status"]:not([data-leaving])')?.textContent;
    if (report) toasts.push(report);
  };
  await go("Screener");
  await tick(1500);
  readReport();
  return {
    unsuggested: () => unsuggested,
    deliver: async (next: EngineMessage[]) => {
      mail.push(...next);
      await act(async () => { window.dispatchEvent(new Event("online")); });
      await tick(3000);
    },
    revisit: async () => {
      await go("Ohbox");
      await tick(11000);
      await go("Screener");
      await tick(1500);
      readReport();
    },
  };
}

beforeAll(warmCloudShell);

beforeEach(() => {
  calls = [];
  sent = [];
  toasts = [];
  suggestReply = (body) =>
    json({
      dryRun: body.dryRun === true,
      requested: body.senders.length,
      quoted: body.senders.length,
      quotedCredits: body.senders.length,
      charged: body.dryRun ? 0 : body.senders.length,
      suggestions: body.dryRun ? [] : body.senders.map((s, i) => ({
        sender: s, messageId: `m-${s}`,
        decision: i % 2 === 0 ? "yes" : "no",
        confidence: 0.9, rationale: `because ${s}`,
      })),
      skipped: [],
    });
});

async function unmountView() {
  if (mounted) await teardownConfirmEnv();
  mounted = false;
  host = null;
}

afterEach(unmountView);

/** Twelve waiting senders, so the batch bound is BELOW the queue and can be observed biting. */
const TWELVE = Array.from({ length: 12 }, (_, i) =>
  msg(`m${i}`, `s${String(i).padStart(2, "0")}@example.com`, 23 - i));

describe("mail 0040 — the auto-suggest opt-in buys, and buys only", () => {
  it("OFF BY DEFAULT: with the flag absent, not one suggest request is issued", async () => {
    const view = await mountView(TWELVE);
    // The premise, so the assertion cannot pass because there was nothing to buy.
    expect(view.unsuggested().length).toBe(12);
    expect(suggestCalls()).toEqual([]);
  });

  it("OFF EXPLICITLY: `autoSuggest: false` is the same silence", async () => {
    const view = await mountView(TWELVE, { autoSuggest: false });
    expect(view.unsuggested().length).toBe(12);
    expect(suggestCalls()).toEqual([]);
  });

  it("ON: exactly ONE purchase, bounded, from the front of the queue, keyed", async () => {
    const view = await mountView(TWELVE, { autoSuggest: true });

    expect(purchases()).toHaveLength(1);
    const posted = purchases()[0]!.body!.senders!;
    expect(posted.length).toBeLessThanOrEqual(AUTO_BATCH_SIZE);
    expect(posted).toHaveLength(AUTO_BATCH_SIZE);
    expect(posted).toEqual(TWELVE.slice(0, AUTO_BATCH_SIZE).map(({ from }) => from.address));

    // A PREFIX of the queue in the queue's own order — not a sample, so the same account in the
    // same state buys the same senders and the next visit continues rather than re-rolls.
    // Compared against the queue as it was BEFORE the purchase, which is what the ordering claim
    // is about; `unsuggested()` afterwards is the remainder.
    const remaining = view.unsuggested();
    expect(remaining).toHaveLength(2);
    for (const addr of posted) expect(remaining).not.toContain(addr);

    // NO DRY RUN. The cost was named when the setting was turned on, and the batch is bounded, so
    // a price call here would be a round trip that tells the client something it already fixed.
    expect(dryRuns()).toEqual([]);

    // Keyed, so a lost response is a replay and not a second purchase.
    expect(purchases()[0]!.idempotencyKey).toMatch(/.+/);
  });

  it("NOBODY PRESSED IT, AND THE WIRE SAYS SO: `automatic: true` rides the purchase", async () => {
    await mountView(TWELVE, { autoSuggest: true });
    // The flag lets the server apply the automatic attempt budget.
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.body!.automatic).toBe(true);
  });

  it("suggests automatically for the previously excluded messages", async () => {
    const kept = ["s00@example.com", "s01@example.com"];
    const retrySender = "s11@example.com";
    const next = msg("new", retrySender, 10);
    const held = TWELVE.map((m, i) => (i < 2 ? { ...m, sensitivity: { ...m.sensitivity, no_ai: true } } : m));
    let delivered = false;
    suggestReply = (body) => {
      const skipped = !delivered && body.senders.includes(retrySender)
        ? [{ sender: retrySender, reason: "attempts_exhausted" }]
        : [];
      const asked = body.senders.filter((sender) => !skipped.some((entry) => entry.sender === sender));
      return json({
        dryRun: false, requested: body.senders.length, quoted: asked.length, quotedCredits: asked.length,
        charged: asked.length, skipped,
        suggestions: asked.map((sender) => ({
          sender, messageId: sender === retrySender ? next.id : `m-${sender}`,
          decision: "yes", confidence: 0.9, rationale: "r",
        })),
      });
    };
    const view = await mountView(held, { autoSuggest: true });
    expect(purchases()[0]!.body!.senders).toEqual(expect.arrayContaining(kept));
    for (const k of kept) expect(view.unsuggested()).not.toContain(k);

    await view.revisit();
    // The next visit moves on to the two senders who have no suggestion yet.
    expect(purchases()).toHaveLength(2);
    expect(purchases()[1]!.body!.senders).toEqual(["s10@example.com", retrySender]);
    expect(view.unsuggested()).toContain(retrySender);

    // A new representative has its own server-side attempt budget.
    delivered = true;
    await view.deliver([next]);
    await view.revisit();

    expect(purchases()).toHaveLength(3);
    expect(purchases()[2]!.body).toMatchObject({ automatic: true, senders: [retrySender] });
    expect(view.unsuggested()).not.toContain(retrySender);
  });

  it("IT SUGGESTS, IT NEVER DECIDES: no decide call, and nothing moves", async () => {
    await mountView(TWELVE, { autoSuggest: true });

    expect(purchases()).toHaveLength(1);
    // `POST /screener/:id` is the decide verb — a rule, a contact, a folder move. The automatic
    // path must never reach it.
    expect(decides()).toEqual([]);
    // And nothing reached the ENGINE either, so no optimistic move was painted and no mutation
    // was queued for the server. A suggestion is advice; the mail has not been touched.
    expect(sent).toEqual([]);
    // Every request the app made, so a new call added later has to be accounted for here.
    expect(new Set(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)))
      .toEqual(new Set(["GET /screener", "GET /screener/held-releases", "POST /screener/suggest"]));
  });

  it("A COLD MIRROR still gets its batch — the queue is empty for the first renders", async () => {
    // Nothing held at mount: exactly what a real account looks like while the mirror fills.
    const view = await mountView([], { autoSuggest: true });
    expect(view.unsuggested()).toEqual([]);
    // Nothing to buy, so nothing was bought — and, critically, the latch was NOT spent on the
    // empty queue.
    expect(suggestCalls()).toEqual([]);

    // The mirror arrives.
    await view.deliver(TWELVE);

    expect(view.unsuggested().length).toBeGreaterThan(0);
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.body!.senders).toHaveLength(AUTO_BATCH_SIZE);
  });

  it("A REFUSAL DISARMS FOR THE SESSION: leaving and coming back does not retry it", async () => {
    suggestReply = () => refusal(402, "insufficient_credits", "no AI credits remain on this account");
    const view = await mountView(TWELVE, { autoSuggest: true });

    expect(purchases()).toHaveLength(1);

    // New mail changes nothing: the effect's dependencies are four real signals and "the queue
    // grew" is not one of them.
    await view.deliver([msg("late", "late@example.com", 5)]);
    expect(purchases()).toHaveLength(1);

    // AND THE CASE THAT MAKES THE DISARM LOAD-BEARING. Coming back to the Screener re-arms the
    // batch — that is the intended unit — so without the refusal latch an account with an empty
    // balance would fire one doomed request on every visit, for ever.
    await view.revisit();
    expect(purchases()).toHaveLength(1);
  });

  it("A SUCCESSFUL visit re-arms: coming back buys the NEXT few, not the same ones", async () => {
    const view = await mountView(TWELVE, { autoSuggest: true });
    expect(purchases()).toHaveLength(1);
    const first = purchases()[0]!.body!.senders!;

    await view.revisit();

    // A second batch, and it is the REMAINDER — the first ten now carry suggestions, so the queue
    // the control is bound to has moved on. A backlog drains across visits rather than in one
    // purchase, which is the whole reason the batch is bounded at all.
    expect(purchases()).toHaveLength(2);
    const second = purchases()[1]!.body!.senders!;
    expect(second).toHaveLength(2);
    for (const addr of second) expect(first).not.toContain(addr);
  });

  it("A REFUSAL IS SAID OUT LOUD, in the reader's own language", async () => {
    suggestReply = () => refusal(409, "ai_disabled", "managed AI is switched off for this account");
    await mountView(TWELVE, { autoSuggest: true });

    // TOASTED, not merely stored in the panel's `notice`. This assertion is why the
    // implementation toasts at all: the first version only set `notice`, which renders INSIDE the
    // suggest panel — and on the automatic path nobody opened it. The purchase failed and the
    // surface said nothing, which is precisely the silent outcome the opt-in must not create.
    //
    // FROM THE CATALOGUE, by the refusal's `code` — not the server's `message`, which is English
    // written for a log and was being rendered verbatim onto a German screen. The fact is the
    // same fact; the sentence is the reader's.
    expect(toasts.join(" | ")).toContain(messages.aiRefusal.aiDisabled.replace(/\.$/u, ""));
    // Still the RIGHT refusal, and not a generic one: re-deriving a reason from the status code
    // is how a user with an empty balance gets told the model is down.
    expect(toasts.join(" | ")).not.toContain("Something went wrong");
    expect(toasts.join(" | ")).not.toContain(messages.aiRefusal.insufficientCredits.replace(/\.$/u, ""));
  });

  it("A CLIENT REFUSAL DOES NOT DISARM, and speaks in this client's voice, not the server's", async () => {
    // The browser loses its marker between the pane's permission check and the API client's check.
    // Restore the same owner once the client answers, before the next visit.
    const { screener: api } = await import("../app/api-client");
    const suggest = api.suggest;
    const attempt = vi.spyOn(api, "suggest").mockImplementation(async (...args) => {
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
      try {
        return await suggest(...args);
      } finally {
        rememberOwner();
      }
    });
    const view = await mountView(TWELVE, { autoSuggest: true });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(suggestCalls()).toHaveLength(0);
    expect(toasts.join(" | ")).toContain(messages.screener.suggest.refusedOwnerAbsent.replace(/\.$/u, ""));
    expect(toasts.join(" | ")).not.toContain("different account");
    expect(toasts.join(" | ")).not.toContain("This browser has lost the name");

    const before = toasts.length;
    await view.revisit();
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(suggestCalls()).toHaveLength(0);
    expect(toasts.length, "a client-side refusal disarmed the automatic pass").toBeGreaterThan(before);
  });

  it("A SUCCESSFUL automatic purchase is said out loud too — money moved with no press", async () => {
    await mountView(TWELVE, { autoSuggest: true });
    expect(purchases()).toHaveLength(1);
    // The "visible after the fact" half of the opt-in. Nobody pressed anything, so the only
    // record the user gets in the moment is this line, and it names the count and the credits.
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("10 suggestions");
    expect(toasts[0]).toContain("10 credits");
  });
});

/**
 * SCREENER-SUGGEST-REFUSAL-IS-SILENT: on the live Cloud, opening the Screener sent the automatic
 * batch, the server answered 402 (no credits), and after the toast nothing on screen said so.
 * The Suggest menu keeps one sentence while that standing holds, naming where credits come from
 * only where Settings lists the Subscription pane.
 */
describe("a refused automatic batch stays said", () => {
  const creditsIn = (surface: HTMLElement): string | null => {
    return within(surface).queryAllByRole("status")
      .map((line) => line.textContent)
      .find((line) => line === messages.screener.suggest.noCredits
        || line === messages.screener.suggest.noCreditsWhere) ?? null;
  };

  const openSuggest = async () => {
    const tools = within(host!).getByRole("group", { name: messages.screener.bulkAria });
    const inline = within(tools).queryByRole("button", { name: messages.screener.suggest.open });
    if (inline) {
      await act(async () => { inline.click(); });
    } else {
      const list = within(tools).getByRole("button", { name: messages.screener.place.listMenu });
      await act(async () => { list.click(); });
      const suggest = within(document.body).getByRole("menuitem", { name: messages.screener.suggest.open });
      await act(async () => { suggest.click(); });
    }
    await tick(1000);
    return within(document.body).getByRole("dialog", { name: messages.screener.suggest.aria });
  };

  it("402 no credits: the strip says suggestions need credits, and points nowhere it cannot", async () => {
    suggestReply = () => refusal(402, "insufficient_credits", "no AI credits remain on this account");
    await mountView(TWELVE, { autoSuggest: true });
    expect(purchases(), "premise: the automatic batch went out and was refused").toHaveLength(1);
    await tick(12000);
    expect(creditsIn(host!)).toBeNull();
    expect(creditsIn(await openSuggest())).toBe(messages.screener.suggest.noCredits);
  });

  it("…and names Settings → Subscription where Settings lists it", async () => {
    suggestReply = () => refusal(402, "insufficient_credits", "no AI credits remain on this account");
    await mountView(TWELVE, { autoSuggest: true, subscriptionPane: true });
    expect(creditsIn(host!)).toBeNull();
    expect(creditsIn(await openSuggest())).toBe(messages.screener.suggest.noCreditsWhere);
    expect(messages.screener.suggest.noCreditsWhere).toContain(messages.settings.billing);
  });

  it("control: a funded batch and a switched-off AI say no credits line", async () => {
    await mountView(TWELVE, { autoSuggest: true, subscriptionPane: true });
    expect(purchases()).toHaveLength(1);
    expect(creditsIn(host!)).toBeNull();
    await unmountView();

    suggestReply = () => refusal(409, "ai_disabled", "managed AI is switched off for this account");
    await mountView(TWELVE, { autoSuggest: true, subscriptionPane: true });
    expect(purchases()).toHaveLength(1);
    expect(creditsIn(host!), "the credits line spoke for a refusal that was not about credits").toBeNull();
  });
});
