/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder, MessageBodyWire, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import { TextProvider } from "@ohmail/app/text";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import {
  ACCOUNT, ISO, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

// Gate-held mail sends a Screener decision. Mail already in INBOX needs a rule instead.
const h = React.createElement;
const { act } = React;
const NOW = new Date("2026-08-02T12:00:00.000Z");
let seq = 0;

function msg(id: string, from: string, folder: Folder, name: string | null = null): EngineMessage {
  return {
    id,
    accountId: ACCOUNT,
    mailboxId: "mb_1",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name, address: from },
    to: [],
    cc: [],
    date: `2026-08-02T0${id.length % 8}:00:00.000Z`,
    folder,
    snippet: `snippet ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

let sent: EngineMutation[] = [];
/** Message ids whose body the engine asked the wire for. */
let bodiesFetched: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/**
 * An engine over a mirror of held mail, wired to an adapter that RECORDS every mutation
 * and echoes its effects back as authoritative changes — the shape the real server
 * produces (per-message `move` + a `rule` create).
 */
async function engineWith(held: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    held.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
  );
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(),
        hasMore: false,
        serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` }).map((e) => ({
          type: e.type,
          op: e.move ? "move" : "update",
          id: e.id,
          seq: ++seq,
          updatedAt: NOW.toISOString(),
          entity: e.entity,
          ...(e.move ? { move: e.move } : {}),
        }));
        // Applied HERE, before returning, so a second concurrent mutation computes its
        // own effects against a world that already contains this one. The real server
        // needs no such care: `/sync` materializes a message DTO from current DB state
        // at read time (`dto/materialize.ts:41`), not from a snapshot taken when the
        // change was recorded, so an in-flight PATCH cannot resurrect a stale folder.
        // The engine re-applies the same changes idempotently.
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      /**
       * The body endpoint, recorded. A derived row's held mail carried the
       * SNIPPET before this slice, which made `ScreenerSenderDTO.held`'s own promise — "every
       * held message, in full" — false on exactly the accounts that pay for it.
       */
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async (id): Promise<MessageBodyWire> => {
        bodiesFetched.push(id);
        return {
          text: `FULL BODY of ${id}\nsecond paragraph`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
        };
      },
    },
  });
}

/** Mount a probe that runs the real hook and hands its state back to the test. */
async function mountState(engine: OhmailEngine): Promise<{ get: () => ScreenerStateLike }> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  let latest: ScreenerStateLike | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(engine, null, v, (() => {}) as never, useScreenerWords()) as unknown as ScreenerStateLike;
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(TextProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(Probe),
      }),
    );
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  return { get: () => latest! };
}

interface ScreenerStateLike {
  waiting: Array<{
    id: string;
    from: { address: string };
    held: Array<{ id: string; body: string; bodyState?: string }>;
    derived?: true;
    ai: unknown;
  }>;
  waitingCount: number;
  suggestedCount: number;
  spam: Array<{ sender: { from: { address: string } }; pinned: boolean }>;
  decide: (sender: unknown, dest: string, opts: { read: boolean; scope: string }) => void;
  applyAll: (scopeOf: (s: unknown) => string) => void;
  markAllSpam: (scopeOf: (s: unknown) => string) => void;
  flush: () => void;
}

/** `screener-state.ts` BULK_STEP_MS — a bulk decides one sender every 240 ms. */
const BULK_STEP_MS = 240;

/**
 * Settle a BULK of `n` senders.
 *
 * `settle()` is not enough and fails in the direction that looks like a product bug: the
 * last sender is decided at `(n-1) * 240 ms` and only then starts its own 6 200 ms undo
 * window, so a plain `settle()` catches the first commit and misses the rest.
 */
async function settleBulk(n: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(n * BULK_STEP_MS + COMMIT_MS + 500);
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

const HELD = [
  msg("m1", "lena@atelier.example", "ohmail/Screener"),
  msg("m2", "lena@atelier.example", "ohmail/Screener"),
  msg("m3", "win@jackpot.example", "ohmail/Screener"),
];

beforeAll(warmCloudShell);
let webMounted = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Element.prototype.animate ??= (() => ({
    cancel() {}, finished: Promise.resolve(),
  })) as unknown as Element["animate"];
  sent = [];
  bodiesFetched = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  if (webMounted) await teardownConfirmEnv();
  webMounted = false;
  vi.useRealTimers();
});

