/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, FOLDER_OF_VIEW, type EngineMutation } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * TWO CLAIMS THE SHELL MAKES, DRIVEN THROUGH THE SHELL.
 *
 *   · clicking a sender's circle or address IN A LIST opens their screening, and
 *     choosing a destination puts the right thing on the wire. `sender-screening.test.ts`
 *     pins the mutation planning; this pins the part that only exists once it is wired: a
 *     capture-phase handler on the stage, one for every view, that must not be swallowed
 *     by the row's own click.
 *   · marking a multi-selection read is ONE request for N messages, not N requests.
 *     The engine mutation and the 200-id cap were built and tested with that change; what nobody
 *     had asserted is that the affordance dispatches once.
 *
 * Both count mutations at the ADAPTER, which is the last thing before the wire. Counting
 * calls to a React callback would prove only that the callback was called.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

// jsdom ships no `CSS` object, and the shell uses `CSS.escape` to find a row by id — the
// same call every browser has had since 2016. Supplying it keeps the test honest about
// which code path runs rather than routing around it.
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Every mutation the demo adapter was asked to perform, in order. */
let sent: EngineMutation[] = [];

function setViewport(mobile: boolean): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: mobile && query.includes("max-width"),
      media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The module a mount imports, so the warm-up loads exactly it. */
const shellModule = () => import("../app/shell/AppShell.js");

async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await shellModule();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  /**
   * …AND THEN PUT THE CURSOR ON THE FIRST ROW.
   *
   * The Ohbox no longer selects anything by itself: the shell's `?? allOhbox[0]` — which used
   * to make the newest unread message "the selection" before anybody had chosen it, and open it
   * in the reading column — is deleted. Every claim below starts from a cursor (`x` picks at
   * one, `s` screens the message under one, `u` acts on one), so the first act is made
   * explicitly here. It lands the cursor exactly where the old fallback did, so nothing else in
   * this file changes.
   */
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
  });
}

/** The toasts SAYING something — the host keeps its Undo and notice slots mounted at rest. */
const saying = (): string[] =>
  [...host!.querySelectorAll(".toast")].map((t) => (t.textContent ?? "").trim()).filter((t) => t.length > 0);

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
};

const click = async (el: Element | null | undefined, init: MouseEventInit = {}): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
};

const rows = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".view-ohbox .row[data-id]")];
const kinds = (kind: string) => sent.filter((m) => m.kind === kind);

/* ── the selection's bar ─────────────────────────────────────────────── */

/* `.list-foot` since 0.15.0: the selection's verbs are the message pill, standing in the list
   column's FOOT slot, where the key-hint strip stands when nothing is picked. Nothing else about
   these helpers changed — the pill holds the same `button`s in the same row order. */
const barButtons = (): HTMLButtonElement[] =>
  [...host!.querySelectorAll<HTMLButtonElement>(".list-foot button")];
const barLabels = (): string[] => barButtons().map((b) => (b.textContent ?? "").trim());
/** A bar control by the START of its label — the labels carry keycaps and arrows. */
const barButton = (label: string): HTMLButtonElement | undefined =>
  barButtons().find((b) => (b.textContent ?? "").trim().startsWith(label));
const confirmRow = (): string => host!.querySelector(".list-foot .abar-lab")?.textContent ?? "";
/**
 * THE SELECTION'S COUNT, off the pill's leading capsule — `null` when nothing is picked.
 *
 * `textContent).toContain("3 selected")` over the shell worked while the count was one string
 * in a wash strip. The capsule renders "× 3 selected esc" as separate nodes so the WORD can
 * fold out at narrow widths while the number stays, so a scan now reads "×3selectedesc".
 * Reading the live region is exact, and it is the node that is actually announced.
 */
const pickCount = (): string | null =>
  host!.querySelector('.list-foot .abar-count [role="status"]')?.textContent ?? null;

/** Pick `n` rows from the cursor with the keys that make a pick. */
const pick = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await key("x");
    if (i < n - 1) await key("j");
  }
};

