/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, within } from "@testing-library/react";
import { confirmSyncOwner, createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { OhmailEngine, MemoryMirrorStore, type MirrorStore } from "@ohmail/client-engine";
import en from "../messages/en.json";
import type { OrganizerNotice as NoticeFact } from "@ohmail/app-logic/mail-state/mail-state";
import type { PendingDecision, ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import { modelOf, mountPlace } from "../../../packages/app/test/screener/screener-world";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, teardownScreeningWeb, tick,
} from "./fixtures/screening-web.js";
import {
  act as shellAct, installShellEnv, mailbox, mountShell, teardownShellEnv, tick as shellTick,
} from "./fixtures/live-walk-shell.js";

/**
 * ═══ WHO ORGANIZES THIS MAILBOX CHANGED — SAID ONCE, AND A DECISION THAT SURVIVES ITS CONFIRM ══
 *
 * Two properties this file exists for, and they fail in opposite directions.
 *
 * ## THE NOTICE MUST NOT BECOME A STANDING WARNING
 *
 * Reading a mailbox somebody else organizes is a NORMAL, usually deliberate state — a phone and a
 * laptop on one mailbox is the ordinary shape of the product. A line that says so on every visit
 * is a warning about a decision the person already made, which is the thing the design refuses to
 * be. So: shown while the change is unacknowledged, gone the moment it is, and gone on every door
 * rather than on the one that pressed — the comparison lives on the mailbox row for exactly that.
 *
 * ## AND A QUEUED DECISION MUST NOT UNDO ITSELF
 *
 * On a mailbox another install organizes, `POST /screener/:id` answers 202: the decision is
 * recorded for that install and NOTHING is filed here. No `change_log` row is written, so the
 * reconciling drain carries nothing, the engine drops the optimistic overlay on confirm, and the
 * projection offers the same sender again a moment later. A person would see the press work and
 * then unwind itself, on the SUCCESS path, with nothing anywhere saying why — the released
 * build's rollback defect arriving through the other door.
 *
 * ## HOW TO WATCH THESE FAIL
 *
 *   · `mutate.py noseen` — drop the `when <= seen` comparison → "it is gone once acknowledged"
 *     and "a dismissal on another door takes it away here" both go red, with the line standing
 *     over a change somebody has already answered;
 *   · `mutate.py nopendingwith` — throw the queued answer away → "the press does not revert" goes
 *     red with the sender back in the queue after the commit window.
 *
 * The model's once-per-change cases live in organizer-notice-model.test.ts.
 */

const NOW = new Date("2026-09-04T10:00:00.000Z");
let reset: (() => Promise<void>) | undefined;
afterEach(async () => {
  cleanup();
  await reset?.();
  reset = undefined;
});

const EARLIER = "2026-09-04T09:00:00.000Z";
const LATER = "2026-09-04T09:30:00.000Z";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   2 · THE LINE — it says one thing, and the press ends it
   ══════════════════════════════════════════════════════════════════════════════════════════ */

let noticeFacts: NoticeFact[];
const fromNotice = (item: NoticeFact, acknowledged = false) => ({
  id: item.id, address: item.address, status: "connected",
  organizerRole: "reader", organizerChecked: true,
  organizedBy: { kind: item.kind === "elsewhere" ? "cloud" : "local", name: item.name, since: item.at },
  ...(item.kind === "stopped" ? { organizerState: "stopped" } : {}),
  organizerEventAt: item.at, organizerEventSeenAt: acknowledged ? item.at : null,
  createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
});

async function mountNotice(notices: NoticeFact[], onAcknowledge: (id: string) => Promise<unknown>) {
  noticeFacts = notices;
  const acknowledged = new Map<string, string>();
  const reply = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { "X-Ohmail-Account": ACCOUNT },
  });
  installScreeningWeb("#/ohbox", (path, _query, method) => {
    if (path === "/api/mailboxes") return reply({
      items: [...noticeFacts].sort((a, b) => a.order - b.order).map((item) => fromNotice(item, acknowledged.get(item.id) === item.at)),
    });
    const id = /^\/api\/mailboxes\/([^/]+)\/organizer-notice\/dismiss$/.exec(path)?.[1];
    if (method !== "POST" || !id) return undefined;
    const fact = noticeFacts.find((item) => item.id === id);
    return (async () => {
      if (!fact) return reply({}, 404);
      try {
        await onAcknowledge(id);
      } catch (error) {
        if (error instanceof TypeError) throw error;
        const refusal = error as { status?: number; code?: string; message?: string };
        if (refusal.status === 0) throw new TypeError(refusal.message);
        return reply({ error: { code: refusal.code ?? "inactive", message: refusal.message } },
          refusal.status ?? Number(refusal.message ?? 500));
      }
      acknowledged.set(id, fact.at);
      return reply(fromNotice(fact, true));
    })();
  });
  reset = teardownScreeningWeb;
  vi.setSystemTime(NOW);
  const shell = within(await mountScreeningWeb());
  await tick(3000);
  return shell.getByRole("navigation", { name: en.frame.landmark.places });
}

