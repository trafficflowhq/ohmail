/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MirrorStore,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { organizerNotices, type OrganizerNotice as NoticeFact } from "../app/shell/mail-state";
import { OrganizerNotice } from "../app/shell/OrganizerNotice";
import { ScreenerView } from "../app/views/ScreenerView";
import { KeymapProvider } from "../app/shell/keymap";
import type { PendingDecision, ScreenerState } from "../app/shell/screener-state";

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
 * Both were run.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-04T10:00:00.000Z");
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  /* `scrollTo` is not implemented in jsdom and the read column calls it when a selection lands.
     Stubbed on the prototype rather than per element, because the node the view scrolls is one it
     creates itself. Nothing here asserts on scrolling. */
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   1 · THE DERIVATION — `organizer_event_at > organizer_event_seen_at`, and nothing else
   ══════════════════════════════════════════════════════════════════════════════════════════ */

type Row = Parameters<typeof organizerNotices>[0] extends ReadonlyArray<infer R> | null ? R : never;

const EARLIER = "2026-09-04T09:00:00.000Z";
const LATER = "2026-09-04T09:30:00.000Z";

const row = (over: Partial<Row> = {}): Row => ({
  id: "mb1",
  address: "person@example.com",
  status: "connected",
  disabledReason: null,
  organizerRole: "reader",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: EARLIER },
  organizeConsentedAt: EARLIER,
  organizerState: "held",
  organizerEventAt: LATER,
  organizerEventSeenAt: null,
  ...over,
} as Row);

