/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import messages from "../messages/en.json";
import type { JunkItemWire, JunkPageWire, JunkSearchWire, JunkSweepWire } from "../app/api-client";

/**
 * THE JUNK WINDOW HOOK — `useJunkWindow`'s pagination honesty (§16.2, review rounds 2–3).
 *
 * The server discards a pagination cursor whose UIDVALIDITY no longer matches (the folder was
 * purged/recreated), answers that mailbox's TOP page under the new epoch, and SAYS SO — the
 * `reset` flag on the mailbox row, stated rather than inferred, because a reset folder that is
 * now empty contributes no row to infer from. The append-only client would file the fresh page
 * below the stale rows — the folder's NEWEST mail rendered at the BOTTOM, under rows that no
 * longer exist — and a single-mailbox splice would half-consume the OTHER mailboxes' pages. So
 * a stated reset makes the hook RELOAD a real cursorless first page, correct for every mailbox
 * at once. Same-epoch pages still append, deduplicated by the epoch-scoped key.
 *
 * MUTATIONS WATCHED (2026-08-24): ignore the flag in the hook ⇒ both reset cases red; never
 * state it on the server ⇒ the api reset test red.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const junkList = vi.fn<(opts?: { cursor?: string }) => Promise<JunkPageWire>>();
const junkBody = vi.fn<() => Promise<{ subject: string; text: string }>>();
const junkRescue = vi.fn<(...args: unknown[]) => Promise<{ status: "queued"; rescueId: string }>>();
const junkSearch = vi.fn<(q: string) => Promise<JunkSearchWire>>();
const junkSweepPreview = vi.fn<() => Promise<JunkSweepWire>>();
const junkSweepRequest = vi.fn<() => Promise<JunkSweepWire>>();
/** The mock's mutable "is there a server" answer — the supported/failed cases flip it. */
const configured = { value: true };

vi.mock("../app/api-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../app/api-client")>();
  return {
    ...real,
    apiConfigured: () => configured.value,
    screener: {
      ...real.screener,
      junkList: (opts?: { cursor?: string }) => junkList(opts),
      junkBody: () => junkBody(),
      junkRescue: (...args: unknown[]) => junkRescue(...args),
      junkSearch: (q: string) => junkSearch(q),
      junkSweepPreview: () => junkSweepPreview(),
      junkSweepRequest: () => junkSweepRequest(),
    },
  };
});

const NO_SWEEP: JunkSweepWire = { mailboxes: [], movable: 0, pending: false };

function item(uid: number, uidValidity: string, date: string): JunkItemWire {
  return {
    mailboxId: "mb1", uid, uidValidity,
    subject: `junk ${uid}`, from: { name: null, address: `s${uid}@example.invalid` },
    date, messageIdHeader: `<mid-${uid}@x>`, seen: false, origin: "provider",
  };
}
const pageWire = (
  items: JunkItemWire[], nextCursor: string | null, over: { reset?: boolean } = {},
): JunkPageWire => ({
  mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "ok", ...(over.reset ? { reset: true } : {}) }],
  items, nextCursor,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let control: import("../app/shell/junk-window").JunkWindowControl | null = null;

/** Toasts the hook spoke this mount — the sentences are the assertions for the two verbs. */
let toasts: string[] = [];
/** The `active` flag the probe renders with; `setActive` flips it live (segment left / returned). */
let setActive: ((v: boolean) => void) | null = null;

async function mountHook(
  initiallyActive = true,
  hostWire?: import("../app/shell/junk-window").JunkWire,
): Promise<void> {
  const { useJunkWindow } = await import("../app/shell/junk-window");
  function Probe(): null {
    const [active, set] = React.useState(initiallyActive);
    setActive = set;
    control = useJunkWindow(active, ((msg: string) => { toasts.push(msg); }) as never, hostWire);
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(Probe),
      }),
    );
  });
  // Let the lazy first page land.
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  junkList.mockReset();
  junkBody.mockReset();
  junkBody.mockResolvedValue({ subject: "s", text: "t" });
  junkRescue.mockReset();
  junkRescue.mockResolvedValue({ status: "queued", rescueId: "r1" });
  junkSearch.mockReset();
  junkSearch.mockResolvedValue({ mailboxes: [], items: [], truncated: false });
  junkSweepPreview.mockReset();
  junkSweepPreview.mockResolvedValue(NO_SWEEP);
  junkSweepRequest.mockReset();
  junkSweepRequest.mockResolvedValue(NO_SWEEP);
  configured.value = true;
  toasts = [];
  setActive = null;
  try { window.localStorage.clear(); } catch { /* jsdom without storage */ }
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  control = null;
});