async function click(button: HTMLElement): Promise<void> {
  await act(async () => { button.click(); });
  await tick(50);
}

type WebWrite = { method: string; path: string; body: unknown };
async function mountWeb(
  mail: readonly EngineMessage[],
  { section = "", refuse = false, advice = false }: {
    section?: string; refuse?: boolean; advice?: boolean;
  } = {},
) {
  installConfirmEnv();
  webMounted = true;
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  const creates: SyncResponse["changes"]["creates"] = mail.map((entity, index) => ({
    type: "message", op: "create", id: entity.id, seq: index + 1, updatedAt: ISO, entity,
  }));
  scriptSync(() => Response.json({
    changes: { creates, updates: [], moves: [], deletes: [] },
    cursor: String(creates.at(-1)?.seq ?? 0), hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));
  const reply = (body: unknown, init?: ResponseInit) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Ohmail-Account", ACCOUNT);
    return Response.json(body, { ...init, headers });
  };
  const fetchForAccount = globalThis.fetch;
  const writes: WebWrite[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/mailboxes") {
      return reply({ items: [{
        id: "mb_1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    if (advice && method === "GET" && path === "/api/screener") {
      const seed = mail[0]!;
      return reply({
        items: [{
          id: seed.id, messageId: seed.id, sender: seed.from, subject: seed.subject,
          snippet: seed.snippet, receivedAt: seed.date, aiSuggestion: {
            decision: "yes", destination: "ohmail/News", confidence: 0.88,
            rationale: "a studio newsletter you have kept before",
          },
        }],
        nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 },
      });
    }
    if (method === "GET" && path.endsWith("/body")) {
      return new Response(null, { status: 503 });
    }
    if (method === "GET" || !/^\/api\/(rules|messages|screener)(?:\/|$)/.test(path)) {
      return fetchForAccount(input, init);
    }
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));
    writes.push({ method, path, body });
    if (method === "POST" && path === "/api/rules") {
      if (refuse) {
        return reply({
          error: { code: "forbidden", message: "rule refused", retryable: false },
        }, { status: 403 });
      }
      const entity = {
        id: "new-rule", kind: body.kind, match: body.match, destination: body.destination,
        priority: 0, enabled: true, provenance: "manual",
        stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
      };
      const seq = creates.length + 1;
      creates.push({ type: "rule", op: "create", id: entity.id, seq, updatedAt: ISO, entity });
      return reply(entity, { status: 201, headers: { "x-sync-seq": String(seq) } });
    }
    if (method === "POST" && /^\/api\/screener\/[^/]+$/.test(path)) {
      return reply({ messageId: path.split("/").at(-1), appliedFolder: body.dest, createdRuleId: null });
    }
    return reply({ error: { code: "not_found", message: "unexpected write", retryable: false } }, { status: 404 });
  };
  window.location.hash = advice ? "#/ohbox" : `#/screener${section ? `/${section}` : ""}`;
  const shell = await mountCloudShell();
  await tick(3000);
  const frame = within(shell);
  if (advice) {
    const rail = within(frame.getByRole("navigation", { name: "Places" }));
    await click(rail.getByRole("button", { name: /^Screener/ }));
    await tick(1000);
  }
  const copy = messages.screener;
  const list = () => within(frame.getByRole("listbox", { name: copy.title }));
  const rows = () => list().getAllByRole("option");
  const panel = () => within(frame.getByRole("toolbar", { name: copy.place.panel }));
  const open = async (address?: string) => {
    const row = rows().find((node) => !address || (node.textContent ?? "").includes(address));
    expect(row, "the sender is on the Screener list").toBeTruthy();
    await click(row!);
    return row!;
  };
  return { shell, frame, panel, rows, open, writes };
}

function reports(): string[] {
  return [...document.querySelectorAll('.fr-report [role="status"]')].map((node) => node.textContent ?? "");
}

const copy = messages.screener;
const page = () => within(document.body);
async function pressOhbox(s: Awaited<ReturnType<typeof mountWeb>>, address: string) {
  await s.open(address);
  await click(s.panel().getByRole("button", { name: /^Ohbox/ }));
  await tick(COMMIT_MS + 800);
}

