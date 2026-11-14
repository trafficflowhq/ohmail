/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  MutationRejectedError,
  consentPartition,
  mutationEffects,
  presentationReader,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MessageBodyWire,
  type SyncChange,
} from "@ohmail/client-engine";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";

/**
 * THE SCREENER ON A CLOUD ACCOUNT — what the surface dispatches for a DERIVED
 * row, which is every row on a live account.
 *
 * `POST /screener/:id` takes `{ decision, dest, scope }` and resolves `:id` only against mail
 * still held in `ohmail/Screener`. All five destinations come out of that one call; only the
 * "& read" modifier is composed on top, as a `mark_seen` batch, because it is a flag and not a
 * folder. These assertions are on the MUTATIONS the engine's adapter receives, i.e. on what the
 * server would actually be asked to do.
 *
 * ── THIS HEADER USED TO DESCRIBE THE DEFECT AS THE DESIGN (SCR-READ) ─────────────────────
 *
 * It read: *"it takes `{ decision, scope }`, files a yes to INBOX and a no to
 * `ohmail/Screened` … so the surface composes the remainder out of `move`"*. That composition
 * did not survive contact with the server: `decide` reads its held rows outside its
 * transaction and writes `desired_folder` inside it, so a `move` landing in that window was
 * stamped back to the default. In use it left four `promoted → INBOX` rules and dozens of
 * bulletins in the Ohbox for senders admitted with **Reads**, under a toast that said their
 * mail was filed to Reads and that future mail would follow.
 *
 * Get this wrong in the obvious way — reuse the old "yes unless screened" mapping — and
 * marking a sender spam files their mail into the Ohbox on a paying account.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom implements neither scroll method, and `ScreenerView` calls both — the preview
 * scrolls to top when the selection changes, and `j`/`k` scroll the cursor into view.
 * Stubbed rather than guarded around in the product: they are real browser APIs and the
 * view is right to call them. Same reasoning as the `CSS.escape` shim in
 * `shell-screening-bulk.test.ts`.
 */
Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
/** Desktop viewport: `selectRow` consults this to decide whether to go full-screen. */
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const NOW = new Date("2026-08-02T12:00:00.000Z");
/*
 * `COMMIT_MS` — the undo window before a decision reaches the wire — is IMPORTED at the top of
 * this file, not declared here. It used to be `const COMMIT_MS = 6200`, a hand-transcribed
 * duplicate of a number `screener-state.ts` owns. A later change moved the real one to 8400 and this file
 * noticed by going red, which is the good case. The bad case is a copy that drifts DOWN: a test
 * advancing 6200 ms against a 9000 ms commit asserts "nothing has reached the wire yet" and
 * passes for the wrong reason, for ever.
 */

let seq = 0;

function msg(id: string, from: string, folder: Folder, name: string | null = null): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
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
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  let latest: ScreenerStateLike | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText()) as unknown as ScreenerStateLike;
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: NOW,
        children: h(Probe),
      }),
    );
  });
  await settleFirstPaint();
  return { get: () => latest! };
}

/**
 * Mount the hook with the PROJECTED reader — the live-account wiring `AppShell` uses (#116).
 *
 * `mountState` above builds the queue from the raw mirror, so its rows are always gate-physical.
 * This one hands `useScreenerState` the same `presentationReader(engine.read(), consentPartition(…))`
 * the shell does, so an active-undecided sender whose mail is physically in the INBOX PRESENTS in
 * the Screener as a `gatePhysical:false` waiting row — the exact bulk-moved shape the bug is about.
 * The toast is captured so the past-the-gate branch's sentence can be read.
 */
async function mountProjected(
  engine: OhmailEngine,
  toastFn: (message: string) => void = () => {},
): Promise<{ get: () => ScreenerStateLike }> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  let latest: ScreenerStateLike | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    const reader = engine.read();
    const presented = presentationReader(reader, consentPartition(reader, { now: NOW }));
    latest = useScreenerState(
      engine, null, v, toastFn as never, useScreenerText(), undefined, presented,
    ) as unknown as ScreenerStateLike;
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe),
      }),
    );
  });
  await settleFirstPaint();
  return { get: () => latest! };
}