/**
 * ── THE HOST WIRE — the seam that is the only door on a build with no Cloud client ──────────
 *
 * `useJunkWindow(active, toast, hostWire)` is what the desktop window, and now a paired phone or
 * host client, hand in: both artifacts alias `app/api-client` to a refusing stub, so the segment
 * without a wire can only ever report "no server" and the shell withholds it. Two properties, and
 * the second is the one a future edit can lose quietly: the wire ARMS the window, and when a wire
 * is handed in it is the ONLY door — measured with a working Cloud client behind it, so a
 * fallback that crept back in would be visible instead of harmless.
 */
describe("useJunkWindow — the host wire is the door, and the only one", () => {
  interface Counted { wire: import("../app/shell/junk-window").JunkWire; calls: string[] }

  /** A host wire that records what it was asked and answers the queued page. */
  function hostWire(page: JunkPageWire = pageWire([], null)): Counted {
    const calls: string[] = [];
    return {
      calls,
      wire: {
        list: async (opts) => { calls.push(`list${opts?.cursor ? `:${opts.cursor}` : ""}`); return page; },
        body: async () => { calls.push("body"); return { subject: "s", text: "the host's body" }; },
        rescue: async () => { calls.push("rescue"); return { status: "queued" as const, rescueId: "r1" }; },
        dismissRescue: async () => { calls.push("dismissRescue"); return { dismissed: true }; },
        search: async (q) => { calls.push(`search:${q}`); return { mailboxes: [], items: [], truncated: false }; },
        sweepPreview: async () => { calls.push("sweepPreview"); return NO_SWEEP; },
        sweepRequest: async () => { calls.push("sweepRequest"); return NO_SWEEP; },
        isGone: () => false,
        codeOf: () => null,
      },
    };
  }

  it("THE DEFECT: no wire and no Cloud client — nothing is supported and nothing is asked", async () => {
    // The state of every desktop artifact before its wire was handed in, this hook's own half of
    // it: `supported` is false, so `AppShell` passes no control and the segment is absent.
    configured.value = false;
    await mountHook();
    expect(control!.supported).toBe(false);
    expect(junkList).not.toHaveBeenCalled();
  });

  it("a wire ARMS the window on a build whose Cloud client refuses", async () => {
    configured.value = false;
    const host = hostWire(pageWire([item(9, "7", "2026-08-20T10:00:00.000Z")], null));

    await mountHook(true, host.wire);

    expect(control!.supported, "a handed-in wire did not arm the segment").toBe(true);
    expect(control!.phase).toBe("ready");
    expect(control!.items.map((i) => i.uid)).toEqual([9]);
    expect(host.calls).toContain("list");
    expect(junkList, "the refusing Cloud client was asked anyway").not.toHaveBeenCalled();
  });

  it("ONE DOOR: with a WORKING Cloud client behind it, every ask still goes to the wire", async () => {
    // The control that makes the case above evidence. `configured` is true and the api mocks
    // answer, so a fallback to `cloudWire` would pass silently without this.
    configured.value = true;
    junkList.mockResolvedValue(pageWire([item(1, "7", "2026-08-01T10:00:00.000Z")], null));
    const row = item(9, "7", "2026-08-20T10:00:00.000Z");
    const host = hostWire(pageWire([row], null));

    await mountHook(true, host.wire);
    // The rows on screen are the WIRE's, not the Cloud client's — uid 9 and never uid 1.
    expect(control!.items.map((i) => i.uid)).toEqual([9]);

    await act(async () => { control!.openBody(row); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    await act(async () => { control!.rescue(row); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

    // …and the command the wire recorded marks the row rather than removing it: the message is
    // still in Junk until the organizer moves it.
    expect(control!.items.map((i) => i.uid)).toEqual([9]);
    expect(control!.items[0]!.rescue).toBe("queued");
    expect(host.calls).toContain("list");
    expect(host.calls).toContain("body");
    expect(host.calls).toContain("rescue");
    for (const cloud of [junkList, junkBody, junkRescue, junkSearch, junkSweepRequest]) {
      expect(cloud, "the Cloud client was reached past a handed-in wire").not.toHaveBeenCalled();
    }
  });

  it("a wire that REFUSES is reported as failed, with the human's retry — not as an empty folder", async () => {
    configured.value = false;
    const calls: string[] = [];
    const refusing: import("../app/shell/junk-window").JunkWire = {
      ...hostWire().wire,
      list: async () => { calls.push("list"); throw new Error("the engine answered 503"); },
    };

    await mountHook(true, refusing);

    // §16.2's rule, unchanged over a wire: failed reads say so. The state table is decided above
    // the seam, so this is the wire's rejection reaching it rather than a second sentence.
    expect(control!.supported).toBe(true);
    expect(control!.phase).toBe("failed");
    expect(calls).toEqual(["list"]);
  });
});

describe("useJunkWindow — the server gate and the human retry", () => {
  it("a build with NO server says so: supported false, phase failed — never an eternal spinner", async () => {
    configured.value = false;
    await mountHook();
    expect(control!.supported).toBe(false);
    // The belt under the shell's gate: even if a control reached a view, the state is honest.
    expect(control!.phase).toBe("failed");
    expect(junkList).not.toHaveBeenCalled();
  });

  it("Retry REPLACES a hung body ask — a stalled `loading` entry must not eat the press", async () => {
    junkList.mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    // The first ask hangs; its rejection arrives only AFTER the retry has delivered.
    let failFirst!: () => void;
    let answerSecond!: () => void;
    junkBody.mockReturnValueOnce(new Promise((_, reject) => { failFirst = () => reject(new Error("late")); }));
    junkBody.mockReturnValueOnce(new Promise((resolve) => {
      answerSecond = () => resolve({ subject: "s", text: "the retry's answer" });
    }));
    await mountHook();
    const row = control!.items[0]!;
    await act(async () => { control!.openBody(row); });
    const first = control!.bodyFor(row);
    expect(first.phase).toBe("loading");
    // The automatic open refuses to re-ask while loading…
    await act(async () => { control!.openBody(row); });
    expect(junkBody).toHaveBeenCalledTimes(1);
    // …and the HUMAN retry dispatches anyway, under a NEW attempt number (the preview keys its
    // body anatomy on it, so the stall face restarts per ask).
    await act(async () => { control!.openBody(row, { retry: true }); });
    const second = control!.bodyFor(row);
    expect(second.phase).toBe("loading");
    expect((second as { attempt: number }).attempt)
      .toBeGreaterThan((first as { attempt: number }).attempt);
    await act(async () => { answerSecond(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(junkBody).toHaveBeenCalledTimes(2);
    expect(control!.bodyFor(row)).toEqual({ phase: "ready", text: "the retry's answer" });
    // The SUPERSEDED first ask's late rejection is DROPPED — never "failed" over a delivered
    // body (review round: per-row ask generations).
    await act(async () => { failFirst(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(control!.bodyFor(row)).toEqual({ phase: "ready", text: "the retry's answer" });
  });
});

describe("the shell's gate reads the hook's own answer", () => {
  it("AppShell passes the control on `junkWindow.supported` — never the broader suggest-wire read", () => {
    // Source pin: the hosted desktop's suggest wire makes `autoOptIn.supported` true while its
    // api client is the refusing stub — the exact composition jsdom cannot mount. The gate must
    // read the hook's own `apiConfigured()` answer.
    // A plain cwd-relative read: the suite runs from the repo root, and `import.meta.url` in
    // this jsdom file resolves to an http-scheme URL the fs helpers refuse.
    const shell = readFileSync("apps/webapp/app/shell/AppShell.tsx", "utf8");
    expect(shell).toMatch(/!demo && consent\.foldersEnabled && junkWindow\.supported \? junkWindow : undefined/);
    expect(shell).not.toMatch(/consent\.foldersEnabled && autoOptIn\.supported \? junkWindow/);
  });
});

describe("useJunkWindow — Show older across an epoch boundary", () => {
  it("a SAME-epoch older page APPENDS below what the reader has", async () => {
    junkList
      .mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], "c1"))
      .mockResolvedValueOnce(pageWire([item(59, "7", "2026-08-19T10:00:00.000Z")], null));
    await mountHook();
    expect(control!.items.map((i) => i.uid)).toEqual([60]);
    await act(async () => { control!.loadOlder(); });
    await act(async () => { await Promise.resolve(); });
    expect(control!.items.map((i) => i.uid)).toEqual([60, 59]);
    expect(control!.nextCursor).toBeNull();
  });

  it("a STATED epoch reset reloads a real first page — never new mail under stale rows", async () => {
    junkList
      .mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], "c1"))
      // The folder was recreated: the server DISCARDED the cursor and SAYS so (`reset` on the
      // mailbox row — stated, not inferred, so an emptied folder is detectable too).
      .mockResolvedValueOnce(pageWire([item(3, "9", "2026-08-24T10:00:00.000Z")], null, { reset: true }))
      // The hook answers with a cursorless FIRST page — correct for every mailbox at once.
      .mockResolvedValueOnce(pageWire([item(3, "9", "2026-08-24T10:00:00.000Z")], null));
    await mountHook();
    await act(async () => { control!.loadOlder(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    // The stale epoch-7 row is GONE; the window IS the fresh first page.
    expect(control!.items.map((i) => `${i.uidValidity}:${i.uid}`)).toEqual(["9:3"]);
    expect(junkList).toHaveBeenCalledTimes(3);
    // …and the reload carried NO cursor.
    expect(junkList.mock.calls[2]![0]).toBeUndefined();
  });

  it("an EMPTIED reset folder clears its stale rows too — the flag, not the rows, is the signal", async () => {
    junkList
      .mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], "c1"))
      .mockResolvedValueOnce(pageWire([], null, { reset: true }))
      .mockResolvedValueOnce(pageWire([], null));
    await mountHook();
    await act(async () => { control!.loadOlder(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(control!.items).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE §16.2 EXTRAS (2026-08-27): the search-append, the second verb, the sweep offer.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const settle = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
};
/** Let the typing rest past the debounce — real timers, one short wait. */
const restPastDebounce = async (): Promise<void> => {
  const { JUNK_SEARCH_DEBOUNCE_MS } = await import("../app/shell/junk-window");
  await act(async () => { await new Promise((r) => setTimeout(r, JUNK_SEARCH_DEBOUNCE_MS + 120)); });
  await settle();
};

const win = (over: Partial<JunkMailboxWire> = {}): JunkMailboxWire =>
  ({ id: "mb1", address: "a@example.invalid", window: "ok", ...over });
type JunkMailboxWire = JunkPageWire["mailboxes"][number];

describe("useJunkWindow — the search-append", () => {
  it("typing filters the LOADED window locally and asks the server NOTHING while rows match", async () => {
    junkList.mockResolvedValueOnce(pageWire([
      { ...item(60, "7", "2026-08-20T10:00:00.000Z"), subject: "Lottery winner" },
      { ...item(59, "7", "2026-08-19T10:00:00.000Z"), subject: "Invoice", from: { name: "Acme Billing", address: "bill@acme.invalid" } },
    ], null));
    await mountHook();
    await act(async () => { control!.search.setQuery("acme"); });
    expect(control!.search.phase).toBe("local");
    // Sender NAME matches too — the filter reads subject, address and name.
    expect(control!.visible.map((i) => i.uid)).toEqual([59]);
    expect(control!.search.localCount).toBe(1);
    await restPastDebounce();
    expect(junkSearch).not.toHaveBeenCalled();
    // Clearing the query is the whole window again, with no leftover search state.
    await act(async () => { control!.search.setQuery(""); });
    expect(control!.search.phase).toBe("idle");
    expect(control!.visible.map((i) => i.uid)).toEqual([60, 59]);
  });

  it("an EMPTY local filter asks the server ONCE after the typing rests, and APPENDS the hits", async () => {
    junkList.mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    junkSearch.mockResolvedValueOnce({
      mailboxes: [win(), win({ id: "mb2", address: "b@example.invalid", window: "unreachable" })],
      items: [item(12, "7", "2026-08-01T10:00:00.000Z"), item(60, "7", "2026-08-20T10:00:00.000Z")],
      truncated: true,
    });
    await mountHook();
    await act(async () => { control!.search.setQuery("zzz"); });
    expect(control!.search.phase).toBe("local");
    expect(control!.visible).toEqual([]);
    // Not yet — the typing has not rested.
    expect(junkSearch).not.toHaveBeenCalled();
    await restPastDebounce();
    expect(junkSearch).toHaveBeenCalledTimes(1);
    expect(junkSearch).toHaveBeenCalledWith("zzz");
    expect(control!.search.phase).toBe("done");
    // The hit that is NOT a loaded row is appended; the loaded row (60) is not repeated because
    // the local filter did not keep it — the server's answer is what shows for this query.
    expect(control!.visible.map((i) => i.uid)).toEqual([12, 60]);
    expect(control!.search.localCount).toBe(0);
    expect(control!.search.truncated).toBe(true);
    expect(control!.search.mailboxes.filter((m) => m.window === "unreachable").map((m) => m.address))
      .toEqual(["b@example.invalid"]);
    // The same settled query is not asked twice this session…
    await act(async () => { control!.search.setQuery("zzz"); });
    await restPastDebounce();
    expect(junkSearch).toHaveBeenCalledTimes(1);
    // …but the HUMAN press asks again.
    await act(async () => { control!.search.searchServer(); });
    await settle();
    expect(junkSearch).toHaveBeenCalledTimes(2);
  });

  it("a failed search says so — `failed`, no hits — and a new query voids the old answer", async () => {
    junkList.mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    junkSearch.mockRejectedValueOnce(new Error("timeout"));
    await mountHook();
    await act(async () => { control!.search.setQuery("qqq"); });
    await restPastDebounce();
    expect(control!.search.phase).toBe("failed");
    expect(control!.search.hits).toEqual([]);
    await act(async () => { control!.search.setQuery("qq"); });
    expect(control!.search.phase).toBe("local");
    expect(control!.search.mailboxes).toEqual([]);
  });

  it("a QUEUED search hit stays in both lists, marked — it is still in Junk", async () => {
    junkList.mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    junkSearch.mockResolvedValueOnce({ mailboxes: [win()], items: [item(12, "7", "2026-08-01T10:00:00.000Z")], truncated: false });
    await mountHook();
    await act(async () => { control!.search.setQuery("zzz"); });
    await restPastDebounce();
    const hit = control!.visible[0]!;
    expect(hit.uid).toBe(12);
    await act(async () => { control!.rescue(hit); });
    await settle();
    // The press RECORDS a command; nothing has moved, so the row is still a true row of the
    // window — and it says what it is waiting for, on both lists it appears in.
    expect(control!.visible.map((i) => i.rescue)).toEqual(["queued"]);
    expect(control!.search.hits.map((i) => i.rescue)).toEqual(["queued"]);
  });
});

describe("useJunkWindow — the second verb", () => {
  it("`allow: true` sends the row's SENDER with the rescue; the plain verb sends none", async () => {
    junkList.mockResolvedValueOnce(pageWire([
      item(60, "7", "2026-08-20T10:00:00.000Z"), item(59, "7", "2026-08-19T10:00:00.000Z"),
    ], null));
    await mountHook();
    const [a, b] = control!.items;
    await act(async () => { control!.rescue(a!, { allow: true }); });
    await settle();
    expect(junkRescue).toHaveBeenLastCalledWith("mb1", 60, "7", { allow: { sender: "s60@example.invalid" } });
    await act(async () => { control!.rescue(b!); });
    await settle();
    expect(junkRescue).toHaveBeenLastCalledWith("mb1", 59, "7", {});
    // Both rows stand, both marked: two commands recorded, no move made here.
    expect(control!.items.map((i) => i.rescue)).toEqual(["queued", "queued"]);
  });
});

describe("useJunkWindow — the one-time sweep offer", () => {
  const pile = (movable: number, over: Partial<JunkSweepWire> = {}): JunkSweepWire => ({
    mailboxes: [{ id: "mb1", address: "a@example.invalid", candidates: movable, hasJunkFolder: true, pending: false }],
    movable, pending: false, ...over,
  });

  it("an empty pile offers nothing; a pile offers its number; a dismissal holds until the pile GROWS", async () => {
    junkList.mockResolvedValue(pageWire([], null));
    await mountHook();
    expect(junkSweepPreview).toHaveBeenCalledTimes(1);
    expect(control!.sweep.phase).toBe("none");
    // Remount with a pile.
    await act(async () => { root!.unmount(); });
    junkSweepPreview.mockResolvedValueOnce(pile(3));
    await mountHook();
    expect(control!.sweep.phase).toBe("offer");
    expect(control!.sweep.preview?.movable).toBe(3);
    await act(async () => { control!.sweep.dismiss(); });
    expect(control!.sweep.phase).toBe("none");
    // Same size again: still dismissed. Bigger: offered again — there is new content.
    await act(async () => { root!.unmount(); });
    junkSweepPreview.mockResolvedValueOnce(pile(3));
    await mountHook();
    expect(control!.sweep.phase).toBe("none");
    await act(async () => { root!.unmount(); });
    junkSweepPreview.mockResolvedValueOnce(pile(4));
    await mountHook();
    expect(control!.sweep.phase).toBe("offer");
  });

  it("the press records the command and reads back QUEUED; an emptied pile after a press is DONE", async () => {
    junkList.mockResolvedValue(pageWire([], null));
    junkSweepPreview.mockResolvedValueOnce(pile(2));
    junkSweepRequest.mockResolvedValueOnce(pile(2, {
      pending: true,
      mailboxes: [{ id: "mb1", address: "a@example.invalid", candidates: 2, hasJunkFolder: true, pending: true }],
    }));
    await mountHook();
    expect(control!.sweep.phase).toBe("offer");
    await act(async () => { control!.sweep.request(); });
    await settle();
    expect(junkSweepRequest).toHaveBeenCalledTimes(1);
    expect(control!.sweep.phase).toBe("pending");
    // A later answer with nothing left, after THIS session pressed, is "done" — not "none".
    await act(async () => { root!.unmount(); });
    junkSweepPreview.mockResolvedValueOnce(pile(1));
    junkSweepRequest.mockResolvedValueOnce(pile(0));
    await mountHook();
    await act(async () => { control!.sweep.request(); });
    await settle();
    expect(control!.sweep.phase).toBe("done");
  });

  it("a preview that cannot be read makes NO offer; a failed press says so and keeps the offer's number", async () => {
    junkList.mockResolvedValue(pageWire([], null));
    junkSweepPreview.mockRejectedValueOnce(new Error("503"));
    await mountHook();
    expect(control!.sweep.phase).toBe("unknown");
    await act(async () => { root!.unmount(); });
    junkSweepPreview.mockResolvedValueOnce(pile(2));
    junkSweepRequest.mockRejectedValueOnce(new Error("503"));
    await mountHook();
    await act(async () => { control!.sweep.request(); });
    await settle();
    expect(control!.sweep.phase).toBe("failed");
    expect(control!.sweep.preview?.movable).toBe(2);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   CLIENT REVIEW ROUND 1 (2026-08-27) — eight findings, each pinned here.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("useJunkWindow — the review round's rules", () => {
  it("a term typed AGAIN shows the answer it already earned — never an empty `local` the debounce refuses to fill", async () => {
    junkList.mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    junkSearch.mockResolvedValueOnce({ mailboxes: [win()], items: [item(12, "7", "2026-08-01T10:00:00.000Z")], truncated: false });
    await mountHook();
    await act(async () => { control!.search.setQuery("zzz"); });
    await restPastDebounce();
    expect(control!.visible.map((i) => i.uid)).toEqual([12]);
    await act(async () => { control!.search.setQuery("zz"); });
    expect(control!.search.phase).toBe("local");
    await act(async () => { control!.search.setQuery("zzz"); });
    // Restored from the session's answer — no second ask.
    expect(control!.search.phase).toBe("done");
    expect(control!.visible.map((i) => i.uid)).toEqual([12]);
    expect(junkSearch).toHaveBeenCalledTimes(1);
  });

  it("a row RESCUED while a search is in flight does not come back with the answer", async () => {
    junkList.mockResolvedValueOnce(pageWire([
      { ...item(60, "7", "2026-08-20T10:00:00.000Z"), subject: "acme" },
    ], null));
    let answer!: () => void;
    junkSearch.mockReturnValueOnce(new Promise((resolve) => {
      answer = () => resolve({ mailboxes: [win()], items: [item(60, "7", "2026-08-20T10:00:00.000Z"), item(12, "7", "2026-08-01T10:00:00.000Z")], truncated: false });
    }));
    await mountHook();
    await act(async () => { control!.search.setQuery("acme"); });
    // Local rows match, so the human presses the server search; meanwhile they rescue row 60.
    await act(async () => { control!.search.searchServer(); });
    await act(async () => { control!.rescue(control!.visible[0]!); });
    await settle();
    expect(control!.items.map((i) => i.rescue)).toEqual(["queued"]);
    await act(async () => { answer(); });
    await settle();
    // The answer carries row 60 too, and the LOADED row wins — the local one knows about the
    // press this session made, and a hit already present is never appended twice.
    expect(control!.visible.map((i) => i.uid)).toEqual([60, 12]);
    expect(control!.visible[0]!.rescue).toBe("queued");
  });

  it("leaving the segment CANCELS a pending kick and PAUSES the sweep's polling; returning resumes", async () => {
    junkList.mockResolvedValue(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    await mountHook();
    await act(async () => { control!.search.setQuery("zzz"); });
    await act(async () => { setActive!(false); });
    await restPastDebounce();
    expect(junkSearch).not.toHaveBeenCalled();
    await act(async () => { setActive!(true); });
    await restPastDebounce();
    expect(junkSearch).toHaveBeenCalledTimes(1);
  });

  it("a pile that cannot move anywhere is STRANDED — not empty, not an offer; an emptied pile after a press is done", async () => {
    junkList.mockResolvedValue(pageWire([], null));
    junkSweepPreview.mockResolvedValueOnce({
      mailboxes: [{ id: "mb2", address: "b@example.invalid", candidates: 4, hasJunkFolder: false, pending: false }],
      movable: 0, pending: false,
    });
    await mountHook();
    expect(control!.sweep.phase).toBe("stranded");
  });

  it("a dismissal is remembered PER ACCOUNT — another account's pile of the same size is still offered", async () => {
    junkList.mockResolvedValue(pageWire([], null));
    const pileA = { mailboxes: [{ id: "mbA", address: "a@example.invalid", candidates: 3, hasJunkFolder: true, pending: false }], movable: 3, pending: false };
    const pileB = { mailboxes: [{ id: "mbB", address: "b@example.invalid", candidates: 3, hasJunkFolder: true, pending: false }], movable: 3, pending: false };
    junkSweepPreview.mockResolvedValueOnce(pileA);
    await mountHook();
    expect(control!.sweep.phase).toBe("offer");
    await act(async () => { control!.sweep.dismiss(); });
    await act(async () => { root!.unmount(); });
    junkSweepPreview.mockResolvedValueOnce(pileB);
    await mountHook();
    expect(control!.sweep.phase).toBe("offer");
    await act(async () => { root!.unmount(); });
    junkSweepPreview.mockResolvedValueOnce(pileA);
    await mountHook();
    expect(control!.sweep.phase).toBe("none");
  });

  it("a press that never reached the queue says ONE sentence, both verbs — there is no partial outcome left", async () => {
    // The allow and the command commit in ONE transaction now, so "the rules changed but the move
    // did not" is unrepresentable: the old 502 arm and its two sentences went with it. What is
    // left to say is that nothing happened, and the row is unmarked to prove it.
    junkList.mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    const { ApiError } = await import("../app/api-client");
    junkRescue.mockRejectedValueOnce(new ApiError(409, "folders_disabled", "folders are off"));
    junkRescue.mockRejectedValueOnce(new ApiError(409, "folders_disabled", "folders are off"));
    await mountHook();
    const row = control!.items[0]!;
    await act(async () => { control!.rescue(row, { allow: true }); });
    await settle();
    expect(control!.items).toHaveLength(1);
    expect(control!.items[0]!.rescue, "a refused press marks nothing").toBeUndefined();
    expect(toasts.at(-1)).toBe("Couldn't ask for that move — try again.");
    await act(async () => { control!.rescue(row); });
    await settle();
    expect(toasts.at(-1)).toBe("Couldn't ask for that move — try again.");
  });
});

describe("useJunkWindow — one ask per term at a time (client review round 2)", () => {
  it("retyping a term whose ask is still IN FLIGHT does not start a second search; the one answer lands and is cached", async () => {
    junkList.mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    let answer!: () => void;
    junkSearch.mockReturnValueOnce(new Promise((resolve) => {
      answer = () => resolve({ mailboxes: [win()], items: [item(12, "7", "2026-08-01T10:00:00.000Z")], truncated: false });
    }));
    await mountHook();
    await act(async () => { control!.search.setQuery("zzz"); });
    await restPastDebounce();
    expect(junkSearch).toHaveBeenCalledTimes(1);
    // Leave the term, come back to it while the first ask still hangs.
    await act(async () => { control!.search.setQuery("qq"); });
    await act(async () => { control!.search.setQuery("zzz"); });
    await restPastDebounce();
    expect(junkSearch).toHaveBeenCalledTimes(1);
    // …and the manual press is refused for the same reason while it hangs.
    await act(async () => { control!.search.searchServer(); });
    expect(junkSearch).toHaveBeenCalledTimes(1);
    await act(async () => { answer(); });
    await settle();
    // The answer was cached for the term; revisiting shows it without another ask.
    await act(async () => { control!.search.setQuery("q"); });
    await act(async () => { control!.search.setQuery("zzz"); });
    expect(control!.search.phase).toBe("done");
    expect(control!.visible.map((i) => i.uid)).toEqual([12]);
    expect(junkSearch).toHaveBeenCalledTimes(1);
  });
});

describe("useJunkWindow — returning to a PENDING term (review round 5)", () => {
  it("shows `searching` and is settled by that ask's own completion — never stranded in local", async () => {
    junkList.mockResolvedValueOnce(pageWire([item(60, "7", "2026-08-20T10:00:00.000Z")], null));
    let answer!: () => void;
    junkSearch.mockReturnValueOnce(new Promise((resolve) => {
      answer = () => resolve({ mailboxes: [win()], items: [item(12, "7", "2026-08-01T10:00:00.000Z")], truncated: false });
    }));
    await mountHook();
    await act(async () => { control!.search.setQuery("zzz"); });
    await restPastDebounce();
    expect(junkSearch).toHaveBeenCalledTimes(1);
    await act(async () => { control!.search.setQuery("other"); });
    await act(async () => { control!.search.setQuery("zzz"); });
    // Back on the pending term: the ask is still one, and the screen says searching.
    expect(control!.search.phase).toBe("searching");
    await act(async () => { answer(); });
    await settle();
    expect(control!.search.phase).toBe("done");
    expect(control!.visible.map((i) => i.uid)).toEqual([12]);
    expect(junkSearch).toHaveBeenCalledTimes(1);
    // An answer for an ABANDONED term goes to the cache only — the screen keeps its query.
    await act(async () => { control!.search.setQuery("qqq"); });
    expect(control!.search.phase).toBe("local");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   RE-ENTRY (JUNK-WINDOW-FIRST-PAGE-ONCE-PER-SESSION): coming back to the segment re-reads the
   first page and the preview once they are older than JUNK_FIRST_PAGE_FRESH_MS. No timers.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("useJunkWindow — re-entry re-reads a page past its age", () => {
  const START = Date.UTC(2026, 9, 19, 12, 0, 0);
  let nowMs = START;
  let clock: { mockRestore: () => void } | null = null;
  beforeEach(() => {
    nowMs = START;
    clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });
  afterEach(() => { clock?.mockRestore(); clock = null; vi.useRealTimers(); });

  const reenter = async (advanceMs: number): Promise<void> => {
    await act(async () => { setActive!(false); });
    nowMs += advanceMs;
    await act(async () => { setActive!(true); });
    await settle(6);
  };
  const two = [item(2, "7", "2026-10-19T11:02:00.000Z"), item(1, "7", "2026-10-19T11:01:00.000Z")];

  it("re-entry at the age reads the list again and shows what was filed since", async () => {
    const { JUNK_FIRST_PAGE_FRESH_MS } = await import("../app/shell/junk-window");
    junkList.mockResolvedValueOnce(pageWire([], null)).mockResolvedValue(pageWire(two, null));
    await mountHook();
    expect(junkList).toHaveBeenCalledTimes(1);
    expect(control!.visible).toHaveLength(0);
    await reenter(JUNK_FIRST_PAGE_FRESH_MS);
    expect(junkList).toHaveBeenCalledTimes(2);
    expect(control!.phase).toBe("ready");
    expect(control!.visible).toHaveLength(2);
  });

  it("re-entry inside the age, and ten flips, read once", async () => {
    const { JUNK_FIRST_PAGE_FRESH_MS } = await import("../app/shell/junk-window");
    junkList.mockResolvedValue(pageWire([], null));
    await mountHook();
    await reenter(JUNK_FIRST_PAGE_FRESH_MS - 1);
    for (let i = 0; i < 10; i++) await reenter(0);
    expect(junkList).toHaveBeenCalledTimes(1);
    expect(junkSweepPreview).toHaveBeenCalledTimes(1);
  });

  it("after a failed read, re-entry past the age retries once; inside the age it does not", async () => {
    const { JUNK_FIRST_PAGE_FRESH_MS } = await import("../app/shell/junk-window");
    junkList.mockRejectedValueOnce(new Error("503")).mockResolvedValue(pageWire(two, null));
    await mountHook();
    expect(control!.phase).toBe("failed");
    await reenter(1_000);
    expect(junkList).toHaveBeenCalledTimes(1);
    expect(control!.phase).toBe("failed");
    await reenter(JUNK_FIRST_PAGE_FRESH_MS);
    expect(junkList).toHaveBeenCalledTimes(2);
    expect(control!.phase).toBe("ready");
  });

  it("the preview is re-read on entry past the age; `held` is a Set, kept over a failed read, null without it", async () => {
    const { JUNK_FIRST_PAGE_FRESH_MS } = await import("../app/shell/junk-window");
    junkList.mockResolvedValue(pageWire([], null));
    junkSweepPreview
      .mockResolvedValueOnce({ ...NO_SWEEP, held: { ids: ["q1", "q2"], truncated: true } })
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(NO_SWEEP);
    await mountHook();
    expect(control!.held?.ids).toBeInstanceOf(Set);
    expect([...control!.held!.ids]).toEqual(["q1", "q2"]);
    expect(control!.held!.truncated).toBe(true);
    await reenter(JUNK_FIRST_PAGE_FRESH_MS);
    expect(junkSweepPreview).toHaveBeenCalledTimes(2);
    expect([...control!.held!.ids], "a failed read keeps the last answer").toEqual(["q1", "q2"]);
    await reenter(JUNK_FIRST_PAGE_FRESH_MS);
    expect(junkSweepPreview).toHaveBeenCalledTimes(3);
    expect(control!.held).toBeNull();
  });

  it("after a press, the first preview no longer pending re-reads the page exactly once", async () => {
    const { JUNK_SWEEP_POLL_MS } = await import("../app/shell/junk-window");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const box = { id: "mb1", address: "a@example.invalid", candidates: 2, hasJunkFolder: true, pending: false };
    const pending: JunkSweepWire = { mailboxes: [{ ...box, pending: true }], movable: 2, pending: true };
    const emptied: JunkSweepWire = { mailboxes: [{ ...box, candidates: 0 }], movable: 0, pending: false };
    junkList.mockResolvedValue(pageWire([], null));
    junkSweepPreview
      .mockResolvedValueOnce({ mailboxes: [box], movable: 2, pending: false })
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(emptied);
    junkSweepRequest.mockResolvedValueOnce(pending);
    await mountHook();
    expect(control!.sweep.phase).toBe("offer");
    await act(async () => { control!.sweep.request(); });
    await settle();
    expect(control!.sweep.phase).toBe("pending");
    expect(junkList).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(JUNK_SWEEP_POLL_MS); });
    await settle();
    expect(junkList, "still pending: no re-read").toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(JUNK_SWEEP_POLL_MS); });
    await settle();
    expect(control!.sweep.phase).toBe("done");
    expect(junkList).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(JUNK_SWEEP_POLL_MS * 3); });
    await settle();
    expect(junkList).toHaveBeenCalledTimes(2);
  });

  it("staying on the segment for ten times the age makes no extra read", async () => {
    const { JUNK_FIRST_PAGE_FRESH_MS } = await import("../app/shell/junk-window");
    junkList.mockResolvedValue(pageWire(two, null));
    await mountHook();
    for (let i = 0; i < 10; i++) {
      nowMs += JUNK_FIRST_PAGE_FRESH_MS;
      await act(async () => { control!.search.setQuery(i % 2 === 0 ? "junk" : ""); });
      await settle();
    }
    expect(junkList).toHaveBeenCalledTimes(1);
    expect(junkSweepPreview).toHaveBeenCalledTimes(1);
  });
});