const kinds = (k: string) => sent.filter((m) => m.kind === k);

/**
 * "APPLY ALL SUGGESTIONS" OVER AN EMPTY SET.
 *
 * Reported from live use: *"screener shows me 'apply all suggestions', but on
 * the actual mails I don't see what that suggestion would even be"*.
 *
 * He was seeing the truth. `selectors.ts` mints `ai: null` for every DERIVED row — which is
 * every row on a Cloud account — because `/sync` carries no suggestion and no classifier is
 * constructed in production (`apps/api-vercel/src/deps.ts:174-178`). Confirmed against the
 * production database on 2026-08-04: a long queue of waiting senders and many held messages in
 * one mailbox, and ZERO `routing_decisions` rows joined to any held message, of any
 * provenance — so the suggestion was not merely unrendered, it did not exist, and no
 * rule-derived reason existed either.
 *
 * What made it a defect rather than a gap: `applyAll` read `x.ai?.dest ?? "ohbox"`. The
 * fallback decided every row. One press was "accept all the strangers into the Ohbox and
 * promote a rule for each", labelled as applying suggestions the user had never seen — a
 * consent gate granting consent on its own.
 */
describe("the Screener may not offer a suggestion it does not have", () => {
  it("a derived row has NO suggestion, so `suggestedCount` is 0 while senders wait", async () => {
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);

    expect(get().waitingCount).toBe(2);
    expect(get().waiting.every((s) => s.ai === null)).toBe(true);
    // The whole point: these two numbers are independent. Gate the button on the first and
    // it appears with nothing behind it.
    expect(get().suggestedCount).toBe(0);
  });

  it("THE GUARD — applyAll with no suggestions puts NOTHING on the wire", async () => {
    /**
     * Red by restoring the fallback in `screener-state.ts`:
     *   (x) => (x.ai?.dest ?? "ohbox") as DecisionDestination
     * and dropping the `(x) => x.ai != null` filter passed to `bulk`. Both senders are then
     * decided `yes` to INBOX and this fails on the first assertion — which is exactly what
     * shipped, at a whole queue of senders instead of 2.
     */
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);

    await act(async () => { get().applyAll(() => "sender"); });
    await settleBulk(2);

    expect(kinds("screener_decide")).toEqual([]);
    expect(kinds("move")).toEqual([]);
    expect(kinds("mark_seen")).toEqual([]);
    // And the queue is untouched — nobody was silently let in.
    expect(get().waitingCount).toBe(2);

    const s = await mountWeb(HELD);
    const row = s.rows()[0]!;
    await act(async () => {
      row.focus();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    await tick(COMMIT_MS + 800);
    const tools = within(s.frame.getByRole("group", { name: copy.bulkAria }));
    expect(tools.queryByRole("button", { name: /^Apply/ })).toBeNull();
    expect(s.writes).toEqual([]);
    expect(s.rows()).toHaveLength(2);
  });

  it("`Mark all spam` still works — it never claimed to apply a suggestion", async () => {
    // The fix must not sedate the honest control next to the dishonest one. `markAllSpam`
    // says what it does and stays available.
    const s = await mountWeb(HELD);
    const tools = within(s.frame.getByRole("group", { name: copy.bulkAria }));
    await click(tools.getByRole("button", { name: copy.place.listMenu }));
    const menu = page().getByRole("menu", { name: copy.place.listMenu });
    await click(within(menu).getByRole("menuitem", { name: copy.markAllSpam }));
    const ask = page().getByRole("dialog");
    expect(s.writes).toEqual([]);
    await click(within(ask).getByRole("button", { name: /^Mark.*spam/i }));
    await tick(COMMIT_MS + 2 * BULK_STEP_MS + 800);
    const decisions = s.writes.filter(({ path }) => path.startsWith("/api/screener/"));
    expect(decisions).toHaveLength(2);
    expect(decisions.every(({ body }) => (body as { decision: string }).decision === "no")).toBe(true);
  });

  it("the button is NOT RENDERED, and the preview says why there is nothing to apply", async () => {
    /**
     * Red by gating the control on `state.waitingCount > 0` again (its shipped condition):
     * "Apply …" reappears over an empty set. The sender's place slot stays open to a choice.
     */
    const s = await mountWeb(HELD);
    await s.open();
    const tools = within(s.frame.getByRole("group", { name: copy.bulkAria }));
    expect(tools.queryByRole("button", { name: /^Apply/ })).toBeNull();
    await click(tools.getByRole("button", { name: copy.place.listMenu }));
    expect(page().getByRole("menuitem", { name: copy.markAllSpam })).toBeTruthy();
    expect(s.frame.getByText(copy.place.nowhere, { exact: true })).toBeTruthy();
    expect(s.frame.queryByText(/No suggestion/)).toBeNull();
    expect(s.shell.textContent).not.toContain("accept suggestion");
  });

  /**
   * THE OTHER HALF OF THE CONTRACT — the fix must not be "hide it always".
   *
   * A gate that never opens is indistinguishable from deleting the feature, and it would
   * silently swallow the suggestions that WILL exist once they are persisted and generated
   * by an explicit, user-pressed, credit-costing action. So: seed one row that HAS a
   * suggestion, and require the surface to show the destination, the confidence and the
   * rationale in plain words — which is what "Every mail says why" is judged against.
   *
   * `screener_sender` rows win per sender key in `screenerSegments`, so this is also the
   * shape a persisted suggestion will arrive in.
   */
  it("a row that HAS a suggestion shows it — destination, confidence and why", async () => {
    const s = await mountWeb(HELD, { advice: true });
    const row = await s.open(HELD[0]!.from.address);
    const tools = within(s.frame.getByRole("group", { name: copy.bulkAria }));
    expect(tools.getByRole("button", { name: "Apply 1" })).toBeTruthy();
    expect(row.textContent).toContain("News");
    const reading = within(s.frame.getByRole("region", { name: "Reading" }));
    expect(reading.getByText(/0\.88|88%/)).toBeTruthy();
    expect(reading.getByText(/a studio newsletter you have kept before/)).toBeTruthy();
  });
});