describe("organizerNotices — a change nobody has acknowledged", () => {
  it("an unacknowledged change is one notice, naming the holder and the mailbox", () => {
    expect(organizerNotices([row()])).toEqual([{
      id: "mb1", address: "person@example.com", kind: "elsewhere", name: "ohmail Cloud", at: LATER, order: 0,
    }]);
  });

  it("IT IS GONE ONCE ACKNOWLEDGED — the whole of once-per-change", () => {
    expect(organizerNotices([row({ organizerEventSeenAt: LATER })])).toEqual([]);
    expect(organizerNotices([row({ organizerEventSeenAt: "2026-09-04T09:45:00.000Z" })])).toEqual([]);
  });

  it("…and a LATER change re-shows it, over the same acknowledgement", () => {
    // The property that makes an acknowledgement an answer to ONE change rather than a mute.
    const again = organizerNotices([row({
      organizerEventSeenAt: EARLIER, organizerEventAt: LATER,
    })]);
    expect(again).toHaveLength(1);
  });

  it("a build that cannot tell says NOTHING, in both directions", () => {
    // Absent `event_at` is an older server, not a change. Inventing one would put a sentence
    // about a machine handover over every mailbox of every older deployment.
    expect(organizerNotices([row({ organizerEventAt: undefined })])).toEqual([]);
    expect(organizerNotices([row({ organizerEventAt: null })])).toEqual([]);
    // An UNPARSEABLE acknowledgement is not evidence the change was never seen either — treating
    // it as such would re-show a dismissed line on every poll.
    expect(organizerNotices([row({ organizerEventSeenAt: "not a date" })])).toEqual([]);
    expect(organizerNotices(null)).toEqual([]);
  });

  it("a TOMBSTONE is not news about organizing", () => {
    expect(organizerNotices([row({ status: "disabled" })])).toEqual([]);
  });

  it("two kinds are news, told apart by the row, not by a stored kind", () => {
    expect(organizerNotices([row()])[0]!.kind).toBe("elsewhere");
    expect(organizerNotices([row({ organizerState: "stopped" })])[0]!.kind).toBe("stopped");
  });

  it("THIS INSTALL ORGANIZING IS NEVER A NOTICE — the stack after a paid reopening", () => {
    /* The reported screen: one roster pass promoted five parked rows, each with a fresh
       unacknowledged event, and each drew "You organize … here now" over the mail. The person
       asked for it (consent, payment); the sync line already says organizing. */
    const five = ["a", "b", "c", "d", "e"].map((id) => row({
      id, organizerRole: "organizer", organizedBy: null, organizerState: null,
    }));
    expect(organizerNotices(five)).toEqual([]);
    // Absent role reads as organizer, the role's default on this surface.
    expect(organizerNotices([row({ organizerRole: undefined, organizedBy: null })])).toEqual([]);
  });

  it("a RELEASE the person pressed is never a notice either", () => {
    expect(organizerNotices([row({
      organizedBy: null, organizerState: null, organizerReleasedAt: LATER,
    })])).toEqual([]);
  });

  it("A HOLDER-LESS ROW WITH NO RELEASE MARKER IS `stopped`, NOT A RELEASE", () => {
    /* THE CASE THIS FIXTURE USED TO STAND IN FOR, and it is not the release.
       `refreshOrganizerHolder` (`apps/worker/src/mailboxes.ts`) and the sidecar's
       `notePeekedHolder` rewrite ALL FOUR holder columns on every reader cycle and write them all
       NULL when the peek finds an empty claim folder — the shape a stand-down takes on its own
       once the install that beat it is removed. The same write stamps `organizer_event_at` on a
       flip in either direction INCLUDING to and from NULL, so the decayed row reaches this
       function with a fresh unacknowledged event and the line fires on it. Announcing it as a
       release told somebody they had stopped organizing a mailbox they never organized.

       `stopped` with NO NAME, which the view renders as `noticeStoppedUnknown` — "the install
       that organized this has stopped; nothing files it until something takes it over". True of
       this row, and the one open condition of the four: mail accumulates unsorted while it holds.

       Watch it fail: drop the `organizerReleasedAt` term from `noticeKind` and this answers
       `released` again, which is the false sentence. */
    const only = organizerNotices([row({ organizedBy: null, organizerState: null })]);
    expect(only[0]!.kind).toBe("stopped");
    expect(only[0]!.name, "an unknown holder must not be invented for the decayed row").toBeNull();
  });

  it("…and an explicit `null` marker is not a release either", () => {
    // Absent is a host too old to send the column; `null` is a host that sends it for a mailbox
    // this account never let go. Both mean "not released", which is the direction that costs a
    // stale explanation rather than a false claim about something the person did.
    expect(organizerNotices([row({
      organizedBy: null, organizerState: null, organizerReleasedAt: null,
    })])[0]!.kind).toBe("stopped");
  });

  it("ONCE-PER-CHANGE HOLDS FOR THE DECAYED ROW — the gate is still the two instants", () => {
    expect(organizerNotices([row({
      organizedBy: null, organizerState: null, organizerEventSeenAt: LATER,
    })])).toEqual([]);
  });

  it("A MAILBOX THE WALL PAUSED SAYS NOTHING — never `stopped` (mail 0135)", () => {
    const paused = { organizedBy: null, organizerState: null, organizerReleasedAt: LATER };
    expect(organizerNotices([row({ ...paused, organizerParkedAt: LATER })])).toEqual([]);
    // Cloud's own stale claim named by a peek after the reopening: still paused, not stopped.
    expect(organizerNotices([row({ organizerState: "stopped", organizerParkedAt: LATER })])).toEqual([]);
    // CONTROL: the marker `null` leaves the stopped holder a notice.
    expect(organizerNotices([row({ organizerState: "stopped", organizerParkedAt: null })])[0]!.kind)
      .toBe("stopped");
  });

  it("a FRESHLY CONNECTED reader nobody has agreed to has nothing to announce", () => {
    // Its next screen is the agreement, not a notice about a handover that never happened.
    expect(organizerNotices([row({ organizedBy: null, organizeConsentedAt: null })])).toEqual([]);
  });

  it("an unnamed holder is `null`, never an invented name", () => {
    const only = organizerNotices([row({
      organizedBy: { kind: "local", name: null, since: EARLIER },
    })]);
    expect(only[0]!.name).toBeNull();
  });

  it("several mailboxes are several facts, newest change first", () => {
    const out = organizerNotices([
      row({ id: "old", organizerEventAt: EARLIER }),
      row({ id: "new", organizerEventAt: LATER }),
    ]);
    expect(out.map((n) => n.id)).toEqual(["new", "old"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   2 · THE LINE — it says one thing, and the press ends it
   ══════════════════════════════════════════════════════════════════════════════════════════ */

async function mountNotice(
  notices: NoticeFact[],
  onAcknowledge: (id: string) => Promise<unknown>,
): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
      children: h(OrganizerNotice, { notices, onAcknowledge }),
    }));
  });
  await settleFirstPaint();
  return host;
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
  const blocks = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".rail-notice")];
  const press = async (el: Element, label: string) => {
    const b = [...el.querySelectorAll("button")].find((x) => x.textContent === label);
    expect(b, `no "${label}" press was drawn`).toBeDefined();
    await act(async () => { b!.click(); });
  };

  it("FIVE MAILBOXES ARE TWO BLOCKS, stopped first, each one sentence with the count", async () => {
    const el = await mountNotice(five(), async () => {});
    const got = blocks(el);
    expect(got.map((b) => b.dataset.state)).toEqual(["stopped", "elsewhere"]);
    expect(got[0]!.textContent).toContain("2 mailboxes are no longer being organized.");
    expect(got[1]!.textContent).toContain("3 mailboxes are organized elsewhere now.");
    expect(el.textContent, "a closed block listed its mailboxes").not.toContain("@example.com");
  });

  it("THE COUNT OPENS THE LIST: address · holder, and the stopped rows say so", async () => {
    const el = await mountNotice(five(), async () => {});
    const count = blocks(el)[0]!.querySelector<HTMLButtonElement>(".rn-count")!;
    expect(count.getAttribute("aria-expanded")).toBe("false");
    expect(count.getAttribute("aria-label")).toBe(en.mailboxes.noticeCountShow);
    await act(async () => { count.click(); });
    expect(count.getAttribute("aria-expanded")).toBe("true");
    expect(count.getAttribute("aria-label")).toBe(en.mailboxes.noticeCountHide);
    const rows = [...blocks(el)[0]!.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual(["shop@example.com · Office Linux · stopped", "news@example.com · stopped"]);
    await act(async () => { blocks(el)[1]!.querySelector<HTMLButtonElement>(".rn-count")!.click(); });
    expect([...blocks(el)[1]!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "work@example.com · ohmail Cloud",
      `home@example.com · ${en.mailboxes.noticeRowUnknown}`,
      "club@example.com · ohmail Cloud",
    ]);
  });

  it("one mailbox keeps the named sentence and no count", async () => {
    const el = await mountNotice([fact()], async () => {});
    expect(blocks(el)).toHaveLength(1);
    expect(el.textContent).toContain("ohmail Cloud organizes person@example.com now.");
    expect(el.querySelector(".rn-count")).toBeNull();
  });

  it("ONE PRESS ACKNOWLEDGES EVERY ROW ITS BLOCK LISTS, and the block goes", async () => {
    const asked: string[] = [];
    const el = await mountNotice(five(), async (id) => { asked.push(id); });
    await press(blocks(el)[1]!, en.mailboxes.noticeDismiss);
    expect(asked.sort(), "the press did not reach every row of the block").toEqual(["e1", "e2", "e3"]);
    expect(blocks(el).map((b) => b.dataset.state), "the other block went with it").toEqual(["stopped"]);
  });

  it("A ROW WHOSE WRITE WAS REFUSED COMES BACK ALONE — the truthful, smaller block", async () => {
    const el = await mountNotice(five(), async (id) => { if (id === "e2") throw new Error("402"); });
    await press(blocks(el)[1]!, en.mailboxes.noticeDismiss);
    const back = blocks(el).find((b) => b.dataset.state === "elsewhere");
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
    await press(blocks(el).find((b) => b.dataset.state === "elsewhere")!, en.mailboxes.noticeDismiss);
    expect(asked, "the transport takes the bare mailbox id").toEqual(["B"]);
    const rerender = async (notices: NoticeFact[]) => {
      await act(async () => {
        root!.render(h(NextIntlClientProvider, {
          locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
          children: h(OrganizerNotice, { notices, onAcknowledge: async () => {} }),
        }));
      });
    };
    await rerender([A]);
    const bStopped = fact({ id: "B", address: "b@example.com", kind: "stopped", name: "Laptop", order: 1, at: "2026-09-04T09:50:00.000Z" });
    await rerender([bStopped, A]);
    expect(el.textContent, "a new change on a mailbox dismissed earlier in the session is hidden")
      .toContain("2 mailboxes are no longer being organized.");
  });

  it("the stopped block carries the way to act on it; the settled one only Dismiss", async () => {
    const el = await mountNotice(five(), async () => {});
    const labels = (b: HTMLElement) => [...b.querySelectorAll(".rn-verbs button")].map((x) => x.textContent);
    expect(labels(blocks(el)[0]!)).toEqual([en.mailboxes.noticeOpenMailboxes, en.mailboxes.noticeDismiss]);
    expect(labels(blocks(el)[1]!)).toEqual([en.mailboxes.noticeDismiss]);
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
    expect([...el.querySelectorAll(".rn-verbs button")].map((x) => x.textContent)).toEqual(["Dismiss"]);
  });

  it("the shell twin is the same blocks under its own class; no tone class on either", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
        children: h(OrganizerNotice, { notices: five(), onAcknowledge: async () => {}, variant: "shell" }),
      }));
    });
    await settleFirstPaint();
    expect(host.querySelectorAll(".notice-shell")).toHaveLength(2);
    expect(host.querySelector(".rail-notice")).toBeNull();
    for (const b of host.querySelectorAll(".notice-shell")) {
      expect(b.getAttribute("role")).toBe("status");
      expect(b.className, "a notice wore a transient's tone").toBe("notice-shell");
    }
  });

  it("nothing to say draws nothing at all — no slot, no reserved band", async () => {
    const el = await mountNotice([], async () => {});
    expect(el.textContent).toBe("");
  });
});

