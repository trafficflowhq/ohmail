/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import de from "../messages/de.json";
import { screenerIntentsKey, type ScreenerIntent } from "../app/shell/screener-intents";
import { screenerMode, type ScreenerRole } from "@ohmail/app-logic/mail-state/mail-state";
import { ScreenerView } from "../app/views/ScreenerView";
import { KeymapProvider } from "../app/shell/keymap";
import type { ScreenerState } from "../app/shell/screener-state";

/**
 * ═══ A READER MAY NOT DECIDE, AND MAY NOT BE TOLD IT DID ════════════════════════════════════
 *
 * ## THE MEASURED SEQUENCE — released 0.13.7, x86_64 AppImage, a standalone install reading a
 * mailbox ohmail Cloud holds the live lease on
 *
 *   1. the Screener drew the FULL decision bar — five destinations with keycaps, the scope
 *      switch, "Mark all spam", "Set up a model";
 *   2. `o` on a waiting sender toasted *"Ohbox — filed. Future mail from
 *      editors@terracereview.invalid files there automatically. Undo"*, the sender left the list
 *      and the count dropped 329 → 328;
 *   3. the SERVER, read independently over IMAP before and 15 s after the press: `ohmail/Screener`
 *      2846 → 2846, INBOX 39 → 39, `ohmail/_meta` untouched. No rule written. Nothing moved;
 *   4. ~45 s later the sender was back in Waiting tagged "Not saved", with no sentence saying why.
 *
 * The flow's own elsewhere step had said, one minute earlier, *"This computer reads the mailbox;
 * it moves nothing and screens nothing."* Two surfaces, one machine, one minute apart.
 *
 * ## WHAT IS ASSERTED HERE
 *
 * Three layers, because only the first is what a person meets and only the last is structural:
 *
 *   · the VIEW withholds every deciding control and says who organizes instead (the pane cases);
 *   · the STATE refuses all seven writing verbs before anything is armed, dispatched or
 *     journalled, and names the holder in one sentence (the state cases);
 *   · the DERIVATION is `readerStandDown` aggregated over the roster, so this surface and
 *     Settings → Mailboxes cannot come to disagree (the table case).
 *
 * ## HOW TO WATCH THESE FAIL
 *
 *   · drop the `guard()` wrapper from `screener-state.ts`'s return → "nothing is dispatched",
 *     "nothing is journalled" and the census all go red, with a `screener_decide` on the wire for
 *     a mailbox this install does not organize — the released behaviour exactly;
 *   · drop `if (role.mode === "blocked") return;` from the boot-replay effect → "a journal
 *     from the session that organized" goes red with a decide dispatched at mount;
 *   · render `<DecisionBar>` unconditionally in `WaitingPreview` → "the decision bar is gone"
 *     goes red;
 *   · make `screenerMode` read the FIRST row instead of every row → the mixed-roster case
 *     goes red, refusing decisions on an account that has an organizer;
 *   · make the `pending` arm answer `blocked` → "a reader whose holder ACCEPTS DECISIONS"
 *     goes red, and with it the pane case that keeps the decision bar on that install.
 *
 * All five were run.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOLDER: ScreenerRole =
  { mode: "blocked", name: "ohmail Cloud", reason: "organizer_outdated", oauthOnly: false };
/** This install organizes it — every verb works, which is what these cases contrast with. */
const ORGANIZES: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false };
/** A reader whose holder takes decisions: the bar STAYS and the press is real. */
const PENDING: ScreenerRole =
  { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false };
let seq = 0;
let sent: EngineMutation[] = [];
/** Every sentence the state raised, in order — the refusal is the only thing that may appear. */
let toasts: string[] = [];

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-02T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: {
      sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false,
      priority: false,
    },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

/** One stranger waiting, and one already quarantined — the two segments that carry verbs. */
const HELD = msg("h1", "editors@terracereview.invalid", "ohmail/Screener");
const JUNK = msg("q1", "blast@bulk.invalid", "ohmail/Quarantine");

async function freshStore(): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  for (const m of [HELD, JUNK]) {
    await store.applyChanges([{
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    }]);
  }
  return store;
}