const rerenderNotice = async (notices: NoticeFact[]) => {
  noticeFacts = notices;
  await tick(31_000);
};
const withNotice = (el: HTMLElement) => within(el).queryAllByRole("status")
  .filter((notice) => /organiz/i.test(notice.textContent ?? ""));
const noticeKind = (block: HTMLElement) =>
  /no longer being organized|stopped organizing/i.test(block.textContent ?? "") ? "stopped" : "elsewhere";
const noticeAction = (block: HTMLElement, name: string) => within(block).getByRole("button", { name });

async function showNotice(el: HTMLElement, kind: NoticeFact["kind"]) {
  const showing = withNotice(el).find((item) => noticeKind(item) === kind);
  if (showing) return showing;
  await act(async () => { within(el).getByRole("button", { name: /^\d+ more notices?$/ }).click(); });
  const menu = within(document.body).getByRole("menu", { name: /^\d+ more notices?$/ });
  const name = kind === "stopped" ? /no longer being organized|stopped organizing/i : /organized elsewhere|organizes.+now/i;
  await act(async () => { within(menu).getByRole("menuitem", { name }).click(); });
  const block = withNotice(el).find((item) => noticeKind(item) === kind);
  expect(block, `the selected ${kind} notice is visible`).toBeDefined();
  return block!;
}

const fact = (over: Partial<NoticeFact> = {}): NoticeFact => ({
  id: "mb1", address: "person@example.com", kind: "elsewhere", name: "ohmail Cloud", at: LATER, order: 0,
  ...over,
});