describe("a refused Dismiss says why, under the notice that stays (NOTICE-DISMISS-REFUSAL-IS-SILENT)", () => {
  const refusedWith = (status: number, code?: string) => Object.assign(new Error(`${status}`), { status, code });
  const line = (el: HTMLElement) => el.querySelector<HTMLElement>(".rn-refused");
  const pressDismiss = async (el: HTMLElement) => {
    const b = [...el.querySelectorAll("button")].find((x) => x.textContent === en.mailboxes.noticeDismiss);
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
        expect(el.textContent, "an acknowledged notice stayed").toBe("");
        return;
      }
      expect(el.textContent, "a refused write took the notice off screen").toContain("ohmail Cloud organizes person@example.com now.");
      expect(line(el)?.textContent, "a refused write put the notice back with no sentence").toBe(said);
    });
  }

  it("the notice stays while the write is out, and leaves on its answer", async () => {
    let answer!: () => void;
    const el = await mountNotice([fact()], () => new Promise<void>((r) => { answer = r; }));
    await pressDismiss(el);
    expect(el.textContent, "the notice left before the stamp was written").toContain("person@example.com");
    await act(async () => { answer(); });
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(el.textContent).toBe("");
  });

  it("the line clears on the next successful write", async () => {
    let refuse = true;
    const el = await mountNotice(
      [fact({ id: "a", address: "a@example.com" }), fact({ id: "b", address: "b@example.com", order: 1 })],
      async () => { if (refuse) throw refusedWith(503, "offline_read_only"); },
    );
    await pressDismiss(el);
    expect(line(el)?.textContent).toBe("Couldn't dismiss it — you're offline.");
    refuse = false;
    await pressDismiss(el);
    expect(el.textContent, "the second, accepted press left the block").toBe("");
  });

  it("the line is about the refused change: a later change on the block does not inherit it", async () => {
    const A = fact({ id: "a", address: "a@example.com" });
    const el = await mountNotice([A], async () => { throw refusedWith(503, "offline_read_only"); });
    await pressDismiss(el);
    expect(line(el)?.textContent).toBe("Couldn't dismiss it — you're offline.");
    const rerender = async (notices: NoticeFact[]) => {
      await act(async () => {
        root!.render(h(NextIntlClientProvider, {
          locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
          children: h(OrganizerNotice, { notices, onAcknowledge: async () => {} }),
        }));
      });
    };
    await rerender([]); // another device marked it read; the poll took it away
    await rerender([fact({ id: "c", address: "c@example.com" })]);
    expect(el.textContent).toContain("c@example.com");
    expect(line(el), "a refusal about another change was said under this one").toBeNull();
  });

  it("a partly refused block keeps the refused row and says why", async () => {
    const el = await mountNotice(
      [fact({ id: "a", address: "a@example.com" }), fact({ id: "b", address: "b@example.com", order: 1 })],
      async (id) => { if (id === "b") throw refusedWith(402); },
    );
    await pressDismiss(el);
    expect(el.textContent).toContain("b@example.com");
    expect(el.textContent).not.toContain("a@example.com");
    expect(line(el)?.textContent).toBe("Couldn't dismiss it — this account is not active.");
  });
});