/**
 * An engine whose adapter REFUSES `rule_create` (403, non-retryable) and echoes everything else —
 * the shape a live 403 takes. `Engine.mutate` turns a non-retryable rejection into `rolled_back`,
 * which is what makes `dispatchScreeningChange` pick the failure sentence rather than "Ruled".
 */
async function engineRefusing(messages: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    messages.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
  );
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
        if (m.kind === "rule_create") {
          throw new MutationRejectedError("rule refused", { status: 403, retryable: false });
        }
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` }).map((e) => ({
          type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
          updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async (id): Promise<MessageBodyWire> => ({
        text: `FULL BODY of ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

/** `settle()`, then extra microtask turns for the AWAITED past-the-gate dispatch + its toast. */
async function settleAwaited(): Promise<void> {
  await settle();
  for (let i = 0; i < 16; i++) await act(async () => { await Promise.resolve(); });
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

/**
 * Mount the REAL `ScreenerView` over a derived engine — the live-account shape.
 *
 * The state-level guards below prove `applyAll` does nothing; this proves the user is
 * never invited to press it in the first place. `KeymapProvider` is required because the
 * view registers its own bindings (`a`, Enter, o/r/c/n/x) through the registry.
 */
async function mountView(
  engine: OhmailEngine,
  segment: "waiting" | "screened" | "spam" = "waiting",
): Promise<void> {
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  const { useScreenerText } = await import("../app/shell/screener-text.js");
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  const { useKeyBindings } = await import("@ohmail/app-logic/keys/keymap");
  const { KeymapProvider } = await import("@ohmail/app/keys");

  function Probe(): React.ReactElement {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    // AppShell's `?`, in miniature — without it the pane-foot `ShortcutHint` correctly
    // renders nothing (`useBinding`: no `?` in the registry means no hint to advertise).
    useKeyBindings(
      [{ chord: "?", group: "app", label: "Keyboard shortcuts", run: () => {} }],
      "global",
    );
    const state = useScreenerState(engine, null, v, (() => {}) as never, useScreenerText());
    const [sel, setSel] = React.useState<Record<string, string | null>>({
      waiting: null, screened: null, spam: null,
    });
    return h(ScreenerView, {
      owed: false,
      state,
      segment,
      selection: sel as never,
      onSelect: (seg: string, id: string | null) => setSel((m) => ({ ...m, [seg]: id })),
      hydrateBody: () => {}, hydrateBodies: () => {},
      full: false,
      onFull: () => {},
    } as never);
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  await settleFirstPaint();
}

/** Let the undo window close and every dispatched promise settle. */
async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(COMMIT_MS + 50);
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
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

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  bodiesFetched = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

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
  });

  it("`Mark all spam` still works — it never claimed to apply a suggestion", async () => {
    // The fix must not sedate the honest control next to the dishonest one. `markAllSpam`
    // says what it does and stays available.
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);

    await act(async () => { get().markAllSpam(() => "sender"); });
    await settleBulk(2);

    expect(kinds("screener_decide")).toHaveLength(2);
    expect(kinds("screener_decide").every((m) => (m as { decision: string }).decision === "no")).toBe(true);
  });

  it("the button is NOT RENDERED, and the preview says why there is nothing to apply", async () => {
    /**
     * Red by gating the control on `state.waitingCount > 0` again (its shipped condition):
     * "Apply …" reappears over an empty set. Red the other way by deleting the
     * `scn-why-none` branch: the preview goes back to saying nothing at all, which is the
     * state reported — a bulk control referring to something the surface never
     * mentions.
     */
    const engine = await engineWith(HELD);
    await engine.start();
    await mountView(engine);

    const bulk = host!.querySelector(".scn-bulk")!;
    expect(bulk, "the bulk row should still exist for Mark all spam").toBeTruthy();
    const labels = [...bulk.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(labels.some((l) => /suggestion/i.test(l)), labels.join(" · ")).toBe(false);
    expect(labels.some((l) => /Mark all spam/.test(l)), labels.join(" · ")).toBe(true);

    // The absence is STATED, in the preview where the AI rationale would have been.
    const why = host!.querySelector(".scn-why-none");
    expect(why?.textContent ?? "").toContain("No suggestion");

    // And the hint bar no longer advertises an accept key. `y` was never bound in this app
    // at all — `DecisionBar` owns that chord behind a `keyboard` prop this view stopped
    // passing — so the old hint named a key that did nothing, for a suggestion that did not
    // exist. Red by restoring the unconditional `<Kbd>y</Kbd> accept suggestion` span.
    expect(host!.textContent ?? "").not.toContain("accept suggestion");
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
    const engine = await engineWith(HELD);
    await engine.start();
    await engine.store.applyChanges([
      {
        type: "screener_sender",
        op: "create",
        id: "s-lena",
        seq: ++seq,
        updatedAt: NOW.toISOString(),
        entity: {
          id: "m1",
          segment: "waiting",
          from: { name: "Lena", address: "lena@atelier.example" },
          initial: "L",
          time: "08:12",
          scope: "sender",
          ai: { dest: "reads", confidence: 0.88, rationale: "a studio newsletter you have kept before" },
          held: [{ id: "m1", subject: "Spring hours", time: "08:12", body: "…", bodyState: "full" }],
          updatedAt: NOW.toISOString(),
        },
      },
    ]);
    await mountView(engine);

    // The bulk control is back, and it STATES THE SIZE of what pressing it accepts —
    // one, not "all", because "all" is what let an empty set hide behind a label.
    const bulk = host!.querySelector(".scn-bulk")!;
    const labels = [...bulk.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    // NB the trailing "a" in the rendered label is the `kbdHint` keycap, not a plural.
    // …and it NAMES THE PILE as well as the count, so the consequence is legible before the
    // press: this one sender's suggestion is News, and the label says News.
    expect(labels.some((l) => /Apply 1 — News/.test(l)), labels.join(" · ")).toBe(true);

    // The row itself carries the chip. Scoped to `.row .badge.ai` on purpose: asserting
    // that the view merely CONTAINS "Reads" would pass on `DecisionBar`'s own destination
    // button, which is present for every sender whether suggested or not.
    const chip = host!.querySelector(".view-screener .row .badge.ai")!;
    expect(chip, "the suggested row has no AI chip").toBeTruthy();
    expect(chip.textContent).toContain("News");
    expect(chip.textContent).toContain("0.88");

    // …and the preview gives the reason in the sender's own terms, not a score alone.
    // Selected explicitly: the two senders share a timestamp, so which row the cursor
    // lands on by default is an ordering detail this claim must not depend on.
    const lenaRow = host!.querySelector('.view-screener .row[data-id="m1"]')!;
    expect(lenaRow, "the suggested sender has no row").toBeTruthy();
    await act(async () => {
      lenaRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const why = host!.querySelector(".scn-why")!;
    expect(why.className).not.toContain("scn-why-none");
    expect(why.textContent).toContain("AI suggests");
    expect(why.textContent).toContain("0.88");
    expect(why.textContent).toContain("a studio newsletter you have kept before");
    expect(chip).toBeTruthy();
  });
});

describe("a derived Screener row decides over the real wire vocabulary", () => {
  it("the queue is there at all — 2 senders, 3 held, from the mirror alone", async () => {
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);
    expect(get().waitingCount).toBe(2);
    expect(get().waiting.every((s) => s.derived)).toBe(true);
    expect(get().waiting.flatMap((s) => s.held)).toHaveLength(3);
  });

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

  it("hydrating one held message makes it FULL, and touches no other row", async () => {
    /**
     * The "Demo/public content" invariant, made true rather than claimed: `ScreenerSenderDTO.held` promises "every held
     * message, in full", and on a live account — where every row is derived — it was the
     * snippet. This is the same live shape, hydrated.
     *
     * Red two ways, both of which were the shipped state: have `bodyOf` skip the
     * `message_body` record (the body stays `snippet m1`), or have `heldOf` go back to
     * `m.body ?? m.snippet` (`bodyState` disappears and every row claims `full`).
     */
    const engine = await engineWith(HELD);
    await engine.start();
    await engine.hydrateBody("m1");
    const { get } = await mountState(engine);

    const held = get().waiting.flatMap((s) => s.held);
    const m1 = held.find((h) => h.id === "m1")!;
    expect(bodiesFetched).toEqual(["m1"]);
    expect(m1.bodyState).toBe("full");
    expect(m1.body).toBe("FULL BODY of m1\nsecond paragraph");
    // Bounded: the sibling in the SAME sender's held list is untouched, so nothing here is
    // quietly fetching a pile.
    expect(held.find((h) => h.id === "m2")!.bodyState).toBe("snippet");
    expect(held.find((h) => h.id === "m3")!.bodyState).toBe("snippet");
  });

  it("A DELTA FOR THE SAME MESSAGE DOES NOT WIPE THE HYDRATED BODY (Risk 1)", async () => {
    /**
     * THE RULING'S FIRST RISK, in the surface it would have hurt most.
     *
     * `applyToRecords` REPLACES the entity on `create|update` (`apply.ts:56-58`), and the
     * server's DTO has `snippet` and no `body`. So if the fetched text lived on the message
     * row, any update for that id would erase it — and the Screener is where such an update
     * is guaranteed to arrive, because deciding a sender moves its held mail and the worker's
     * `\Seen` write lands as another one.
     *
     * Red by storing the body on the message record instead of in `message_body`: the update
     * below carries a server-shaped DTO and the assertion falls back to `snippet m1`.
     */
    const engine = await engineWith(HELD);
    await engine.start();
    await engine.hydrateBody("m1");

    const before = engine.read().get<EngineMessage>("message", "m1")!;
    await engine.store.applyChanges([
      {
        type: "message",
        op: "update",
        id: "m1",
        seq: ++seq,
        updatedAt: NOW.toISOString(),
        // Exactly what the wire sends: `snippet`, never `body`. This is the echo of the
        // `mark_seen` that reading a message emits.
        entity: { ...before, unread: false },
      },
    ]);

    const { get } = await mountState(engine);
    const m1 = get().waiting.flatMap((s) => s.held).find((h) => h.id === "m1")!;
    expect(m1.bodyState).toBe("full");
    expect(m1.body).toBe("FULL BODY of m1\nsecond paragraph");
    // The delta DID land — otherwise this test would pass by the update having been dropped.
    expect(engine.read().get<EngineMessage>("message", "m1")!.unread).toBe(false);
  });

  it("Ohbox is one call: the endpoint's own yes, no follow-up move", async () => {
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);
    const lena = get().waiting.find((s) => s.from.address === "lena@atelier.example")!;

    await act(async () => { get().decide(lena, "ohbox", { read: false, scope: "sender" }); });
    await settle();

    expect(kinds("screener_decide")).toEqual([
      expect.objectContaining({ senderId: lena.id, decision: "yes", scope: "sender" }),
    ]);
    expect(kinds("move")).toEqual([]);
    expect(kinds("mark_seen")).toEqual([]);
  });

  /**
   * ── SCR-READ: READS IS ONE CALL TOO, AND THIS TEST USED TO ASSERT THE DEFECT ─────────────
   *
   * It was called *"Reads adds a move, because the endpoint has no such destination"* and it
   * asserted the follow-up `move` fan-out as the intended design, with a note warning that
   * honouring `m.dest` locally would desync the overlay from the wire. The premise was true
   * and the design was wrong: the two requests write the same `folder_state.desired_folder`,
   * `decide` reads its held rows outside its transaction, and the `move` lost that race often
   * enough to leave dozens of bulletins in the Ohbox in use behind four `promoted → INBOX`
   * rules for senders admitted with Reads.
   *
   * So the assertion is not relaxed, it is INVERTED and tightened: the destination is named on
   * the decide itself, and there is no second request whose landing order could change the
   * answer. The overlay/wire agreement the old note was protecting still holds — both sides now
   * compute the folder from `decideFolder(m)`.
   */
  it("Reads is ONE call: the destination rides the decide, with no follow-up move", async () => {
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);
    const lena = get().waiting.find((s) => s.from.address === "lena@atelier.example")!;

    await act(async () => { get().decide(lena, "reads", { read: false, scope: "sender" }); });
    await settle();

    expect(kinds("screener_decide")).toEqual([
      expect.objectContaining({ decision: "yes", dest: "reads" }),
    ]);
    // THE GUARD. Restore the composition in `screener-state.ts#commit` and this goes red on
    // the first line; drop `dest` from the mutation and it goes red on the assertion above,
    // which is the half that decides where the SERVER files it.
    expect(kinds("move")).toEqual([]);
    // …and the mirror agrees once the echoes land: BOTH held messages, not just the
    // representative, and in Reads rather than the Ohbox.
    for (const id of ["m1", "m2"]) {
      expect(engine.store.get<EngineMessage>("message", id)?.folder).toBe("ohmail/News");
    }
  });

  it("SPAM RIDES THE NO BRANCH — a yes would file spam into the Ohbox", async () => {
    // The endpoint's yes ADMITS a sender, and the server refuses `{decision:"yes",
    // dest:"ohmail/Quarantine"}` with a 400. The pre-C1 mapping was `dest === "screened" ?
    // "no" : "yes"`, so on a live account "Mark spam" would have asked the server to put that
    // sender in the Ohbox AND promoted a rule sending their future mail there. Flip the
    // mapping back and this goes red.
    //
    // SCR-READ: `dest` now rides the NO branch too. Before it did not, so a spam press asked
    // for `ohmail/Screened` and a follow-up `move` was supposed to carry it the rest of the
    // way to Quarantine — the same losing race as Reads. Both halves are on the one call now.
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);
    const jackpot = get().waiting.find((s) => s.from.address === "win@jackpot.example")!;

    await act(async () => { get().decide(jackpot, "spam", { read: false, scope: "sender" }); });
    await settle();

    expect(kinds("screener_decide")).toEqual([
      expect.objectContaining({ decision: "no", dest: "spam" }),
    ]);
    expect(kinds("move")).toEqual([]);
    expect(engine.store.get<EngineMessage>("message", "m3")?.folder).toBe("ohmail/Quarantine");
  });

  it("a spam-pinned sender is listed ONCE, not beside their own derived row", async () => {
    // The pin is this session's memory of the decision; the derived row is the same
    // sender read back out of `ohmail/Quarantine`. Drop the address filter on
    // `segments.spam` and the sender appears twice the moment the move lands.
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);
    const jackpot = get().waiting.find((s) => s.from.address === "win@jackpot.example")!;

    await act(async () => { get().decide(jackpot, "spam", { read: false, scope: "sender" }); });
    await settle();

    expect(get().spam.map((r) => r.sender.from.address)).toEqual(["win@jackpot.example"]);
  });

  it("'& read' is its own mark_seen — the decide endpoint has no read field", async () => {
    // The toast says "· marked read". Without this the copy is false on every Cloud
    // account: the mail files, and stays bold.
    const engine = await engineWith(HELD);
    await engine.start();
    const { get } = await mountState(engine);
    const lena = get().waiting.find((s) => s.from.address === "lena@atelier.example")!;

    await act(async () => { get().decide(lena, "ohbox", { read: true, scope: "sender" }); });
    await settle();

    expect(kinds("mark_seen")).toEqual([
      expect.objectContaining({ messageIds: ["m1", "m2"], unread: false }),
    ]);
    for (const id of ["m1", "m2"]) {
      expect(engine.store.get<EngineMessage>("message", id)?.unread).toBe(false);
      expect(engine.store.get<EngineMessage>("message", id)?.folder).toBe("INBOX");
    }
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

  it("presents as a waiting row over the projected reader — the row that used to vanish", async () => {
    const engine = await engineWith(CAROLINE);
    await engine.start();
    const { get } = await mountProjected(engine);
    // Over the RAW mirror this sender is in the Ohbox, not the queue; the projection is what
    // surfaces them, and before A.i even the projection minted no row.
    expect(get().waiting.map((s) => s.from.address)).toContain("blasz.caroline@gmail.test");
  });

  it("committing it dispatches rule_create → INBOX (no past-mail answer), and NO screener_decide", async () => {
    const engine = await engineWith(CAROLINE);
    await engine.start();
    const { get } = await mountProjected(engine);
    const caroline = get().waiting.find((s) => s.from.address === "blasz.caroline@gmail.test")!;

    await act(async () => { get().decide(caroline, "ohbox", { read: false, scope: "sender" }); });
    await settleAwaited();

    // THE GUARD. Swap the commit branch back to `screener_decide` for a non-gate rep and this
    // goes red on BOTH counts: the decide's effects are empty (the rep is in INBOX, not the
    // gate), so `Engine.mutate` rolls it back WITHOUT sending — `sent` holds neither a decide
    // nor a rule, and the message stays presented in the Screener for ever.
    expect(kinds("screener_decide")).toEqual([]);
    expect(kinds("rule_create")).toEqual([
      expect.objectContaining({
        ruleKind: "sender",
        match: "blasz.caroline@gmail.test",
        destination: "INBOX",
        applyRetro: false,
      }),
    ]);
    // …and no held-mail move, because the mail is already physically in the INBOX. The rule alone
    // flips its presentation to the Ohbox.
    expect(kinds("move")).toEqual([]);
  });

  it("the sender's bag presents in the Ohbox once the rule echoes back — zero server moves", async () => {
    const engine = await engineWith(CAROLINE);
    await engine.start();
    const { get } = await mountProjected(engine);
    const caroline = get().waiting.find((s) => s.from.address === "blasz.caroline@gmail.test")!;

    await act(async () => { get().decide(caroline, "ohbox", { read: false, scope: "sender" }); });
    await settleAwaited();

    // The rule is now in the mirror, so the cutline decides INBOX and the sender leaves the queue.
    expect(get().waiting.map((s) => s.from.address)).not.toContain("blasz.caroline@gmail.test");
    // Nothing moved on the server — both messages are still physically in the INBOX.
    for (const id of ["c1", "c2"]) {
      expect(engine.store.get<EngineMessage>("message", id)?.folder).toBe("INBOX");
    }
  });

  it("a refused rule says the rule couldn't be made — never 'Ruled' over nothing", async () => {
    // The awaited-dispatch half: with a 403 on `rule_create`, the sentence is the failure one, not
    // the shipped "Ruled/files there too" claimed over a mutation that never landed. Return the
    // unawaited void pattern (drop the await / toast the success key on click) and this goes red.
    const toasts: string[] = [];
    const engine = await engineRefusing(CAROLINE);
    await engine.start();
    const { get } = await mountProjected(engine, (m) => toasts.push(m));
    const caroline = get().waiting.find((s) => s.from.address === "blasz.caroline@gmail.test")!;

    await act(async () => { get().decide(caroline, "ohbox", { read: false, scope: "sender" }); });
    await settleAwaited();

    expect(toasts.some((s) => /couldn.t be made/i.test(s)), toasts.join(" | ")).toBe(true);
    expect(toasts.some((s) => /files there too/i.test(s)), toasts.join(" | ")).toBe(false);
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
      const engine = await engineWith(NAMED);
      await engine.start();
      await mountView(engine, segment);

      const row = host!.querySelector(".view-screener .row")!;
      expect(row, `no ${segment} row`).toBeTruthy();
      expect(row.textContent, `${segment} row dropped the name`).toContain(name);
      expect(row.textContent, `${segment} row dropped the address`).toContain(address);

      const held = host!.querySelector(".view-screener .hmail .hm-line")!;
      expect(held, `no held mail in the ${segment} preview`).toBeTruthy();
      expect(held.textContent, `${segment} held mail dropped the name`).toContain(name);
      expect(held.textContent, `${segment} held mail dropped the address`).toContain(address);
    },
  );

  it("a sender with no display name still renders ONE identity, not an empty line", async () => {
    // The other half of the contract: `HELD`'s senders have `name: null`, which is the shape
    // every fixture account has. `MessageRow`/`HeldMail` are given the address as `from` and
    // no `address` at all, so nothing renders twice and nothing renders blank.
    const engine = await engineWith(HELD);
    await engine.start();
    await mountView(engine);

    // Whichever sender the cursor lands on — which row that is is an ordering detail this
    // claim must not depend on, the same care the AI-chip test above takes.
    const line = host!.querySelector(".view-screener .hmail .hm-line")!;
    expect(line.textContent).toMatch(/(lena@atelier|win@jackpot)\.example/);
    expect(line.querySelector(".addr"), "the address was printed twice").toBeNull();
  });

  it("every destination capsule carries its own key, and the mail piles carry the ✓ twin", async () => {
    // the rule, reaching the surface it had missed: the key is on the verb it fires.
    // Before this, `o`/`r`/`c`/`n`/`x` existed only inside `title` attributes. The demoting
    // destinations (Screen out `n`, Spam `x`) file but carry NO ✓ — you don't read what you
    // triage out — so their capsule has the letter and no shifted twin. SCR-READBOX.
    const engine = await engineWith(HELD);
    await engine.start();
    await mountView(engine);

    const capsules = [...host!.querySelectorAll(".view-screener .dbtn")];
    const caps = capsules.map((c) => [
      c.querySelector(".d-main kbd")?.textContent ?? null,
      c.querySelector(".d-read kbd")?.textContent ?? null,
    ]);
    expect(caps).toEqual([
      ["o", "⇧O"], ["r", "⇧R"], ["c", "⇧C"], ["n", null], ["x", null],
    ]);
    // The null on the last two is the ✓ button's ABSENCE, not an unlabelled cap.
    for (const c of capsules.slice(3)) expect(c.querySelector(".d-read")).toBeNull();
  });

  it("the pane foot carries the ? affordance and GENERATED movement hints — never a verb legend", async () => {
    /**
     * The HAND-TYPED legend left in two steps, and this test has guarded both. First the
     * filing keys went (`o r c n x file`, `⇧ +key marks read` — five keycaps naming
     * capsules in the other pane), then the whole typed strip: clamped to one line, it
     * CLIPPED mid-word in the split layout, and it was a second copy of bindings the `?`
     * sheet derives from the registry.
     *
     * The ohmarchy hint foot (Phase 1) brought a teaching line back — GENERATED, never
     * typed: `ShortcutHint` renders the movement winners the registry itself would run
     * (↑↓ the section's own next/prev, ←→ the zone step) beside the `?` affordance, per
     * the ruling that a statusline foot carries navigation and scope hints only,
     * never a verb that owns a visible button. So the keycap set is exactly the arrows
     * plus `?` — a VERB letter (the o/r/c/n/x legend, a ⇧ twin) appearing here is the
     * regression this test exists to catch, and the hand-typed words stay banned.
     */
    const engine = await engineWith(HELD);
    await engine.start();
    await mountView(engine);

    const hints = host!.querySelector(".view-screener .list-hints")!;
    expect(hints, "the hint strip slot vanished entirely").toBeTruthy();
    const btn = hints.querySelector("button.key-hint");
    expect(btn, "the ? affordance is missing from the pane foot").toBeTruthy();
    const caps = [...hints.querySelectorAll("kbd")].map((k) => k.textContent);
    // Edge-honest: with no sender selected yet the cursor stands before the list, so only
    // ↓ is live vertically; laterally only ← (the menu) — the Screener declares no reading
    // column, so → is nobody's. A printed arrow is a key that will do something right now.
    expect(caps).toEqual(["↓", "←", "?"]);
    expect(hints.textContent).not.toContain("marks read");
    expect(hints.textContent).not.toContain("file");
  });

  it("nothing in the sheet is called a door", async () => {
    // "Pick a door." was the whole of the no-suggestion line's instruction, and the sheet
    // never calls anything a door — the capsules beside it say Ohbox, Reads, Receipts,
    // Screen out, Spam. The marketing page keeps the metaphor, where its hero establishes it.
    const engine = await engineWith(HELD);
    await engine.start();
    await mountView(engine);

    const why = host!.querySelector(".scn-why-none")!;
    expect(why, "the no-suggestion line is missing").toBeTruthy();
    expect(why.textContent).toContain("No suggestion");
    expect(host!.textContent ?? "").not.toMatch(/\bdoor\b/i);
  });

  it("the rule disclosure still leads the note, and both halves are now named", async () => {
    // An earlier change put the consequence BEFORE the click because screening a sender out arms
    // auto-unsubscribe. A legibility pass must not cost that sentence its place.
    const engine = await engineWith(HELD);
    await engine.start();
    await mountView(engine);

    const note = host!.querySelector(".view-screener .d-note")!.textContent ?? "";
    expect(note.startsWith("Becomes a rule")).toBe(true);
    expect(note).toContain("files the mail waiting here");
    expect(note).toContain("marks it read");
  });
});