/** An engine over `store` whose every dispatched verb is recorded in `sent`. */
function engineOver(store: MirrorStore): OhmailEngine {
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
        const changes: SyncChange[] = mutationEffects(store, m, {
          now: () => NOW, uuid: () => `id-${++seq}`,
        }).map((e) => ({
          type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
          updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body", html: null, loadedRemoteContent: false,
        unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Mount the real hook, with the real catalogue behind it. */
async function mountState(
  engine: OhmailEngine,
  role: ScreenerRole,
  locale: "en" | "de" = "en",
): Promise<{ get: () => ScreenerState; bump: () => Promise<void> }> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  let latest: ScreenerState | null = null;
  let force: (() => void) | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    force = () => setV((x) => x + 1);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(
      engine,
      v,
      ((message: string) => { toasts.push(message); }) as never,
      undefined,
      undefined,
      true,
      role,
    );
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? de : en) as never, timeZone: "UTC", now: NOW,
      children: h(Probe),
    }));
  });
  await settleFirstPaint();
  return {
    get: () => latest!,
    bump: async () => { await act(async () => { force?.(); }); },
  };
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  seq = 0;
  sent = [];
  toasts = [];
  window.localStorage.clear();
});

afterEach(async () => {
  await unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE STATE — nothing is armed, nothing is journalled, nothing reaches the wire
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the Screener state refuses every write on a mailbox this install does not organize", () => {
  it("`decide` dispatches NOTHING, journals NOTHING, and does not hide the row", async () => {
    const store = await freshStore();
    const s = await mountState(engineOver(store), HOLDER);
    const waiting = s.get().waiting;
    expect(waiting, "the queue should still LIST — a reader reads").toHaveLength(1);

    await act(async () => {
      s.get().decide(waiting[0]!, "ohbox", { read: false, scope: "sender" });
    });

    /* THE THREE THINGS THE RELEASED BUILD DID. Each is asserted separately because each was a
       different half-truth: the wire (nothing happened), the journal (a durable record of an act
       the engine will not make), and the queue (the row left, and the count dropped). */
    expect(sent, "a decide reached the wire on a mailbox this install does not organize")
      .toHaveLength(0);
    expect(window.localStorage.getItem(screenerIntentsKey()),
      "a refused decision was journalled and would replay at the next boot").toBeNull();
    expect(s.get().isExiting(waiting[0]!.id), "the row was hidden for a decision nobody took")
      .toBe(false);
    expect(s.get().waitingCount, "the count moved for a decision nobody took").toBe(1);
  });

  it("…and it SAYS SO, naming who organizes, in place of 'Ohbox — filed'", async () => {
    const store = await freshStore();
    const s = await mountState(engineOver(store), HOLDER);
    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "ohbox", { read: false, scope: "sender" });
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toBe(
      en.screener.readerRefused.replace("{name}", "ohmail Cloud"),
    );
    /* AND IT IS NOT THE FILED SENTENCE. Named explicitly rather than left to the equality above,
       because this exact string is what a person read on the released build. */
    expect(toasts[0], "the optimistic 'filed' sentence survived").not.toContain("Undo");
  });

  it("a holder with no NAME gets the legacy sentence, never an invented machine name", async () => {
    const store = await freshStore();
    const s = await mountState(engineOver(store),
      { mode: "blocked", name: null, reason: "organizer_outdated", oauthOnly: false });
    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "spam", { read: false, scope: "sender" });
    });
    expect(toasts[0]).toBe(en.screener.readerRefusedUnknown);
    expect(toasts[0], "a placeholder was rendered as a name").not.toContain("{name}");
  });

  it("the refusal is TRANSLATED — German gets German, not the English fallback", async () => {
    const store = await freshStore();
    const s = await mountState(engineOver(store), HOLDER, "de");
    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "ohbox", { read: false, scope: "sender" });
    });
    expect(toasts[0]).toBe(de.screener.readerRefused.replace("{name}", "ohmail Cloud"));
  });

  /* ── THE CENSUS ────────────────────────────────────────────────────────────────────────────
   * The wall is at the return of `useScreenerState`, so the guarded set is complete by
   * construction — and this is what says so, and what makes a verb added later and NOT wrapped
   * a red test rather than a silent hole. Every one of these writes: it moves mail, writes a
   * rule, or closes an appointment. */
  it("EVERY writing verb is behind the wall — the exact set", async () => {
    const store = await freshStore();
    const s = await mountState(engineOver(store), HOLDER);
    const st = s.get();
    const sender = st.waiting[0]!;
    const spamRow = st.spam[0];
    expect(spamRow, "the fixture should put one row in the spam segment").toBeDefined();

    /* THE SET IS SPLIT NOW, AND WHICH HALF A VERB IS IN IS PART OF THE CLAIM.
       The first three express a DECISION about a sender — the one thing a reader's organizer
       carries out on its behalf — so on a `blocked` reader they are refused with the deciding
       sentence, and on a `pending` one they are not refused at all. The last four MOVE MAIL, and
       no organizer takes a move from a reader in any mode, so they are refused in both with a
       sentence that says so. Pinning one sentence for all seven, as this row used to, would now
       assert something false about four of them. */
    const decideRefusal = en.screener.readerRefused.replace("{name}", "ohmail Cloud");
    const moveRefusal = en.screener.readerMoveRefused.replace("{name}", "ohmail Cloud");
    const presses: Array<[string, () => void, string]> = [
      ["decide", () => st.decide(sender, "ohbox", { read: false, scope: "sender" }), decideRefusal],
      ["applyAll", () => st.applyAll(() => "sender"), decideRefusal],
      ["markAllSpam", () => st.markAllSpam(() => "sender"), decideRefusal],
      ["allowScreened", () => st.allowScreened(sender, "ohbox"), moveRefusal],
      ["notSpamToWaiting", () => st.notSpamToWaiting(spamRow!), moveRefusal],
      ["notSpamToOhbox", () => st.notSpamToOhbox(spamRow!), moveRefusal],
      ["deleteSpam", () => st.deleteSpam(spamRow!), moveRefusal],
    ];
    for (const [, press] of presses) await act(async () => { press(); });
    await act(async () => { vi.advanceTimersByTime(60_000); });

    expect(sent, "a writing verb escaped the read-only wall").toEqual([]);
    expect(window.localStorage.getItem(screenerIntentsKey())).toBeNull();
    expect(toasts, "every verb owes the person a sentence").toHaveLength(presses.length);
    /* PER VERB BY NAME, so a verb moved to the wrong wall is named in the failure rather than
       reported as "one of seven sentences differs". */
    presses.forEach(([name, , expected], i) => {
      expect(toasts[i], `${name} raised the wrong refusal`).toBe(expected);
    });
  });

  it("a journal from the session that DID organize is not replayed by a reader", async () => {
    /* The durable path's own version of the defect, and the one nobody would find by pressing
       keys: this install organized the mailbox yesterday, armed a decision, and died inside the
       undo window; today it is a reader. Replaying would file mail the engine will not move.
       Nothing is consumed — the entry stays for a boot in which this install has the mailbox
       back, and ages out on `INTENT_TTL_MS` if that never comes. */
    const armed: ScreenerIntent = {
      v: 1, id: HELD.id, dest: "ohbox", read: false, scope: "sender", quiet: false,
      at: NOW.getTime(), derived: false, heldIds: [],
      from: { name: null, address: HELD.from.address },
    };
    window.localStorage.setItem(screenerIntentsKey(), JSON.stringify([armed]));

    const store = await freshStore();
    const s = await mountState(engineOver(store), HOLDER);
    await s.bump();
    await act(async () => { await Promise.resolve(); });

    expect(sent, "the boot replay dispatched a decision on a mailbox this install reads")
      .toHaveLength(0);
    expect(window.localStorage.getItem(screenerIntentsKey()),
      "the entry was consumed by an attempt that could not be made").toContain(HELD.id);
  });

  it("CONTROL: with no holder, every one of those verbs works exactly as before", async () => {
    const store = await freshStore();
    const s = await mountState(engineOver(store), ORGANIZES);
    expect(s.get().role.mode).toBe("organizer");
    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "ohbox", { read: false, scope: "sender" });
    });
    expect(s.get().isExiting(HELD.id), "the ordinary decide stopped hiding the row").toBe(true);
    expect(window.localStorage.getItem(screenerIntentsKey()),
      "the ordinary decide stopped journalling").toContain(HELD.id);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expect(sent.filter((m) => m.kind === "screener_decide"),
      "the ordinary decide stopped reaching the wire").toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PANE — the refusal is stated BEFORE the press, and no deciding control is drawn
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** A `ScreenerState` double: only what `ScreenerView` reads, and nothing that writes. */
function viewState(role: ScreenerRole): ScreenerState {
  const sender = {
    id: "s1",
    from: { name: "Terrace Review", address: "editors@terracereview.invalid" },
    initial: "T",
    derived: true,
    scope: "sender" as const,
    ai: null,
    held: [{
      id: "h1", subject: "Spring issue", time: "09:00", body: "body", html: null,
      bodyState: "ready" as const, unsubscribe: "no_header" as const, unsubscribeUrl: null,
      trackerNote: null,
    }],
  };
  return {
    waiting: [sender], waitingCount: 1, suggestedCount: 1, suggestedDests: ["ohbox"],
    waitingSource: "store", waitingMore: { available: false, loading: false, failed: false, load: () => {} }, rereadWaiting: () => {},
    unsuggestedSenders: [], suggestedSenders: ["s1"], applying: null,
    screenedOut: [], spam: [],
    isExiting: () => false, refused: () => false, bodyStall: () => null,
    decide: () => { throw new Error("the pane offered a control that decides"); },
    applyAll: () => { throw new Error("the pane offered a bulk that decides"); },
    markAllSpam: () => { throw new Error("the pane offered a bulk that decides"); },
    allowScreened: () => { throw new Error("the pane offered a release"); },
    notSpamToWaiting: () => { throw new Error("the pane offered a rescue"); },
    notSpamToOhbox: () => { throw new Error("the pane offered a rescue"); },
    deleteSpam: () => { throw new Error("the pane offered a delete"); },
    flush: () => {},
    role,
    pending: [],
    decided: [],
    notApplied: [],
  } as unknown as ScreenerState;
}