describe("a derived Screener row decides over the real wire vocabulary", () => {
  it("held mail starts as a SNIPPET and says so — it does not pass as the whole message", async () => {
    /**
     * The state this slice found, asserted so it cannot be mistaken for the fixed one.
     *
     * `heldOf` used to answer `m.body ?? m.snippet` and call the snippet "a stated
     * degradation". It was stated in a comment nobody reading the Screener could see, and
     * what the surface rendered was one line of a stranger's first email presented as all
     * they had written — with a consent decision hanging off it.
     *
     * `bodyState` is what makes the difference legible. Red by having `bodyOf` return a bare
     * string again: `bodyState` goes undefined, and undefined means `full` to every surface.
     */
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);
    // Sorted by id: the segment orders SENDERS newest-first, and this claim is about every
    // held message rather than about the queue's order (which `held.length` above covers).
    const held = get().waiting.flatMap((s) => s.held).sort((a, b) => a.id.localeCompare(b.id));
    expect(held.map((h) => h.bodyState)).toEqual(["snippet", "snippet", "snippet"]);
    expect(held.map((h) => h.body)).toEqual(["snippet m1", "snippet m2", "snippet m3"]);
    // Nothing has been asked for: the SELECTOR never fetches. Hydration is an act of the
    // surface somebody is looking at, not a side effect of deriving a queue.
    expect(bodiesFetched).toEqual([]);
  });
});

/**
 * ═══ #116 — A PRESENTED-IN-SCREENER SENDER DECIDES PAST THE GATE (A.ii) ══════════════════
 *
 * The live bug: a sender's messages were bulk-moved Screener→INBOX; unread (⇒ active) and
 * unruled (⇒ undecided), so the cutline PRESENTS them at the gate. A `screener_decide` on such a
 * rep is a no-op that claims success — `derivedScreenerEffects` returns nothing, so `Engine.mutate`
 * rolls it back with nothing sent and the wire would 404 it. The screen-in never committed, and the
 * sender was nowhere but search.
 *
 * The commit now re-reads the RAW mirror: a rep that only PRESENTS at the gate is routed through the
 * sender sheet's past-the-gate ladder — `rule_create` (destination INBOX) asking no past-mail answer
 * (ruled: the card files what it shows), AWAITED so the toast follows the server. These are the state-level guards; `sender-screening.test.ts`
 * pins the plan/dispatch pure functions this leans on.
 */
