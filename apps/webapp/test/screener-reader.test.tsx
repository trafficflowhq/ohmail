/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/react";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { inWords, modelOf, mountPlace, sender } from "../../../packages/app/test/screener/screener-world.js";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { screenerIntentsKey, type ScreenerIntent } from "@ohmail/app-logic/screener/screener-intents";
import { screenerMode, type ScreenerRole } from "@ohmail/app-logic/mail-state/mail-state";
import type { ScreenerState } from "@ohmail/app-logic/screener/screener-state";

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
 *   · offer a filing verb in the registered Screener when the role is blocked → "the decision bar is gone"
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
const HOLDER: ScreenerRole = {
  mode: "blocked",
  name: "ohmail Cloud",
  reason: "organizer_outdated",
  oauthOnly: false,
};
/** This install organizes it — every verb works, which is what these cases contrast with. */
const ORGANIZES: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false };
/** A reader whose holder takes decisions: the bar STAYS and the press is real. */
const PENDING: ScreenerRole = { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false };
let seq = 0;
let sent: EngineMutation[] = [];
function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: "2026-09-02T09:00:00.000Z",
    folder,
    snippet: `snippet ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

/** One stranger waiting, and one already quarantined — the two segments that carry verbs. */
const HELD = msg("h1", "editors@terracereview.invalid", "ohmail/Screener");
const JUNK = msg("q1", "blast@bulk.invalid", "ohmail/Quarantine");

async function freshStore(): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  for (const m of [HELD, JUNK]) {
    await store.applyChanges([
      {
        type: "message",
        op: "create",
        id: m.id,
        seq: ++seq,
        updatedAt: m.updatedAt,
        entity: m,
      },
    ]);
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
        cursor: store.getCursor(),
        hasMore: false,
        serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, {
          now: () => NOW,
          uuid: () => `id-${++seq}`,
        }).map((e) => ({
          type: e.type,
          op: e.move ? "move" : "update",
          id: e.id,
          seq: ++seq,
          updatedAt: NOW.toISOString(),
          entity: e.entity,
          ...(e.move ? { move: e.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: "body",
        html: null,
        loadedRemoteContent: false,
        unsubscribe: "no_header",
        unsubscribeUrl: null,
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
  const { useScreenerState } = await import("@ohmail/app-logic/screener/screener-state");
  let latest: ScreenerState | null = null;
  let force: (() => void) | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    force = () => setV((x) => x + 1);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(
      engine,
      null,
      v,
      () => {},
      useScreenerWords(),
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
    root!.render(inWords(h(Probe), locale));
  });
  await settleFirstPaint();
  return {
    get: () => latest!,
    bump: async () => {
      await act(async () => {
        force?.();
      });
    },
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
  it("a journal from the session that DID organize is not replayed by a reader", async () => {
    /* The durable path's own version of the defect, and the one nobody would find by pressing
       keys: this install organized the mailbox yesterday, armed a decision, and died inside the
       undo window; today it is a reader. Replaying would file mail the engine will not move.
       Nothing is consumed — the entry stays for a boot in which this install has the mailbox
       back, and ages out on `INTENT_TTL_MS` if that never comes. */
    const armed: ScreenerIntent = {
      v: 1,
      id: HELD.id,
      dest: "ohbox",
      read: false,
      scope: "sender",
      quiet: false,
      at: NOW.getTime(),
      derived: false,
      heldIds: [],
      from: { name: null, address: HELD.from.address },
    };
    window.localStorage.setItem(screenerIntentsKey(null), JSON.stringify([armed]));

    const store = await freshStore();
    const s = await mountState(engineOver(store), HOLDER);
    await s.bump();
    await act(async () => {
      await Promise.resolve();
    });

    expect(sent, "the boot replay dispatched a decision on a mailbox this install reads").toHaveLength(0);
    expect(
      window.localStorage.getItem(screenerIntentsKey(null)),
      "the entry was consumed by an attempt that could not be made",
    ).toContain(HELD.id);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PANE — the refusal is stated BEFORE the press, and no deciding control is drawn
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

const copy = en.screener;
const destinations = [copy.pileOhbox, copy.pileReads, copy.pileReceipts, copy.pileScreenOut, copy.pileSpam];

function mountView(role: ScreenerRole) {
  const applyAll = vi.fn();
  const model = modelOf({ flushes: 0 }, {
    role,
    waiting: [sender("s1", "Terrace Review")],
    waitingCount: 1,
    suggestedCount: 1,
    suggestedDests: ["ohbox"],
    applyAll,
  });
  const { view } = mountPlace(model);
  expect(view.getByRole("option", { name: /Terrace Review/ })).toBeTruthy();
  const bar = within(view.getByRole("toolbar", { name: copy.place.panel }));
  const tools = within(view.getByRole("group", { name: copy.bulkAria }));
  return { view, bar, tools, applyAll };
}

describe("the Screener pane draws no deciding control on a reader", () => {
  it("the decision bar is GONE and the sentence names who organizes", () => {
    const { view, bar, tools } = mountView(HOLDER);
    expect(bar.getByText(copy.place.decides.replace("{name}", HOLDER.name!))).toBeTruthy();
    expect(bar.getByRole("button", { name: copy.readerBarOpenMailboxes })).toBeTruthy();
    for (const name of destinations) expect(bar.queryByRole("button", { name })).toBeNull();
    expect(view.queryByRole("button", { name: copy.place.choose })).toBeNull();
    const listMenu = tools.queryByRole("button", { name: "List" });
    if (listMenu) fireEvent.click(listMenu);
    expect(view.queryByRole("menuitem", { name: copy.markAllSpam })).toBeNull();
  });

  it("NO APPLY CONTROL AT ALL in `blocked` — a control wired to a refusal is worse than none", () => {
    // There is already a suggestion. An empty queue could also hide Apply.
    const { tools, applyAll } = mountView(HOLDER);
    expect(tools.queryAllByRole("button", { name: /^Apply/ })).toEqual([]);
    expect(applyAll).not.toHaveBeenCalled();
  });

  it("PENDING KEEPS THE BAR, and says where the decision goes instead of refusing it", () => {
    const { bar, view } = mountView(PENDING);
    for (const name of destinations) expect(bar.getByRole("button", { name })).toBeTruthy();
    expect(bar.queryByText(copy.place.decides.replace("{name}", PENDING.name!))).toBeNull();
    expect(bar.getByText(copy.pendingBarTitle.replace("{name}", PENDING.name!))).toBeTruthy();
    expect(view.getByText(copy.pendingBarWhy)).toBeTruthy();
  });

  it("CONTROL: with no holder the bar, the row menu and the bulk are all there", () => {
    const { bar, view, tools } = mountView(ORGANIZES);
    for (const name of destinations) expect(bar.getByRole("button", { name })).toBeTruthy();
    expect(view.queryByText(copy.place.decides.replace("{name}", HOLDER.name!))).toBeNull();
    expect(view.queryByText(copy.pendingBarWhy)).toBeNull();
    expect(view.getByRole("button", { name: copy.place.choose })).toBeTruthy();
    expect(tools.getByRole("button", { name: /^Apply 1/ })).toBeTruthy();
    fireEvent.click(tools.getByRole("button", { name: "List" }));
    expect(view.getByRole("menuitem", { name: copy.markAllSpam })).toBeTruthy();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE DERIVATION — one predicate, aggregated by the ruling's own test
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

type Row = Parameters<typeof screenerMode>[0] extends ReadonlyArray<infer R> | null ? R : never;

const reader = (over: Partial<Row> = {}): Row =>
  ({
    status: "connected",
    disabledReason: null,
    organizerRole: "reader",
    organizedBy: { kind: "cloud", name: "ohmail Cloud", since: "2026-09-02T09:00:00.000Z" },
    organizeConsentedAt: null,
    ...over,
  }) as Row;

const organizer = (over: Partial<Row> = {}): Row =>
  ({
    status: "connected",
    disabledReason: null,
    organizerRole: "organizer",
    organizedBy: null,
    organizeConsentedAt: "2026-09-02T09:00:00.000Z",
    ...over,
  }) as Row;

describe("screenerMode — what the Screener may do on this install", () => {
  /* The three answers, and the two that are new. `organizer` is what `screenerReadOnly` used to
     answer `null` for; `blocked` is what it answered a holder for; `pending` did not exist,
     because until the decision channel there was nowhere for a reader's press to go. Every row
     below that used to assert `toBeNull()` now asserts `mode: "organizer"` and every row that
     asserted a holder object now asserts `blocked` with that holder — the same claims, re-aimed
     at the shape that can express the third state. */

  it("a lone organizer organizes", () => {
    expect(screenerMode([organizer()]).mode).toBe("organizer");
  });

  it("A MIXED ROSTER organizes — one organizer is enough for the pane to work", () => {
    // `ONBOARDING-RULINGS.md` 1(b): permitted iff the account holds ≥1 organizer. The safe
    // direction of the two — with an organizer present, no decision that could land is refused.
    expect(screenerMode([reader(), organizer()]).mode).toBe("organizer");
    expect(screenerMode([organizer(), reader()]).mode).toBe("organizer");
  });

  it("a TOMBSTONE does not decide whether the pane works", () => {
    // A `disabled` row keeps whatever role it had, so a mailbox removed last week must not be
    // able to switch the Screener off for the one still connected.
    expect(
      screenerMode([organizer(), reader({ status: "disabled", disabledReason: "organized_elsewhere:cloud" })])
        .mode,
    ).toBe("organizer");
    // …and a roster of nothing BUT tombstones is "we cannot see", not "somebody else has it".
    expect(
      screenerMode([reader({ status: "disabled", disabledReason: "organized_elsewhere:cloud" })]).mode,
    ).toBe("organizer");
  });

  it("no facts at all, and an empty roster, both organize", () => {
    expect(screenerMode(null).mode).toBe("organizer");
    expect(screenerMode([]).mode).toBe("organizer");
  });

  it("a FRESHLY CONNECTED reader nobody has agreed to is not a stand-down", () => {
    // `readerStandDown`'s own rule: the test is a named holder OR a consent stamp. A reader with
    // neither is an ordinary un-consented mailbox — the consent screen's business — and refusing
    // its Screener would be this guard firing on a first run.
    expect(screenerMode([reader({ organizedBy: null, organizeConsentedAt: null })]).mode).toBe("organizer");
  });

  it("a HOST TOO OLD to send the role organizes", () => {
    // Deploy skew, the direction `MailboxFacts.organizerRole` names: every install was an
    // organizer before the column existed, so absent must not switch the Screener off.
    expect(screenerMode([{ status: "connected", disabledReason: null } as Row]).mode).toBe("organizer");
  });
});