describe("the catalogues say only what is still said", () => {
  it("the two dropped sentences are gone and the seven new keys are in both languages", async () => {
    const de = (await import("../messages/de.json")).default as typeof en;
    const NEW = ["noticeElsewhereMany", "noticeStoppedMany", "noticeCountShow", "noticeCountHide",
      "noticeRowUnknown", "noticeRowStopped", "noticeRowStoppedUnknown"];
    for (const cat of [en, de]) {
      const m = cat.mailboxes as unknown as Record<string, string>;
      expect(m.noticeHere, "the 'here' sentence is still in a catalogue").toBeUndefined();
      expect(m.noticeReleased, "the 'released' sentence is still in a catalogue").toBeUndefined();
      for (const k of NEW) expect(m[k], `${k} missing`).toBeTruthy();
      // The *Many keys take `{count}` >= 2 (one mailbox takes the named sentence): no plural form.
      for (const k of ["noticeElsewhereMany", "noticeStoppedMany"]) {
        expect(m[k]).toContain("<c>{count} ");
        expect(m[k]).not.toContain("plural");
      }
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   3 · A QUEUED DECISION SURVIVES ITS OWN CONFIRM
   ══════════════════════════════════════════════════════════════════════════════════════════ */

let seq = 0;
const toasts: string[] = [];
const sent: EngineMutation[] = [];

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
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

async function mountState(
  engine: OhmailEngine,
): Promise<{ get: () => ScreenerState; }> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  let latest: ScreenerState | null = null;

  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(
      engine,
      v,
      ((message: string) => { toasts.push(message); }) as never,
      undefined,
      undefined,
      true,
      { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false },
    );
    return null;
  }

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(Probe),
    }));
  });
  await settleFirstPaint();
  return { get: () => latest! };
}