describe("#116 — an active-undecided INBOX sender commits a rule, not a dead decide", () => {
  const CAROLINE = [
    msg("c1", "blasz.caroline@gmail.test", "INBOX"),
    msg("c2", "blasz.caroline@gmail.test", "INBOX"),
  ];

  const address = CAROLINE[0]!.from.address;

  it("presents as a waiting row over the projected reader — the row that used to vanish", async () => {
    const s = await mountWeb(CAROLINE);
    expect(s.rows().map((row) => row.textContent).join(" ")).toContain(address);
  });

  it("committing it dispatches rule_create → INBOX (no past-mail answer), and NO screener_decide", async () => {
    const s = await mountWeb(CAROLINE);
    await pressOhbox(s, address);
    expect(s.writes).toEqual([{
      method: "POST", path: "/api/rules",
      body: { kind: "sender", match: address, destination: "INBOX", applyRetro: false },
    }]);
  });

  it("the sender's bag presents in the Ohbox once the rule echoes back — zero server moves", async () => {
    const s = await mountWeb(CAROLINE);
    await pressOhbox(s, address);
    expect(s.writes.filter(({ path }) => path.endsWith("/move"))).toEqual([]);
    expect(s.frame.queryAllByRole("option").map((row) => row.textContent).join(" ")).not.toContain(address);
    const rail = within(s.frame.getByRole("navigation", { name: "Places" }));
    await click(rail.getByRole("button", { name: /^Ohbox/ }));
    expect(s.frame.getByRole("option", { name: /Subject c1/ })).toBeTruthy();
    expect(s.frame.getByRole("option", { name: /Subject c2/ })).toBeTruthy();
  });

  it("a refused rule says the rule couldn't be made — never 'Ruled' over nothing", async () => {
    const s = await mountWeb(CAROLINE, { refuse: true });
    await pressOhbox(s, address);
    expect(s.writes.filter(({ path }) => path === "/api/rules")).toHaveLength(1);
    expect(reports().some((text) => /couldn.t be made/i.test(text))).toBe(true);
    expect(reports().some((text) => /files there too/i.test(text))).toBe(false);
  });
});

/**
 * ═══ THE SHEET, READ BY A HUMAN ════════════════════════════════════════════════
 *
 * Walked at desktop and phone widths on a live account. Four defects, one cause: every fact
 * the sheet needed to state was stated somewhere ELSE — the destination keys in a `title`
 * attribute and in a legend in the opposite corner, the ✓ half's meaning in a note, the
 * sender's identity in a field the view read and threw away.
 *
 * These assertions are on the DERIVED shape, i.e. every row on a live account, because that
 * is where the name-dropping was invisible in the demo: every screened and spam FIXTURE is
 * an address with no display name, so nothing on a fixture account could have shown it.
 */