async function mountView(role: ScreenerRole): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider, {
        children: h(ScreenerView, {
          state: viewState(role),
          segment: "waiting",
          selection: { waiting: "s1", screened: null, spam: null },
          settled: true,
          owed: false,
          onSelect: () => {},
          hydrateBody: () => {}, hydrateBodies: () => {},
          full: false,
          onFull: () => {},
        } as never),
      }),
    }));
  });
  await settleFirstPaint();
  return host;
}

describe("the Screener pane draws no deciding control on a reader", () => {
  it("the decision bar is GONE and the sentence names who organizes", async () => {
    const el = await mountView(HOLDER);
    const text = el.textContent ?? "";
    expect(el.querySelector(".scn-reader"), "the reader note was not drawn").not.toBeNull();
    expect(text).toContain(en.screener.readerBarTitle);
    expect(text).toContain("ohmail Cloud");
    /* THE FIVE DESTINATIONS ARE THE BAR. `DecisionBar` renders them as split buttons carrying
       the keycaps; none of that may be on screen, disabled or otherwise. */
    expect(el.querySelector(".d-btns"), "the decision bar survived").toBeNull();
    expect(text, "'Mark all spam' is a bulk that decides").not.toContain(en.screener.markAllSpam);
    expect(el.querySelector(".row-actions"), "the row's quick-file menu survived").toBeNull();
  });

  it("NO APPLY CONTROL AT ALL in `blocked` — a control wired to a refusal is worse than none", async () => {
    /* Named separately from "the decision bar is GONE" because it is a different control in a
       different place: the bar is per-sender in the read column, this is the bulk over the whole
       queue in the list head. `viewState` gives the pane one suggested sender, so the button has
       something to act on and its absence is a decision rather than an empty list. */
    const el = await mountView(HOLDER);
    const labels = [...el.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(
      labels.filter((l) => l.startsWith("Apply")),
      "the bulk apply survived on a mailbox this install does not organize",
    ).toEqual([]);
    /* And its own state proves the button had something to do: `viewState` would throw from
       `applyAll` if the pane had wired one, which is the second layer. */
    expect(el.querySelector(".scn-bulk button"), "a bulk verb survived").toBeNull();
  });

  it("PENDING KEEPS THE BAR, and says where the decision goes instead of refusing it", async () => {
    /* The mirror image of the case above, and the reason the role is three-valued. Withholding
       the bar here would be the same defect with its sign flipped — a control taken away from
       somebody whose press would in fact be carried out — so what changes is a sentence, not a
       control.

       HOW TO WATCH IT FAIL: make `screenerMode`'s `pending` arm answer `blocked`, or gate the bar
       on `role.mode !== "organizer"` instead of `=== "blocked"`. */
    const el = await mountView(PENDING);
    const text = el.textContent ?? "";
    expect(el.querySelector(".d-btns"), "the decision bar was withheld from a pending reader")
      .not.toBeNull();
    expect(el.querySelector(".scn-reader"), "the withholding note was drawn beside a live bar")
      .toBeNull();
    expect(el.querySelector(".scn-relay"), "the standing line is missing").not.toBeNull();
    expect(text, "the standing line does not name the machine that will file it")
      .toContain("ohmail Cloud");
  });

  it("CONTROL: with no holder the bar, the row menu and the bulk are all there", async () => {
    const el = await mountView(ORGANIZES);
    const text = el.textContent ?? "";
    expect(el.querySelector(".scn-reader"), "the reader note was drawn over an organizer")
      .toBeNull();
    expect(el.querySelector(".d-btns"), "the decision bar is missing for an organizer")
      .not.toBeNull();
    expect(text).toContain(en.screener.markAllSpam);
    expect(el.querySelector(".row-actions"), "the row's quick-file menu is missing").not.toBeNull();
    expect(el.querySelector(".scn-relay"), "the pending line was drawn over an organizer")
      .toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE DERIVATION — one predicate, aggregated by the ruling's own test
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

type Row = Parameters<typeof screenerMode>[0] extends ReadonlyArray<infer R> | null ? R : never;

const reader = (over: Partial<Row> = {}): Row => ({
  status: "connected",
  disabledReason: null,
  organizerRole: "reader",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-09-02T09:00:00.000Z" },
  organizeConsentedAt: null,
  ...over,
} as Row);

const organizer = (over: Partial<Row> = {}): Row => ({
  status: "connected",
  disabledReason: null,
  organizerRole: "organizer",
  organizedBy: null,
  organizeConsentedAt: "2026-09-02T09:00:00.000Z",
  ...over,
} as Row);

describe("screenerMode — what the Screener may do on this install", () => {
  /* The three answers, and the two that are new. `organizer` is what `screenerReadOnly` used to
     answer `null` for; `blocked` is what it answered a holder for; `pending` did not exist,
     because until the decision channel there was nowhere for a reader's press to go. Every row
     below that used to assert `toBeNull()` now asserts `mode: "organizer"` and every row that
     asserted a holder object now asserts `blocked` with that holder — the same claims, re-aimed
     at the shape that can express the third state. */

  it("a lone reader with a named holder is BLOCKED, and names it", () => {
    expect(screenerMode([reader()]))
      .toEqual({
        mode: "blocked", name: "ohmail Cloud", reason: "organizer_outdated", oauthOnly: false,
      });
  });

  it("a lone organizer organizes", () => {
    expect(screenerMode([organizer()]).mode).toBe("organizer");
  });

  it("A MIXED ROSTER organizes — one organizer is enough for the pane to work", () => {
    // `ONBOARDING-RULINGS.md` 1(b): permitted iff the account holds ≥1 organizer. The safe
    // direction of the two — with an organizer present, no decision that could land is refused.
    expect(screenerMode([reader(), organizer()]).mode).toBe("organizer");
    expect(screenerMode([organizer(), reader()]).mode).toBe("organizer");
  });

  it("EVERY row a reader answers with the first NAMED holder", () => {
    expect(screenerMode([
      reader({ organizedBy: { kind: "cloud", name: null, since: null } }),
      reader(),
    ]).name).toBe("ohmail Cloud");
  });

  it("a reader nobody is NAMED for answers with a null name, never an invented one", () => {
    expect(screenerMode([
      reader({ organizedBy: { kind: "local", name: null, since: null } }),
    ])).toEqual({ mode: "blocked", name: null, reason: "organizer_outdated", oauthOnly: false });
  });

  it("a TOMBSTONE does not decide whether the pane works", () => {
    // A `disabled` row keeps whatever role it had, so a mailbox removed last week must not be
    // able to switch the Screener off for the one still connected.
    expect(screenerMode([
      organizer(),
      reader({ status: "disabled", disabledReason: "organized_elsewhere:cloud" }),
    ]).mode).toBe("organizer");
    // …and a roster of nothing BUT tombstones is "we cannot see", not "somebody else has it".
    expect(screenerMode([
      reader({ status: "disabled", disabledReason: "organized_elsewhere:cloud" }),
    ]).mode).toBe("organizer");
  });

  it("no facts at all, and an empty roster, both organize", () => {
    expect(screenerMode(null).mode).toBe("organizer");
    expect(screenerMode([]).mode).toBe("organizer");
  });

  it("a FRESHLY CONNECTED reader nobody has agreed to is not a stand-down", () => {
    // `readerStandDown`'s own rule: the test is a named holder OR a consent stamp. A reader with
    // neither is an ordinary un-consented mailbox — the consent screen's business — and refusing
    // its Screener would be this guard firing on a first run.
    expect(screenerMode([
      reader({ organizedBy: null, organizeConsentedAt: null }),
    ]).mode).toBe("organizer");
  });

  it("a RELEASED mailbox does not organize — this account let it go, so nothing files it", () => {
    /* The state `readerStandDown` grew for the Settings row, seen from the aggregation: a mailbox
       this account released is NOT one it organizes, so the Screener must not switch back on for
       it. `no_organizer` and not `organizer_outdated`, because there is no holder to update and
       none to displace — the same distinction the row's own sentence draws.

       Watch it fail: make the released arm return `null` instead of `"released"` and this answers
       `organizer`, which would draw a full decision bar over a mailbox nothing is filing. */
    expect(screenerMode([reader({
      organizedBy: null,
      organizerState: null,
      organizeConsentedAt: "2026-09-02T09:00:00.000Z",
      organizerReleasedAt: "2026-09-04T09:12:00.000Z",
    })])).toEqual({ mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false });
  });

  it("a HOST TOO OLD to send the role organizes", () => {
    // Deploy skew, the direction `MailboxFacts.organizerRole` names: every install was an
    // organizer before the column existed, so absent must not switch the Screener off.
    expect(screenerMode([
      { status: "connected", disabledReason: null } as Row,
    ]).mode).toBe("organizer");
  });

  /* ── THE THIRD STATE ──────────────────────────────────────────────────────────────────── */

  it("a reader whose holder ACCEPTS DECISIONS is pending, not blocked", () => {
    // The whole point of the split: the bar stays, the press is real, and what changes is that
    // the filing happens on the other machine. Refusing here would withhold a control from
    // somebody whose decision would in fact be carried out.
    expect(screenerMode([reader({ organizerAcceptsRequests: true })]))
      .toEqual({ mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false });
  });

  it("ONE reader that cannot take a decision blocks the whole roster", () => {
    // The aggregation FLIPS here, and deliberately. For `organizer` the permissive direction is
    // safe (nothing that could land is refused); for `pending` it is not — the sender whose
    // mailbox is the un-accepting one would meet a refusal after the press.
    expect(screenerMode([
      reader({ organizerAcceptsRequests: true }),
      reader({ organizerAcceptsRequests: false }),
    ]).mode).toBe("blocked");
  });

  it("ABSENT is not `true` — a server that cannot say withholds the controls", () => {
    // The dangerous default is the other one: a decision bar whose every press ends in a refusal.
    expect(screenerMode([reader()]).mode).toBe("blocked");
  });

  it("EVERY reader on OAuth is flagged, so the refusal can be said to be permanent", () => {
    /* A password mailbox lets both installs derive the same signing key from the credential they
       already share; an OAuth one has no such shared secret, so no organizer can accept a decision
       from a reader however new either install is. That is the sign-in, not a version skew, and
       the pane says so instead of implying a wait. */
    expect(screenerMode([reader({ authKind: "oauth" })]).oauthOnly).toBe(true);
  });

  it("…and a MIXED roster is not, because the sentence would be wrong about one of them", () => {
    // ALL, never any: naming the limitation over a password mailbox would tell somebody their
    // sign-in is the obstacle when it is not.
    expect(screenerMode([
      reader({ authKind: "oauth" }),
      reader({ authKind: "password" }),
    ]).oauthOnly).toBe(false);
    // And a build that cannot tell says nothing.
    expect(screenerMode([reader()]).oauthOnly).toBe(false);
  });

  it("a holder whose lease LAPSED (stopped) is `no_organizer`: nothing organizes it, so nothing to update", () => {
    expect(screenerMode([reader({ organizerState: "stopped", organizeConsentedAt: "2026-09-02T09:00:00.000Z" })]))
      .toMatchObject({ mode: "blocked", reason: "no_organizer" });
    // Beside a LIVE holder that cannot take decisions, the roster is outdated and names the live one.
    expect(screenerMode([
      reader({ organizedBy: { kind: "local", name: "Laptop", since: null }, organizerState: "stopped" }),
      reader({ organizedBy: { kind: "local", name: "Office", since: null }, organizerState: "held" }),
    ])).toEqual({ mode: "blocked", name: "Office", reason: "organizer_outdated", oauthOnly: false });
    // A holder not looked at yet (`null`) reads as live — the same reading every banner makes.
    expect(screenerMode([reader({ organizerState: null })]).reason).toBe("organizer_outdated");
  });

  it("a reader with NO holder at all reports `no_organizer`, which is a different sentence", () => {
    // Nothing is filing this mailbox — the remedy is the same button, and the thing worth saying
    // is not "somebody else has it" but "nobody has it".
    expect(screenerMode([
      reader({ organizedBy: null, organizeConsentedAt: "2026-09-02T09:00:00.000Z" }),
    ])).toEqual({ mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false });
  });
});