describe("the organizer notice, on screen — one block per kind", () => {
  /* Newest change first, as `organizerNotices` hands them over; `order` is the roster's. */
  const five = (): NoticeFact[] => [
    fact({ id: "s1", address: "shop@example.com", kind: "stopped", name: "Office Linux", order: 3 }),
    fact({ id: "e1", address: "work@example.com", order: 0 }),
    fact({ id: "s2", address: "news@example.com", kind: "stopped", name: null, order: 4 }),
    fact({ id: "e3", address: "club@example.com", order: 2 }),
    fact({ id: "e2", address: "home@example.com", name: null, order: 1 }),
  ];
  const blocks = withNotice;
  const press = async (el: HTMLElement, label: string) => {
    const b = noticeAction(el, label);
    expect(b, `no "${label}" press was drawn`).toBeDefined();
    await act(async () => { b!.click(); });
  };

  it("FIVE MAILBOXES ARE TWO BLOCKS, stopped first, each one sentence with the count", async () => {
    const el = await mountNotice(five(), async () => {});
    const got = blocks(el);
    expect(got.map(noticeKind)).toEqual(["stopped"]);
    expect(got[0]!.textContent).toContain("2 mailboxes are no longer being organized.");
    expect((await showNotice(el, "elsewhere")).textContent).toContain("3 mailboxes are organized elsewhere now.");
    expect(blocks(el).map((block) => block.textContent).join(""), "a closed block listed its mailboxes").not.toContain("@example.com");
  });

  it("THE COUNT OPENS THE LIST: address · holder, and the stopped rows say so", async () => {
    const el = await mountNotice(five(), async () => {});
    const count = noticeAction(blocks(el)[0]!, en.mailboxes.noticeCountShow);
    expect(within(document.body).queryByRole("dialog")).toBeNull();
    await act(async () => { count.click(); });
    const dialog = within(document.body).getByRole("dialog", { name: /no longer being organized/i });
    const rows = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual(["shop@example.com · Office Linux · stopped", "news@example.com · stopped"]);
    await act(async () => { within(dialog).getByRole("button", { name: en.frame.notice.moreClose }).click(); });
    expect(within(document.body).queryByRole("dialog")).toBeNull();
    const elsewhere = await showNotice(el, "elsewhere");
    await act(async () => { noticeAction(elsewhere, en.mailboxes.noticeCountShow).click(); });
    const otherDialog = within(document.body).getByRole("dialog", { name: /organized elsewhere now/i });
    expect(within(otherDialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "work@example.com · ohmail Cloud",
      `home@example.com · ${en.mailboxes.noticeRowUnknown}`,
      "club@example.com · ohmail Cloud",
    ]);
  });

  it("one mailbox keeps the named sentence and no count", async () => {
    const el = await mountNotice([fact()], async () => {});
    expect(blocks(el)).toHaveLength(1);
    expect(el.textContent).toContain("ohmail Cloud organizes person@example.com now.");
    expect(within(el).queryByRole("button", { name: en.mailboxes.noticeCountShow })).toBeNull();
    expect(within(el).getByRole("button", { name: en.mailboxes.noticeOpenMailboxes })).toBeTruthy();
  });

  it("ONE PRESS ACKNOWLEDGES EVERY ROW ITS BLOCK LISTS, and the block goes", async () => {
    const asked: string[] = [];
    const el = await mountNotice(five(), async (id) => { asked.push(id); });
    await press(await showNotice(el, "elsewhere"), en.mailboxes.noticeDismiss);
    expect(asked.sort(), "the press did not reach every row of the block").toEqual(["e1", "e2", "e3"]);
    expect(blocks(el).map(noticeKind), "the other block went with it").toEqual(["stopped"]);
  });

  it("A ROW WHOSE WRITE WAS REFUSED COMES BACK ALONE — the truthful, smaller block", async () => {
    const el = await mountNotice(five(), async (id) => { if (id === "e2") throw new Error("402"); });
    await press(await showNotice(el, "elsewhere"), en.mailboxes.noticeDismiss);
    const back = blocks(el).find((b) => noticeKind(b) === "elsewhere");
    expect(back, "a stamp that was never written was reported as one").toBeDefined();
    expect(back!.textContent).toContain("Another ohmail install organizes home@example.com now.");
  });

  it("A NEW CHANGE ON A MAILBOX DISMISSED EARLIER SHOWS AGAIN while another block keeps the notice mounted", async () => {
    /* REVIEW-026 H1: the optimistic set was keyed by mailbox, so B's later real change (its holder
       stopped: a new instant, a new kind) stayed hidden for the session. */
    const A = fact({ id: "A", address: "a@example.com", kind: "stopped", name: "Office", order: 0 });
    const bElsewhere = fact({ id: "B", address: "b@example.com", kind: "elsewhere", name: "Laptop", order: 1 });
    const asked: string[] = [];
    const el = await mountNotice([A, bElsewhere], async (id) => { asked.push(id); });
    await press(await showNotice(el, "elsewhere"), en.mailboxes.noticeDismiss);
    expect(asked, "the transport takes the bare mailbox id").toEqual(["B"]);
    await rerenderNotice([A]);
    const bStopped = fact({ id: "B", address: "b@example.com", kind: "stopped", name: "Laptop", order: 1, at: "2026-09-04T09:50:00.000Z" });
    await rerenderNotice([bStopped, A]);
    expect(el.textContent, "a new change on a mailbox dismissed earlier in the session is hidden")
      .toContain("2 mailboxes are no longer being organized.");
  });

  it("the stopped block carries the way to act on it; the settled one only Dismiss", async () => {
    const el = await mountNotice(five(), async () => {});
    const labels = (b: HTMLElement) => within(b).queryAllByRole("button", { name: new RegExp(`^(${en.mailboxes.noticeOpenMailboxes}|${en.mailboxes.noticeDismiss})$`) }).map((x) => x.textContent);
    for (const kind of ["stopped", "elsewhere"] as const) {
      const block = await showNotice(el, kind);
      expect(noticeAction(block, en.mailboxes.noticeCountShow)).toBeDefined();
      expect(labels(block)).toEqual([en.mailboxes.noticeDismiss]);
    }
  });

  /* The press stamps the notice seen and moves no mail, so it is not called Mark read. */
  it("the press is named for what it does, in en and de: it dismisses the notice", async () => {
    const de = (await import("../messages/de.json")).default as typeof en;
    for (const [cat, word] of [[en, "Dismiss"], [de, "Ausblenden"]] as const) {
      expect(cat.mailboxes.noticeDismiss).toBe(word);
      for (const k of ["noticeDismissOffline", "noticeDismissInactive", "noticeDismissFailed"] as const) {
        expect(cat.mailboxes[k]).not.toMatch(/read|gelesen/i);
      }
    }
    const el = await mountNotice([fact()], async () => {});
    expect(within(el).getAllByRole("button", { name: en.mailboxes.noticeDismiss }).map((x) => x.textContent)).toEqual(["Dismiss"]);
  });

  it("the shell twin is the same blocks under its own class; no tone class on either", async () => {
    const el = await mountNotice(five(), async () => {});
    const shellNotices = [await showNotice(el, "stopped"), await showNotice(el, "elsewhere")];
    expect(el.querySelector(".rail-notice")).toBeNull();
    for (const block of shellNotices) {
      expect(block.getAttribute("role")).toBe("status");
      expect(block.className, "a notice wore a transient's tone").toBe("oh-notice");
    }
  });

  it("nothing to say draws nothing at all — no slot, no reserved band", async () => {
    const el = await mountNotice([], async () => {});
    expect(withNotice(el).map((item) => item.textContent).join("")).toBe("");
  });
});