describe("the Screener sheet says what it does", () => {
  const NAMED = [
    msg("m1", "lena@atelier.example", "ohmail/Screener", "Anna Keller"),
    msg("m2", "promo@fashion.example", "ohmail/Screened", "Fashion Deals AG"),
    msg("m3", "crypto@win-invest.example", "ohmail/Quarantine", "Bonus Team"),
  ];

  it.each([
    ["waiting", "Anna Keller", "lena@atelier.example"],
    ["screened", "Fashion Deals AG", "promo@fashion.example"],
    ["spam", "Bonus Team", "crypto@win-invest.example"],
  ] as const)(
    "%s shows the display name AND the address — both, everywhere",
    async (segment, name, address) => {
      /**
       * THE GUARD. The screened and spam branches read `from={w.from.address}` and dropped
       * `from.name` on the floor, in the row AND in every held message under it. Put either
       * one back and this goes red on the name.
       *
       * Both are load-bearing and for different reasons: the name is the screening signal —
       * it is how a human recognises a stranger worth letting through — and the address is
       * what keeps that judgement spoof-safe. A surface that shows one and hides the other
       * is asking for consent on half the evidence.
       */
      const s = await mountWeb(NAMED, { section: segment === "waiting" ? "" : segment });
      const row = await s.open(address);
      expect(row.textContent).toContain(name);
      expect(row.textContent).toContain(address);
      const held = s.frame.getByRole("button", { name: `${name} ${address}` });
      expect(held.textContent).toContain(name);
      expect(held.textContent).toContain(address);
    },
  );

  it("a sender with no display name still renders ONE identity, not an empty line", async () => {
    // The other half of the contract: `HELD`'s senders have `name: null`, which is the shape
    // every fixture account has. `MessageRow`/`HeldMail` are given the address as `from` and
    // no `address` at all, so nothing renders twice and nothing renders blank.
    const s = await mountWeb(HELD);
    const address = HELD[0]!.from.address;
    await s.open(address);
    const reading = within(s.frame.getByRole("region", { name: "Reading" }));
    const held = reading.getAllByRole("button", { name: address })
      .find((button) => button.hasAttribute("data-sender-line"));
    const who = held?.querySelector(".oh-messagehead-who");
    expect(who?.textContent?.trim()).toBe(address);
    expect(who?.querySelector(".oh-messagehead-address")).toBeNull();
  });

  it("decision buttons show their keys and More offers only the three read variants", async () => {
    // the rule, reaching the surface it had missed: the key is on the verb it fires.
    // Before this, `o`/`r`/`c`/`n`/`x` existed only inside `title` attributes. The demoting
    // destinations (Screen out `n`, Spam `x`) file but carry NO ✓ — you don't read what you
    // triage out — so their capsule has the letter and no shifted twin. SCR-READBOX.
    const s = await mountWeb(HELD);
    await s.open();
    const caps = (element: HTMLElement) => [...element.querySelectorAll("kbd")].map((key) => key.textContent);
    const buttons = s.panel().getAllByRole("button");
    expect(buttons.flatMap(caps)).toEqual(["o", "r", "c", "n", "x"]);
    await click(s.panel().getByRole("button", { name: copy.place.more }));
    const menu = page().getByRole("menu", { name: copy.place.more });
    const read = within(menu).getAllByRole("menuitem").filter((item) => /mark read/i.test(item.textContent ?? ""));
    expect(read.flatMap(caps)).toEqual(["⇧O", "⇧R", "⇧C"]);
  });

  it("the keyboard sheet shows the registered sender navigation", async () => {
    const s = await mountWeb(HELD);
    const key = async (target: HTMLElement, name: string) => {
      await act(async () => {
        target.focus();
        target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
      });
      await tick(50);
    };
    const [first, last] = s.rows();
    await click(first!);
    await key(first!, "?");
    const sheet = () => page().getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet()).getByText("Next sender")).toBeTruthy();
    await key(sheet(), "Escape");
    await click(last!);
    await key(last!, "?");
    expect(within(sheet()).getByText("Previous sender")).toBeTruthy();
  });


  it("nothing in the sheet is called a door", async () => {
    // "Pick a door." was the whole of the no-suggestion line's instruction, and the sheet
    // never calls anything a door — the capsules beside it say Ohbox, Reads, Receipts,
    // Screen out, Spam. The marketing page keeps the metaphor, where its hero establishes it.
    const s = await mountWeb(HELD);
    await s.open();
    expect(s.frame.getByText(copy.place.nowhere, { exact: true })).toBeTruthy();
    expect(s.frame.queryByText(/No suggestion/)).toBeNull();
    expect(s.shell.textContent).not.toMatch(/\bdoor\b/i);
  });

  it("the rule disclosure still leads the note, and both halves are now named", async () => {
    const s = await mountWeb(HELD);
    const sender = HELD[0]!.from;
    await s.open(sender.address);
    expect(s.frame.getByRole("heading", { name: `${sender.name ?? sender.address} goes to a place` })).toBeTruthy();
    const panel = s.panel();
    expect(panel.getByRole("button", { name: "Ohbox" })).toBeTruthy();
    await click(panel.getByRole("button", { name: "More" }));
    const other = within(document.body).getByRole("menu", { name: "More" });
    expect(within(other).getByRole("menuitem", { name: "Ohbox, mark read" })).toBeTruthy();
  });
});