describe("a decision queued with the organizer does not revert on its own confirm", () => {
  beforeEach(() => { seq = 0; toasts.length = 0; sent.length = 0; });

  it("THE PRESS STANDS after the commit window, and the sender is decided rather than waiting", async () => {
    const s = await mountState(queueingEngine(await freshStore()));
    expect(s.get().waiting, "the fixture should offer one waiting sender").toHaveLength(1);

    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "ohbox", { read: false, scope: "sender" });
    });
    /* PAST THE UNDO WINDOW AND THE CONFIRM. This is the exact moment the defect appeared: the
       mutation resolves, the engine pulls a drain that carries nothing, the overlay drops, and
       the projection is free to offer the sender again. */
    await act(async () => { vi.advanceTimersByTime(60_000); });

    expect(sent, "the decision never reached the wire").toHaveLength(1);
    expect(s.get().waiting, "the sender came back after the press was accepted").toHaveLength(0);
    expect(s.get().decided, "the decided sender is not accounted for anywhere").toHaveLength(1);
    expect(s.get().decided[0]!.decision).toMatchObject({
      subject: "editors@terracereview.invalid", scope: "sender", holder: "ohmail Cloud",
    });
    expect(s.get().notApplied, "a fresh press is not a refusal").toEqual([]);
  });

  it("A DOMAIN-SCOPE decision excludes the domain, which is what the organizer will apply", async () => {
    const s = await mountState(queueingEngine(await freshStore()));
    await act(async () => {
      s.get().decide(s.get().waiting[0]!, "ohbox", { read: false, scope: "domain" });
    });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(s.get().decided[0]!.decision).toMatchObject({
      subject: "terracereview.invalid", scope: "domain",
    });
  });

  it("a decision the SERVER already knows about excludes the sender before any press", async () => {
    /* The durable half: a press made in a previous session. Without it a reload puts every
       decided sender back in the queue and asks the same question again. */
    const { useScreenerState } = await import("../app/shell/screener-state.js");
    const engine = queueingEngine(await freshStore());
    let latest: ScreenerState | null = null;
    function Probe(): null {
      const [v, setV] = React.useState(0);
      React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
      latest = useScreenerState(
        engine, v, (() => {}) as never, undefined, undefined, true,
        { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false },
        [{
          subject: "editors@terracereview.invalid", scope: "sender",
          decidedAt: EARLIER, holder: null,
        }],
      );
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: en as never, timeZone: "UTC", now: NOW, children: h(Probe),
      }));
    });
    await settleFirstPaint();
    expect(latest!.waiting).toHaveLength(0);
    expect(latest!.decided).toHaveLength(1);
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
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider, {
        children: h(ScreenerView, {
          state: viewStateWith(decision),
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

const decided = (over: Partial<PendingDecision> = {}): PendingDecision => ({
  subject: "editors@terracereview.invalid", scope: "sender", decidedAt: LATER,
  holder: "ohmail Cloud", state: "sent", ...over,
});

describe("what the pane says about a decision the organizer has not carried out", () => {
  it("waiting: it names the machine that owes it, and the sender sits under its own heading", async () => {
    const el = await mountDecided(decided());
    const text = el.textContent ?? "";
    expect(text).toContain(en.screener.pendingHeading);
    expect(el.querySelector(".scn-decided"), "the decided row is not marked as one").not.toBeNull();
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
    expect(el.querySelector(".scn-decided"), "a refused sender was drawn as a decided one")
      .toBeNull();
    expect(el.querySelector('.scn-relay-state[data-state="refused"]'),
      "the refusal was not set apart from a decision still waiting").not.toBeNull();
    expect(text, "the row does not say its decision was declined")
      .toContain(en.screener.rowNotApplied);
  });

  it("EVERY reason in the organizer's vocabulary has a sentence in both catalogues", async () => {
    /* The set is closed on the wire, so the whole of it can be asserted rather than sampled. A
       reason added on the server without copy here would render "reason unknown" — quiet, wrong,
       and invisible to every other guard. */
    const REASONS = [
      "unauthenticated", "conflict", "wrong_mailbox", "invalid_payload",
      "unhandled_kind", "stale", "account_erased",
    ];
    for (const reason of REASONS) {
      const sentence = (en.screener as unknown as Record<string, string>)[`pendingReason_${reason}`];
      expect(sentence, `no sentence for the refusal reason ${reason}`).toBeTruthy();
      expect(sentence, `${reason} renders its own token`).not.toContain(reason);
    }
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