/**
 * The cold `AppShell` import, loaded once: 85% of the first case's time (1694 ms cold, 221 ms
 * warm; 5.06 s once on a loaded VM), so the case stays on 5 s. 24-38 s in 20 runs under
 * CPUQuota=10%.
 */
const WARM_BUDGET_MS = 60_000;
beforeAll(async () => { await shellModule(); }, WARM_BUDGET_MS);

beforeEach(() => {
  vi.useFakeTimers();
  setViewport(false);
  window.location.hash = "#/ohbox";
  sent = [];
  // The demo adapter IS the transport here, so spying on it counts what would have been a
  // request — the unit the claim is stated in.
  //
  // It CALLS THROUGH, and that is not politeness. A mock that answers `{changes: []}` is
  // authoritatively saying "the server did nothing", so the engine drops its optimistic
  // overlay and the row never changes on screen. Every assertion about what happens NEXT —
  // the dwell, a second `u`, a row leaving New — would then be measuring a world frozen at
  // mount, and would pass no matter what the code did.
  //
  // ALL the arguments are forwarded, including the second one the engine passes: dropping
  // `opts` makes the adapter throw on `idempotencyKey`, the engine rolls the optimistic
  // overlay back, and the list silently stops responding to anything — which again means
  // every downstream assertion passes for the wrong reason.
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a sender's screening, from a list row", () => {
  it("every Ohbox row leads with the sender circle", async () => {
    await mountShell();
    expect(rows().length).toBeGreaterThan(0);
    for (const row of rows()) {
      expect(row.querySelector(".av"), `${row.dataset.id} has no avatar`).toBeTruthy();
    }
  });

  it("the circle's colour is a function of the ADDRESS, so one person is one colour", async () => {
    // Derive it from the display name, or from anything that varies between messages, and
    // the same correspondent changes colour down the list — which is worse than no colour,
    // because the colour is then actively misleading. Same address, same hue; different
    // address, an angle from the same fixed muted ramp and not the full wheel.
    const { avatarHue } = await import("../app/shell/format.js");
    expect(avatarHue("lena@atelier.example")).toBe(avatarHue("  LENA@Atelier.Example "));

    await mountShell();
    const seen = new Map<string, string>();
    for (const row of rows()) {
      const address = row.querySelector(".addr")?.textContent ?? "";
      const hue = row.querySelector<HTMLElement>(".av")!.style.getPropertyValue("--av-h");
      expect(hue, `${address} has no derived hue`).not.toBe("");
      expect(String(avatarHue(address))).toBe(hue);
      if (seen.has(address)) expect(seen.get(address)).toBe(hue);
      seen.set(address, hue);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("the open message wears the same circle as its row", async () => {
    await mountShell();
    const row = host!.querySelector<HTMLElement>(".view-ohbox .row.sel") ?? rows()[0]!;
    const pane = host!.querySelector<HTMLElement>(".read-col .msg-sender .av")!;
    expect(pane.style.getPropertyValue("--av-h"))
      .toBe(row.querySelector<HTMLElement>(".av")!.style.getPropertyValue("--av-h"));
  });

  it("clicking the circle opens screening INSTEAD of moving the cursor", async () => {
    // The capture-phase handler has to win: `MessageRow` is itself a `<button>`, so without
    // `stopPropagation` this would both open the popover and select (or open) the row.
    await mountShell();
    const target = rows()[1]!;
    const before = host!.querySelector(".view-ohbox .row.sel")?.getAttribute("data-id") ?? null;

    await click(target.querySelector(".av"));

    const menu = host!.querySelector(".senderm");
    expect(menu, "no screening popover opened").toBeTruthy();
    expect(host!.querySelector(".view-ohbox .row.sel")?.getAttribute("data-id") ?? null).toBe(before);
    expect(host!.querySelector(".reader")).toBeNull();
  });

  it("clicking the ADDRESS does the same — the literal request", async () => {
    await mountShell();
    await click(rows()[0]!.querySelector(".addr"));
    expect(host!.querySelector(".senderm")).toBeTruthy();
  });

  it("SHIFT-click is left alone — that gesture belongs to range selection", async () => {
    await mountShell();
    await click(rows()[1]!.querySelector(".addr"), { shiftKey: true });
    expect(host!.querySelector(".senderm")).toBeNull();
  });

  /**
   * ── CHANGED WHAT THIS CLICK DOES, THROUGH THE SHELL ────────────────────────────────
   *
   * This test read *"…and says no rule was made"* and asserted `toastMoved`. That was the
   * whole truth while `screener_decide` was the only rule-creating verb: fixture Ohbox mail is
   * not held in `ohmail/Screener`, the endpoint would 404, and the composition was moves only.
   *
   * The opposite was asked for as the DEFAULT — *"allow it to actually create the
   * rule … this should be the default behaviour"* — so the click now puts `rule_create` on the
   * wire as well, and the sentence follows. The old assertion is not dropped: it moved onto the
   * opt-out below, where it is still exactly true. `screener_decide` staying absent is the
   * unchanged half, and it is still the difference between working and a 404 under a success
   * toast.
   */
  it("choosing a destination rules on that sender and asks the pass for their mail, by default", async () => {
    await mountShell();
    await click(rows()[0]!.querySelector(".av"));
    const reads = [...host!.querySelectorAll<HTMLElement>(".senderm li")]
      .find((li) => li.textContent?.startsWith("News"))!;
    await click(reads);
    await act(async () => { await Promise.resolve(); });

    expect(kinds("screener_decide")).toEqual([]);
    // THE-CLIENTS-FIFTY: the rule's backlog is the server pass's, so the press moves none of it.
    expect(kinds("move")).toEqual([]);
    // THE VERB REACHED THE ADAPTER — the last thing before the wire, and the exact place the
    // unbuildable version of this slice would have shown nothing at all.
    expect(kinds("rule_create")).toEqual([
      expect.objectContaining({ ruleKind: "sender", destination: "ohmail/News", applyRetro: true }),
    ]);
    expect(host!.querySelector(".toast")?.textContent ?? "").toContain("Future mail from them files there too");
    expect(host!.querySelector(".senderm")).toBeNull();
  });

  /**
   * THE OPT-OUT, THROUGH THE SHELL. The sentence this file used to assert as the
   * default is still here, still exactly true, and now reachable only by turning the rule off
   * — which is what "the non-rule move must remain reachable as the explicit non-default"
   * means in practice. Hardcode `makeRule` anywhere between the toggle and the adapter and
   * this goes red while the test above stays green.
   */
  it("turning the rule off restores the old behaviour, sentence and all", async () => {
    await mountShell();
    await click(rows()[0]!.querySelector(".av"));
    await click(host!.querySelector(".senderm .sm-rule"));
    await click([...host!.querySelectorAll<HTMLElement>(".senderm li")]
      .find((li) => li.textContent?.startsWith("News"))!);
    await act(async () => { await Promise.resolve(); });

    expect(kinds("rule_create")).toEqual([]);
    expect(kinds("rule_update")).toEqual([]);
    expect(kinds("move").length).toBeGreaterThan(0);
    expect(host!.querySelector(".toast")?.textContent ?? "").toContain("No rule was made");
  });

  /**
   * THE LADDER, AT THE SHELL, AGAINST A REAL MIRROR. `FixturesAdapter` applies `rule_create`
   * authoritatively, so by the second click the mirror genuinely holds the row and
   * `senderScreening` genuinely reads it back — which is the only way to prove the dedup sees
   * rules that arrived through `/sync` rather than ones a test handed it.
   *
   * Ohbox is the destination on purpose: the sender's mail is already there, so nothing moves
   * and the row keeps its place under the second click. Remove the `already` branch and the
   * second click mints a second identical rule.
   */
  it("clicking the same destination twice makes ONE rule, not one per click", async () => {
    await mountShell();
    const id = rows()[0]!.getAttribute("data-id")!;
    const avatar = () => host!.querySelector<HTMLElement>(`.view-ohbox .row[data-id="${id}"] .av`);
    const ohbox = () => [...host!.querySelectorAll<HTMLElement>(".senderm li")]
      .find((li) => li.textContent?.startsWith("Ohbox"));

    await click(avatar());
    await click(ohbox());
    await act(async () => { await Promise.resolve(); });
    expect(kinds("rule_create"), "the first click made no rule").toHaveLength(1);
    // A rule with NOTHING to move is the ordinary case for the destination the mail is
    // already in, and "0 messages moved" reads like a bug. The `=0` arm is asserted here
    // because a malformed nested plural renders raw rather than throwing.
    expect(host!.querySelector(".toast")?.textContent ?? "")
      .toBe("Ohbox — their mail is already there. Future mail from them files there too.");

    await click(avatar());
    await click(ohbox());
    await act(async () => { await Promise.resolve(); });
    expect(kinds("rule_create"), "still ONE rule — the second press writes no second row").toHaveLength(1);
    // 0.19: the second press is no longer a no-op. The rule already files their future mail there,
    // and with the past-mail option on the press re-arms it for the mail already filed — so the
    // sentence names what just happened instead of saying nothing did.
    expect(kinds("rule_update"), "the standing rule is asked for the backlog").toHaveLength(1);
    expect(host!.querySelector(".toast")?.textContent ?? "")
      .toContain("a rule was already sending their future mail there");
    expect(host!.querySelector(".toast")?.textContent ?? "")
      .toContain("applying it to the mail it has already filed");
  });

  it("the open message offers it too — the UX suite looks for exactly this control", async () => {
    await mountShell();
    // The label carries its keycap ("Screening" + `s`), which is why this is a prefix
    // match — and why the live check's /screen/i regex finds it on the live site.
    const labels = [...host!.querySelectorAll(".read-col .msg-actions button")]
      .map((b) => (b.textContent ?? "").trim());
    expect(labels.some((l) => l.startsWith("Screening")), labels.join(" · ")).toBe(true);
    await click([...host!.querySelectorAll(".read-col .msg-actions button")]
      .find((b) => (b.textContent ?? "").trim().startsWith("Screening")));
    expect(host!.querySelector(".senderm")).toBeTruthy();
  });

  it("the from-line address is a real control, not a span with a handler", async () => {
    await mountShell();
    const sender = host!.querySelector<HTMLButtonElement>(".read-col .msg-sender");
    expect(sender?.tagName).toBe("BUTTON");
    await click(sender);
    expect(host!.querySelector(".senderm")).toBeTruthy();
  });

  it("s opens it for the message at the cursor", async () => {
    await mountShell();
    await key("s");
    expect(host!.querySelector(".senderm")).toBeTruthy();
  });
});

describe("marking a selection read is ONE request", () => {
  it("three picked rows produce one mark_seen carrying three ids", async () => {
    // THE GUARD. Loop the selection and dispatch per id — the obvious implementation — and
    // this goes red: three requests, three transactions, three chances to half-apply. The
    // server's batch route and its 200-id cap exist precisely so the client does not.
    //
    // Driven from the keyboard on purpose. A click on the row the cursor is already on is
    // an OPEN, which marks it read, which re-partitions New/Earlier and reorders the list
    // under the very selection being built.
    await mountShell();
    await key("x");
    await key("j");
    await key("x");
    await key("j");
    await key("x");
    expect(pickCount()).toBe("3");

    sent = [];
    // BY NAME since that change. The bar carries eight verbs now, so "the first button in the
    // pick bar" is no longer the read control — it is Tag. The claim is unchanged.
    await click(barButton("Read")); // the read PAIR's first direction — "Read | Unread"

    expect(kinds("mark_seen")).toHaveLength(1);
    expect((kinds("mark_seen")[0] as { messageIds: string[] }).messageIds).toHaveLength(3);
    expect((kinds("mark_seen")[0] as { unread: boolean }).unread).toBe(false);
  });

  it("shift-click extends the range and marks the whole run in one go", async () => {
    await mountShell();
    await key("x");                                     // anchor at the cursor
    const order = rows().map((r) => r.dataset.id!);
    const anchor = host!.querySelector<HTMLElement>(".view-ohbox .row.sel")!.dataset.id!;
    const target = order[order.indexOf(anchor) + 3]!;

    await click(rows().find((r) => r.dataset.id === target), { shiftKey: true });
    expect(pickCount()).toBe("4");

    sent = [];
    await click(barButton("Read")); // the read PAIR's first direction — "Read | Unread"
    expect(kinds("mark_seen")).toHaveLength(1);
    expect((kinds("mark_seen")[0] as { messageIds: string[] }).messageIds).toHaveLength(4);
  });

  it("marking the selection read still says so in one sentence, not N", async () => {
    await mountShell();
    await key("x");
    await key("j");
    await key("x");
    await click(barButton("Read")); // the read PAIR's first direction — "Read | Unread"
    expect(saying(), "one sentence, not N").toHaveLength(1);
    expect(host!.querySelector(".toast")?.textContent ?? "").toContain("2 messages");
  });

  it("u marks a message unread and the 2 s dwell does NOT undo it", async () => {
    // In the split pane the cursor stays on the row `u` just acted on, so the dwell that
    // marks a dwelt-upon message read would fire two seconds later and revert an explicit
    // instruction. Remove the pin in `OhboxView` and this goes red — which is the state
    // `u` shipped in, and it is documented in the `?` sheet as "mark read / unread".
    await mountShell();
    // Walk to a row that is ALREADY read, so `u` means "make this unread" — the direction
    // the dwell can undo.
    let cursor = host!.querySelector<HTMLElement>(".view-ohbox .row.sel")!;
    for (let i = 0; i < 12 && cursor.getAttribute("data-unseen"); i++) {
      await key("j");
      cursor = host!.querySelector<HTMLElement>(".view-ohbox .row.sel")!;
    }
    expect(cursor.getAttribute("data-unseen"), "never reached a read row").toBeNull();
    const id = cursor.dataset.id!;
    sent = [];

    await key("u");
    expect(kinds("mark_seen")).toEqual([
      expect.objectContaining({ messageIds: [id], unread: true }),
    ]);

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(kinds("mark_seen"), "the dwell reverted an explicit `u`").toHaveLength(1);
  });
});

/**
 * ═══ THE SELECTION'S VERBS ══════════════════════════════════════
 *
 * Reported: *"when selecting multiple message the options should not only be mark unseen or
 * read or esc but also set their screener type and edit tags etc."*
 *
 * Confirmed exactly before this slice: ⇧U and Escape, in one view. What the bar offers now
 * is the MESSAGE action bar's own grouping minus Reply — and the assertions below are
 * about the two things that grouping cannot carry over unchanged: read state is a direction
 * rather than a toggle, and screening keeps a ceremony the other verbs do not have.
 */
describe("a selection offers the verbs a single message does", () => {
  it("the bar carries the action bar's verbs, not only mark-read and clear", async () => {
    // THE GUARD, and it is the report as a list. Restore the two-button pick bar
    // and every name below except the read pair disappears.
    await mountShell();
    await pick(2);
    const labels = barLabels();
    /* BY THE START OF THE LABEL, not by substring anywhere in a joined string. "Read" is a
       substring of "Unread", so a joined `toContain("Read")` passed on a bar that had lost the
       Read direction entirely and kept only Unread — the exact regression the read PAIR exists
       to prevent. Each verb must be the beginning of some button's own label. */
    for (const verb of ["Later", "Park", "Resurface", "Screening", "Move", "Read", "Unread", "Tag"]) {
      expect(
        labels.some((l) => l.startsWith(verb)),
        `the selection cannot ${verb} — labels were ${labels.join(" · ")}`,
      ).toBe(true);
    }
    // …and NOT Reply, Reply all or Forward, none of which mean anything over a set.
    expect(labels.join(" · ")).not.toContain("Reply");
    expect(labels.join(" · ")).not.toContain("Forward");
  });

  it("the three horizons queue every picked message, in one sentence", async () => {
    await mountShell();
    await pick(3);
    const ids = rows().filter((r) => r.classList.contains("picked")).map((r) => r.dataset.id!);
    expect(ids).toHaveLength(3);

    sent = [];
    await click(barButton("Later"));
    expect(kinds("triage_set").map((m) => (m as { messageId: string }).messageId).sort())
      .toEqual([...ids].sort());
    expect(kinds("triage_set").every((m) => (m as { state: string }).state === "reply_later")).toBe(true);
    expect(saying(), "one sentence, not N").toHaveLength(1);
  });

  it("Unread is a DIRECTION over a set, never a toggle", async () => {
    // A selection has a mixed read state, so `!m.unread` per message would mark some read
    // and some unread in a gesture that reads as one decision. Implement it as the
    // single-message flip and this goes red the moment the set spans both states.
    await mountShell();
    await pick(3);
    sent = [];
    await click(barButton("Unread"));
    expect(kinds("mark_seen")).toHaveLength(1);
    expect((kinds("mark_seen")[0] as { unread: boolean }).unread).toBe(true);
    expect((kinds("mark_seen")[0] as { messageIds: string[] }).messageIds).toHaveLength(3);
  });

  /**
   * THE VERB WRITES ROUTING **AND** MOVES THE MAIL, and this case says both.
   *
   * `ohmail/News` and `ohmail/Receipts` are real IMAP folders — `FOLDER_OF_VIEW` maps them,
   * `physicalFolderOf` reads them, and the sender's rule routes FUTURE mail into the same folder.
   * So a Move press writes where that sender's mail goes from now on and moves the messages it
   * was made on. It briefly said the opposite here — "Reads and Receipts are what a sender's rule
   * says, not folders mail sits in" — and that sentence was refuted by the architecture and by the
   * code; a press that wrote a rule and moved nothing is the defect, not the contract.
   *
   * One statement, two files: `bulk-move-writes-routing.test.tsx` says the same thing over the
   * narrowing and the sentence. Mutation: drop the mint from `planMoveToPlace` and both go red by
   * name. A destination with no folder at all still moves nothing — the case below.
   */
  /**
   * WHAT MOVED HERE IS THE ROUTING'S TIMING, not the pair. The rule is HELD for the undo window,
   * so this file reads the press — mail on the wire, rule not yet — and the sibling, which waits
   * out the real `UNDO_MS`, reads the rule where it lands. Asserting it here cost nine seconds
   * and every case after it: measured, the whole file timed out.
   */
  it("Move over a selection writes routing AND moves the picked messages", async () => {
    await mountShell();
    await pick(3);

    sent = [];
    await click(barButton("Move"));
    await click(barButton("→ News"));

    /* THE MAIL GOES NOW AND THE ROUTING WAITS — the undo this press carries. Nothing about the
       sender's future mail is on the wire while the toast stands, so there is something left to
       take back; the rule follows when the window closes. */
    expect(sent.filter((m) => m.kind.startsWith("rule_")),
      "a rule went out inside the undo window — there would be nothing left to undo").toEqual([]);

    // …AND the mail, one move per picked message, into the destination's own folder.
    const moves = kinds("move") as Array<{ messageId: string; folder: string }>;
    expect(moves.length, "the selection's Move moved nothing").toBe(3);
    expect([...new Set(moves.map((m) => m.folder))], "a move went somewhere else")
      .toEqual(["ohmail/News"]);
    expect(new Set(moves.map((m) => m.messageId)).size, "one message was moved twice").toBe(3);

    // One sentence for the whole press, counting both.
    expect(host!.querySelector(".toast")?.textContent ?? "")
      .toMatch(/Mail from [1-9]\d* senders? now goes to News — [1-9]\d* messages? moved\./);
  });

  /**
   * AND THE ARM THAT REFUSES A FOLDERLESS DESTINATION IS A BELT, which is worth saying plainly
   * rather than dressing as a case it is not. `onBulkAction` returns early on `!FOLDER_OF_VIEW
   * [view]`, and every destination the bar offers HAS a folder — so from this surface the arm
   * cannot be reached and a test driving the bar could only pretend to exercise it. What is
   * measurable here is the premise the mint rests on: the press always has a real folder to move
   * into, so "writes routing and moves nothing" is never the correct answer for these buttons.
   */
  it("every destination the bar offers is a real folder — the mint always has somewhere to move to", async () => {
    await mountShell();
    await pick(3);
    const offered = barButtons()
      .map((b) => (b.textContent ?? "").trim())
      .filter((t) => t.startsWith("→"));
    expect(offered.length, "the Move bar offered no destinations").toBe(0);
    await click(barButton("Move"));
    const places = barButtons()
      .map((b) => (b.textContent ?? "").trim())
      .filter((t) => t.startsWith("→"));
    expect(places.length, "the Move bar offered no destinations").toBeGreaterThan(0);
    const folders = Object.values(FOLDER_OF_VIEW);
    expect(folders.every((f) => typeof f === "string" && f.length > 0),
      "a view the bar can offer has no folder to move into").toBe(true);
  });
});

describe("a bulk screening decision states what will PERSIST before it commits", () => {
  it("choosing a destination shows the counts and dispatches NOTHING", async () => {
    // THE GUARD, and it is the consent boundary. A bulk apply that fires on the
    // destination click is the defect the ruling names: a selection routinely mixes senders
    // who are waiting (a permanent rule) with senders who are not (a one-off move), and the
    // user would learn which they had done from the toast, afterwards. Wire the destination
    // straight to `onBulkScreen` and this goes red on the empty-mutation assertion.
    await mountShell();
    await pick(3);

    sent = [];
    await click(barButton("Screening"));
    await click(barButton("→ News"));

    expect(sent, "a screening decision committed before it was confirmed").toEqual([]);
    expect(confirmRow()).toContain("News");
    expect(confirmRow()).toMatch(/\d+ (sender|senders)/);
    expect(confirmRow()).toMatch(/\d+ messages? moves?/);
    expect(barButton("Screen them"), "no way to commit").toBeTruthy();
  });

  it("the stated sender count is SENDERS, not the size of the selection", async () => {
    // The number that makes the row worth reading. Count the picked ids instead and the row
    // says "3 senders" for three messages from one person, and the message count would be
    // wrong in the other direction — a plan moves that sender's WHOLE bag, not the picks.
    await mountShell();
    await pick(3);
    const senders = new Set(
      rows()
        .filter((r) => r.classList.contains("picked"))
        .map((r) => r.querySelector(".addr")?.textContent ?? ""),
    );
    await click(barButton("Screening"));
    await click(barButton("→ News"));
    expect(confirmRow()).toContain(
      senders.size === 1 ? "1 sender" : `${senders.size} senders`,
    );
  });

  it("the fixture selection makes NO rule, and the row says so rather than implying one", async () => {
    // `POST /screener/:id` resolves only mail still held in `ohmail/Screener`, so Ohbox mail
    // is a composition of moves with no lasting effect. Saying "this becomes a rule" here
    // would promise an effect the server never had — the same claim `toastMoved` refuses.
    await mountShell();
    await pick(2);
    await click(barButton("Screening"));
    await click(barButton("→ News"));
    expect(confirmRow()).toContain("No rule is made");
    expect(confirmRow()).not.toContain("There is no undo");
  });

  it("confirming runs the SAME per-sender plan — the whole bag, once each, no shortcut", async () => {
    // Structural guard for risk 4 in the ruling: "the bulk planner is the same
    // `planScreeningChange` per sender". Substitute a loop that moves the picked ids and
    // this goes red — the plan moves every message those senders hold, so the dispatched
    // count is the confirm row's count and not the selection's.
    await mountShell();
    await pick(3);
    await click(barButton("Screening"));
    await click(barButton("→ News"));
    const stated = Number(/(\d+) messages? moves?/.exec(confirmRow())?.[1] ?? "-1");
    expect(stated).toBeGreaterThan(0);

    sent = [];
    await click(barButton("Screen them"));

    const moved = kinds("move") as Array<{ messageId: string; folder: string }>;
    expect(moved).toHaveLength(stated);
    expect(new Set(moved.map((m) => m.messageId)).size).toBe(moved.length);
    expect(moved.every((m) => m.folder === "ohmail/News")).toBe(true);
    expect(kinds("screener_decide"), "no fixture sender is waiting").toEqual([]);
    expect(host!.querySelector(".toast")?.textContent ?? "").toContain("No rule was made");
  });

  it("screening a selection that is ALREADY where it is going dispatches nothing", async () => {
    // THE GUARD against the shortcut, and the one case where the two implementations
    // visibly disagree. `planScreeningChange` filters out messages that are already in the
    // destination, so screening Ohbox mail to the Ohbox is a plan of length zero; a
    // hand-rolled "move each picked id" would move three messages into the folder they are
    // already in, and report it. Substitute that loop for `planBulkScreening` and this goes
    // red twice — the confirm row would offer a live button, and pressing it would dispatch.
    await mountShell();
    await pick(3);
    await click(barButton("Screening"));
    await click(barButton("→ Ohbox"));

    expect(confirmRow()).toContain("already in Ohbox");
    expect(barButton("Screen them")?.disabled, "an inert action was offered as live").toBe(true);

    sent = [];
    await click(barButton("Screen them"));
    expect(sent, "a no-op screening put mutations on the wire").toEqual([]);
  });

  it("Escape cancels the confirm row FIRST, and clears the selection second", async () => {
    // The ruling's Escape order, and the rule that it is stated where precedence lives.
    // Swap the two bindings in `OhboxView`'s array and this goes red: one Escape would
    // discard both the confirmation and the set the user had built.
    await mountShell();
    await pick(3);
    await click(barButton("Screening"));
    await click(barButton("→ News"));
    expect(barButton("Screen them")).toBeTruthy();

    await key("Escape");
    expect(barButton("Screen them"), "the confirm row survived Escape").toBeFalsy();
    expect(pickCount(), "the selection was cleared by the same press").toBe("3");

    await key("Escape");
    expect(host!.querySelector(".list-foot")).toBeNull();
  });
});

describe("tags over a selection", () => {
  it("the picker opens for the SET and fans `tag_assign` out over it", async () => {
    await mountShell();
    await pick(3);
    const ids = rows().filter((r) => r.classList.contains("picked")).map((r) => r.dataset.id!);

    await click(barButton("Tag"));
    const picker = host!.querySelector(".tagp");
    expect(picker, "no tag picker opened for the selection").toBeTruthy();

    sent = [];
    await click(picker!.querySelector(".tagp-row, li, button"));
    const assigned = kinds("tag_assign") as Array<{ messageId: string; assigned: boolean }>;
    // MORE THAN ONE, which is the whole claim. `TagPickerState` carries a single `forId`, so
    // the tempting implementation — open the picker on the first picked id and let the
    // existing `toggleTag` run — tags exactly one message and looks like it worked. That is
    // what this number refuses.
    expect(assigned.length, "the picker tagged one message, not the selection")
      .toBeGreaterThan(1);
    // Only messages that would CHANGE, and never one outside the selection.
    for (const m of assigned) expect(ids).toContain(m.messageId);
    expect(new Set(assigned.map((m) => m.messageId)).size).toBe(assigned.length);
  });
});