describe("a refused Dismiss says why, under the notice that stays (NOTICE-DISMISS-REFUSAL-IS-SILENT)", () => {
  const refusedWith = (status: number, code?: string) => Object.assign(new Error(`${status}`), { status, code });
  const line = (el: HTMLElement) =>
    withNotice(el).flatMap((notice) => Array.from(notice.querySelector("p")?.childNodes ?? []))
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .flatMap((text) => {
        const start = text.indexOf("Couldn't dismiss it");
        return start < 0 ? [] : [text.slice(start).trim()];
      })[0] ?? null;
  const pressDismiss = async (el: HTMLElement) => {
    const b = within(el).getByRole("button", { name: en.mailboxes.noticeDismiss });
    expect(b, "no Dismiss press was drawn").toBeDefined();
    await act(async () => { b!.click(); });
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  };
  /* One row per answer the door can give: the sentence it owes, or none. */
  const table: ReadonlyArray<[string, () => Promise<unknown>, string | null]> = [
    ["503 offline_read_only (the desktop is offline)", async () => { throw refusedWith(503, "offline_read_only"); }, "Couldn't dismiss it — you're offline."],
    ["0 network_unreachable (the browser reached nothing)", async () => { throw refusedWith(0, "network_unreachable"); }, "Couldn't dismiss it — you're offline."],
    ["503 from the server itself", async () => { throw refusedWith(503, "unavailable"); }, "Couldn't dismiss it — try again."],
    ["402 (the account is not active)", async () => { throw refusedWith(402); }, "Couldn't dismiss it — this account is not active."],
    ["a network failure", async () => { throw new TypeError("Failed to fetch"); }, "Couldn't dismiss it — you're offline."],
    ["500 (anything else)", async () => { throw refusedWith(500); }, "Couldn't dismiss it — try again."],
    ["200", async () => ({}), null],
  ];
  for (const [answer, transport, said] of table) {
    it(`${answer}: ${said === null ? "the block goes and nothing is said" : "the notice stays with its sentence"}`, async () => {
      const el = await mountNotice([fact()], transport);
      await pressDismiss(el);
      if (said === null) {
        expect(withNotice(el).map((item) => item.textContent).join(""), "an acknowledged notice stayed").toBe("");
        return;
      }
      expect(el.textContent, "a refused write took the notice off screen").toContain("ohmail Cloud organizes person@example.com now.");
      expect(line(el), "a refused write put the notice back with no sentence").toBe(said);
    });
  }

  it("the notice stays while the write is out, and leaves on its answer", async () => {
    let answer!: () => void;
    const el = await mountNotice([fact()], () => new Promise<void>((r) => { answer = r; }));
    await pressDismiss(el);
    expect(el.textContent, "the notice left before the stamp was written").toContain("person@example.com");
    await act(async () => { answer(); });
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(withNotice(el).map((item) => item.textContent).join("")).toBe("");
  });

  it("the line clears on the next successful write", async () => {
    let refuse = true;
    const el = await mountNotice(
      [fact({ id: "a", address: "a@example.com" }), fact({ id: "b", address: "b@example.com", order: 1 })],
      async () => { if (refuse) throw refusedWith(503, "offline_read_only"); },
    );
    await pressDismiss(el);
    expect(line(el)).toBe("Couldn't dismiss it — you're offline.");
    refuse = false;
    await pressDismiss(el);
    expect(withNotice(el).map((item) => item.textContent).join(""), "the second, accepted press left the block").toBe("");
  });

  it("the line is about the refused change: a later change on the block does not inherit it", async () => {
    const A = fact({ id: "a", address: "a@example.com" });
    const el = await mountNotice([A], async () => { throw refusedWith(503, "offline_read_only"); });
    await pressDismiss(el);
    expect(line(el)).toBe("Couldn't dismiss it — you're offline.");
    await rerenderNotice([]); // another device marked it read; the poll took it away
    await rerenderNotice([fact({ id: "c", address: "c@example.com" })]);
    expect(el.textContent).toContain("c@example.com");
    expect(line(el), "a refusal about another change was said under this one").toBeNull();
  });

  it("a partly refused block keeps the refused row and says why", async () => {
    const el = await mountNotice(
      [fact({ id: "a", address: "a@example.com" }), fact({ id: "b", address: "b@example.com", order: 1 })],
      async (id) => { if (id === "b") throw refusedWith(402); },
    );
    await pressDismiss(el);
    expect(withNotice(el).map((notice) => notice.textContent).join(" ")).toContain("b@example.com");
    expect(withNotice(el).map((notice) => notice.textContent).join(" ")).not.toContain("a@example.com");
    expect(line(el)).toBe("Couldn't dismiss it — this account is not active.");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   3 · A QUEUED DECISION SURVIVES ITS OWN CONFIRM
   ══════════════════════════════════════════════════════════════════════════════════════════ */

let seq = 0;
const sent: EngineMutation[] = [];

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-04T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false,
      priority: false,
    },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-04T09:00:00.000Z",
  };
}

const HELD = msg("h1", "editors@terracereview.invalid", "ohmail/Screener");

/**
 * THE ENGINE A 202 PRODUCES, and every part of this shape is the point.
 *
 * `changes: []` with `seq: null` is what an endpoint that wrote no `change_log` row answers, and
 * the `sync` below returns nothing for the same reason — there is nothing to reconcile, because
 * nothing was filed. That combination is exactly what drops the optimistic overlay. `pendingWith`
 * is the only thing that comes back, and the test is whether the surface holds on to it.
 */
function queueingEngine(store: MirrorStore): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        return { changes: [], seq: null, pendingWith: { name: "ohmail Cloud" } };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

async function freshStore(): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{
    type: "message", op: "create", id: HELD.id, seq: ++seq, updatedAt: HELD.updatedAt,
    entity: HELD,
  }]);
  return store;
}

async function mountQueue(engine: OhmailEngine, queued: PendingDecision[] = []) {
  installShellEnv();
  reset = teardownShellEnv;
  vi.setSystemTime(NOW);
  window.location.hash = "#/screener";
  registerSyncGate(engine, createSyncGate(HELD.accountId));
  confirmSyncOwner(engine, HELD.accountId);
  await engine.start();
  const el = await mountShell([mailbox({
    id: "mb", lastSyncAt: NOW.toISOString(), organizerRole: "reader", organizerChecked: true,
    organizerAcceptsRequests: true, organizedBy: { kind: "cloud", name: "ohmail Cloud", since: EARLIER },
  })], {
    engine, junkWire: "none",
    suggestWire: {
      configured: () => true,
      list: async () => ({
        items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 },
        pendingDecisions: queued.map(({ subject, scope, decidedAt, state, refusedReason }) => ({
          subject, scope, decidedAt, sent: state === "sent",
          state: state === "sent" || state === "refused" ? state : "pending",
          refusedReason,
        })),
      }),
      suggest: async () => { throw new Error("This test does not request suggestions"); },
      messageFor: (_error, fallback) => fallback,
    },
  });
  await shellTick(500);
  return within(el);
}

describe("a decision queued with the organizer does not revert on its own confirm", () => {
  beforeEach(() => { seq = 0; sent.length = 0; });

  it("THE PRESS STANDS after the commit window, and the sender is decided rather than waiting", async () => {
    const engine = queueingEngine(await freshStore());
    const view = await mountQueue(engine);
    const list = within(view.getByRole("listbox", { name: en.screener.title }));
    expect(list.getAllByRole("option"), "the fixture should offer one waiting sender").toHaveLength(1);
    const actions = within(view.getByRole("toolbar", { name: en.screener.place.panel }));
    await shellAct(async () => { actions.getByRole("button", { name: en.screener.pileOhbox }).click(); });
    await shellTick(60_000);
    expect(sent, "the decision never reached the wire").toHaveLength(1);
    const updated = within(view.getByRole("listbox", { name: en.screener.title }));
    const finished = within(updated.getByRole("group", { name: en.screener.pendingHeading }));
    expect(finished.getAllByRole("option"), "the decided sender is not accounted for anywhere").toHaveLength(1);
    expect(updated.getAllByRole("option"), "the sender came back to the waiting queue").toHaveLength(1);
    const decided = finished.getByRole("option", { name: (name) => name.startsWith(HELD.from.address) });
    expect(decided).toBeTruthy();
    await shellAct(async () => { decided.click(); });
    await shellTick(500);
    expect(view.getByRole("region", { name: en.frame.landmark.reading }).textContent).toContain("ohmail Cloud");
    expect(view.queryByText(en.screener.rowNotApplied)).toBeNull();
  });

  it("A DOMAIN-SCOPE decision excludes the domain, which is what the organizer will apply", async () => {
    const view = await mountQueue(queueingEngine(await freshStore()));
    await shellAct(async () => { view.getByRole("button", { name: en.screener.barScopeAria }).click(); });
    await shellAct(async () => { within(document.body).getByRole("menuitemradio", { name: "whole domain" }).click(); });
    await shellAct(async () => {
      within(view.getByRole("toolbar", { name: en.screener.place.panel })).getByRole("button", { name: en.screener.pileOhbox }).click();
    });
    await shellTick(60_000);
    expect(sent).toContainEqual(expect.objectContaining({ kind: "screener_decide", scope: "domain" }));
    expect(view.getByRole("group", { name: en.screener.pendingHeading })).toBeTruthy();
  });

  it("a decision the SERVER already knows about excludes the sender before any press", async () => {
    const view = await mountQueue(queueingEngine(await freshStore()), [
      { subject: HELD.from.address, scope: "sender", decidedAt: EARLIER, holder: null, state: "sent" },
    ]);
    const list = within(view.getByRole("listbox", { name: en.screener.title }));
    expect(list.getAllByRole("option")).toHaveLength(1);
    expect(within(list.getByRole("group", { name: en.screener.pendingHeading })).getAllByRole("option")).toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   4 · AND A REFUSAL SAYS SO, IN THE ORGANIZER'S OWN WORDS OR IN THE ONE KEPT FOR THE REST
   ══════════════════════════════════════════════════════════════════════════════════════════ */

function viewStateWith(decision: PendingDecision): ScreenerState {
  const sender = {
    id: "s1",
    from: { name: "Terrace Review", address: "editors@terracereview.invalid" },
    initial: "T",
    derived: true,
    scope: "sender" as const,
    ai: null,
    time: "09:00",
    held: [{
      id: "h1", subject: "Spring issue", time: "09:00", body: "body", html: null,
      bodyState: "ready" as const, unsubscribe: "no_header" as const, unsubscribeUrl: null,
      trackerNote: null,
    }],
  };
  return {
    suggestedCount: 0, suggestedDests: [],
    unsuggestedSenders: [], suggestedSenders: [], applying: null,
    screenedOut: [], spam: [],
    isExiting: () => false, refused: () => false, bodyStall: () => null,
    decide: () => {}, applyAll: () => {}, markAllSpam: () => {},
    allowScreened: () => {}, notSpamToWaiting: () => {}, notSpamToOhbox: () => {},
    deleteSpam: () => {}, flush: () => {},
    waitingSource: "store", waitingMore: { available: false, loading: false, failed: false, load: () => {} }, rereadWaiting: () => {},
    role: { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false },
    pending: [decision],
    /* THE TWO LISTS ARE THE CLAIM. An outstanding decision takes the sender out of the queue and
       under the heading; a REFUSED one puts them back in it with the reason beside them, because
       the organizer answered no and the question is open again. A double that put a refusal in
       `decided` would be testing a surface this build does not have. */
    ...(decision.state === "refused"
      ? { waiting: [sender], waitingCount: 1, decided: [], notApplied: [{ sender, decision }] }
      : { waiting: [], waitingCount: 0, decided: [{ sender, decision }], notApplied: [] }),
  } as unknown as ScreenerState;
}

async function mountDecided(decision: PendingDecision): Promise<HTMLElement> {
  const { view } = mountPlace(modelOf({ flushes: 0 }, viewStateWith(decision)));
  await act(async () => { await Promise.resolve(); });
  const row = view.getByRole("option", { name: /^Terrace Review:/ });
  await act(async () => { row.click(); });
  return view.container;
}

const decided = (over: Partial<PendingDecision> = {}): PendingDecision => ({
  subject: "editors@terracereview.invalid", scope: "sender", decidedAt: LATER,
  holder: "ohmail Cloud", state: "sent", ...over,
});

describe("what the pane says about a decision the organizer has not carried out", () => {
  it("waiting: it names the machine that owes it, and the sender sits under its own heading", async () => {
    const el = await mountDecided(decided());
    const text = el.textContent ?? "";
    expect(text).toContain(en.screener.pendingHeading);
    expect(within(el).queryByRole("group", { name: en.screener.pendingHeading }), "the decided row is not marked as one").not.toBeNull();
    expect(text).toContain("ohmail Cloud");
  });

  it("REFUSED: THE SENDER IS BACK IN THE QUEUE, with the reason beside them", async () => {
    /* The inversion the third state brought, and the property most worth pinning: the organizer
       answered NO, so nothing was filed and the question is open again. Excluding the sender here
       would hide a question the person now has to answer a second time — and the sender would
       come back on the next poll anyway, looking exactly as they did before anybody pressed. */
    const el = await mountDecided(decided({ state: "refused", refusedReason: "conflict" }));
    const text = el.textContent ?? "";
    expect(text, "the refusal is not explained").toContain(en.screener.pendingReason_conflict);
    expect(text, "a refused sender was filed under the decided heading")
      .not.toContain(en.screener.pendingHeading);
    expect(within(el).queryByRole("group", { name: en.screener.pendingHeading }), "a refused sender was drawn as a decided one")
      .toBeNull();
    expect(within(el).queryByText(en.screener.pendingReason_conflict, { exact: false }),
      "the refusal was not set apart from a decision still waiting").not.toBeNull();
    expect(text, "the row does not say its decision was declined")
      .toContain(en.screener.rowNotApplied);
  });

  it("…and a reason this build has never heard of is still reported as a refusal", async () => {
    /* The organizer's vocabulary can grow without a client release. The failures to avoid are a
       raw token on screen and a `MISSING_MESSAGE` rendering the dotted key — both of which say
       nothing to the person and hide that the decision did not land. A refusal with NO reason is
       the same case. */
    const el = await mountDecided(decided({ state: "refused", refusedReason: "some_future_reason" }));
    const text = el.textContent ?? "";
    expect(text).toContain(en.screener.pendingRefusedUnknown);
    expect(text, "a raw token reached the screen").not.toContain("some_future_reason");
    expect(text, "a missing key rendered its own path").not.toContain("pendingReason_");
  });

  it("a refusal the organizer did not explain still says the decision did not land", async () => {
    const el = await mountDecided(decided({ state: "refused", refusedReason: null }));
    expect(el.textContent ?? "").toContain(en.screener.pendingRefusedUnknown);
  });
});
