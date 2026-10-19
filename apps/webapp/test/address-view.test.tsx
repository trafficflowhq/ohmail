/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DEMO_NOW, FixturesAdapter, OhmailEngine,
  type ServerAddressOpts, type ServerAddressWire,
} from "@ohmail/client-engine";
import { useAddressView, messagesWith, type AddressView } from "../app/shell/address-view";

// React only accepts `act` in an environment that declares itself one; without this every
// render logs a warning that a later reader cannot tell from a real problem. Same line as
// every other jsdom test in this directory.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ═══ THE ADDRESS VIEW'S CONTRACT — the only thing the view is allowed to consume ═══════════
 *
 * The DEVICE answers all three directions off the mirror; the ARCHIVE answers all three too since
 * mail 0154, but a server that predates it answers `from` only (the engine falls back), and the
 * view must not smooth that over. So the properties under test are the ones that keep a partial
 * answer from reading as a complete one:
 *
 *  1. `coverage` is `senders-only` exactly when the archive answered a NARROWER direction than
 *     the one on screen. This is the field the view renders its caveat from, and getting it
 *     wrong is silent: a view comparing nothing renders an older server's from-half under
 *     "To them" and every number adds up.
 *  2. THE TOGGLE ASKS ITS OWN DIRECTION, once: each direction is one request, and a toggle back
 *     re-uses the answer it already has instead of blanking the count line while it re-asks.
 *  3. A STALE ANSWER IS DISCARDED. Navigating from one person to another while a pass is open
 *     must not attach the first person's mail to the second person's header.
 *  4. DEVICE ROWS FIRST, and an archive row the mirror already holds is not appended twice.
 */

const JONAS = "jonas@lichtgrat.example";

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let seen: AddressView | null = null;
/** Every address the transport was asked about, in order. Length is the request count. */
let asked: string[] = [];
/** The direction each of those requests carried, in the same order. */
let directions: string[] = [];

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  seen = null;
  asked = [];
  directions = [];
  vi.useRealTimers();
});

function Harness(
  { engine, address, direction, version }:
  { engine: OhmailEngine; address: string; direction: "any" | "from" | "to"; version: number },
): null {
  seen = useAddressView({ engine, version, address, direction });
  return null;
}

async function mount(
  engine: OhmailEngine, address: string, direction: "any" | "from" | "to" = "any",
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(Harness, { engine, address, direction, version: 1 })));
}

async function rerender(
  engine: OhmailEngine, address: string, direction: "any" | "from" | "to", version = 1,
): Promise<void> {
  await act(async () => root!.render(React.createElement(Harness, { engine, address, direction, version })));
}

/** Let every promise the effect started settle. */
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); });
}

/**
 * An engine whose archive answers with rows the mirror does not hold. `hold` lets a case keep a
 * pass in flight, which is how the stale-answer property is measured rather than raced.
 */
function engineWith(
  answer: (address: string) => ServerAddressWire | null,
  hold?: { promise: Promise<void> },
): OhmailEngine {
  return new OhmailEngine({
    adapter: new FixturesAdapter(),
    now: () => DEMO_NOW,
    serverAddressSearch: async (address: string, opts: ServerAddressOpts) => {
      asked.push(address);
      directions.push(opts.direction ?? "from");
      if (hold) await hold.promise;
      return answer(address);
    },
  });
}

/** One archive-only row. Shaped as a `MessageDTO`, which is what the wire carries. */
function archiveRow(id: string, from: string, date: string) {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `archive ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date, folder: "INBOX" as const, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none" as const, updatedAt: date,
  };
}

describe("useAddressView — the device half, the archive half, and what covers what", () => {
  it("reports `senders-only` for All and To them, and `complete` for From them", async () => {
    const engine = engineWith(() => ({ items: [], total: 0, direction: "from" }));
    await engine.start();

    await mount(engine, JONAS, "any");
    await settle();
    // The archive answered `from`; the screen says All. The view owes the reader a sentence.
    expect(seen!.archive.state).toBe("ready");
    expect(seen!.coverage).toBe("senders-only");

    await rerender(engine, JONAS, "to");
    await settle();
    expect(seen!.coverage).toBe("senders-only");

    // …and when the screen shows the direction the archive answered, there is nothing to caveat.
    await rerender(engine, JONAS, "from");
    await settle();
    expect(seen!.coverage).toBe("complete");
  });

  it("`complete` while the archive is unavailable or failed — the view states THAT instead", async () => {
    // A caveat about recipients over a list that has no archive behind it at all would be a
    // second, contradictory sentence about the same absence. `coverage` is about a READY answer.
    const noArchive = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await noArchive.start();
    await mount(noArchive, JONAS, "to");
    await settle();
    expect(noArchive.serverAddressSearchAvailable()).toBe(false);
    expect(seen!.archive.state).toBe("unavailable");
    expect(seen!.coverage).toBe("complete");
    expect(asked).toHaveLength(0);
  });

  it("each direction is asked once, on the wire, and a toggle back re-uses its answer", async () => {
    const engine = engineWith(() => ({ items: [], total: 0, direction: "from" }));
    await engine.start();

    await mount(engine, JONAS, "any");
    await settle();
    expect(directions).toEqual(["any"]);

    await rerender(engine, JONAS, "from");
    await settle();
    await rerender(engine, JONAS, "to");
    await settle();
    expect(directions).toEqual(["any", "from", "to"]);
    expect(asked).toEqual([JONAS, JONAS, JONAS]);

    // Back to All: the answer held for it is shown at once, and nothing is asked again.
    await rerender(engine, JONAS, "any");
    expect(seen!.archive.state).toBe("ready");
    await settle();
    expect(directions).toEqual(["any", "from", "to"]);
    expect(seen!.archive.state).toBe("ready");
  });

  it("under To them the archive answers `to`: its rows are listed and the coverage is complete", async () => {
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(),
      now: () => DEMO_NOW,
      serverAddressSearch: async (address: string, opts: ServerAddressOpts) => {
        asked.push(address);
        directions.push(opts.direction ?? "from");
        return { items: [archiveRow(`to-${opts.direction}`, "mila@lichtgrat.example", "2020-01-01T00:00:00.000Z")] as never, total: 4, direction: opts.direction ?? "from" };
      },
    });
    await engine.start();
    await mount(engine, JONAS, "to");
    await settle();
    expect(directions).toEqual(["to"]);
    expect(seen!.coverage).toBe("complete");
    expect(seen!.items.filter((r) => r.archiveOnly).map((r) => r.hit.message.id)).toEqual(["to-to"]);
    if (seen!.archive.state === "ready") expect(seen!.archive.direction).toBe("to");
  });

  it("device rows come first, and an archive row the mirror already holds is not duplicated", async () => {
    // The archive answers with the mirror's OWN `jonas` row plus one the device does not hold.
    const engine = engineWith(() => ({
      items: [
        // Same id as the fixture: the mirror holds it, so it must not be appended again.
        archiveRow("jonas", JONAS, "2026-01-01T00:00:00.000Z"),
        archiveRow("older-1", JONAS, "2020-01-01T00:00:00.000Z"),
      ] as never,
      total: 2,
      direction: "from",
    }));
    await engine.start();
    await mount(engine, JONAS, "any");
    await settle();

    const ids = seen!.items.map((r) => r.hit.message.id);
    // `jonas` appears ONCE, as the device's own row.
    expect(ids.filter((id) => id === "jonas")).toHaveLength(1);
    expect(seen!.items[0]!.archiveOnly).toBe(false);
    // …and the archive's extra is appended behind it, marked.
    const extra = seen!.items.find((r) => r.hit.message.id === "older-1");
    expect(extra).toBeDefined();
    expect(extra!.archiveOnly).toBe(true);
    // The archive-only row carries no relevance either — an address query is an equality.
    expect(extra!.hit.score).toBe(0);
    expect(extra!.hit.matches).toEqual([]);
  });

  it("holds the archive's rows back under To them, and gives them back under All", async () => {
    // THE PROPERTY, and the one the contract used to get wrong on its own: the archive answers
    // `from`, so its rows are mail this address SENT. Appended under a list titled "To them"
    // they are a claim that this address was WRITTEN TO — with a 200 and a count that adds up,
    // which is why no other assertion here could see it.
    const engine = engineWith(() => ({
      items: [archiveRow("sent-by-them", JONAS, "2020-01-01T00:00:00.000Z")] as never,
      total: 1,
      direction: "from",
    }));
    await engine.start();

    await mount(engine, JONAS, "to");
    await settle();
    expect(seen!.archive.state).toBe("ready");
    // The device holds nothing sent TO Jonas in the fixture world, so the honest answer is an
    // empty list — not one row of his own mail.
    expect(messagesWith(engine, JONAS, "to").items).toHaveLength(0);
    expect(seen!.items.filter((r) => r.archiveOnly)).toHaveLength(0);
    expect(seen!.items).toHaveLength(0);
    // …and the shortfall is still NAMED rather than hidden: the view renders its sentence from
    // this, and an empty list with `complete` beside it would read as "nothing was ever sent".
    expect(seen!.coverage).toBe("senders-only");

    // Under All the same row belongs — All includes what they sent — and is marked as the
    // archive's. One request throughout: the toggle never reaches the wire.
    await rerender(engine, JONAS, "any");
    await settle();
    const extras = seen!.items.filter((r) => r.archiveOnly).map((r) => r.hit.message.id);
    expect(extras).toEqual(["sent-by-them"]);
    expect(directions).toEqual(["to", "any"]);

    // And under From them, the direction the archive itself answered.
    await rerender(engine, JONAS, "from");
    await settle();
    expect(seen!.items.filter((r) => r.archiveOnly).map((r) => r.hit.message.id))
      .toEqual(["sent-by-them"]);
    expect(directions).toEqual(["to", "any", "from"]);
  });

  it("a failed pass carries its own retry, and pressing it asks again", async () => {
    // The refusal is the one archive state a reader can act on. A retry that did not re-issue
    // the request would be a button that does nothing — the same defect as no button, and
    // harder to see, because the sentence beside it is already about a failure.
    let attempt = 0;
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(),
      now: () => DEMO_NOW,
      serverAddressSearch: async (address: string) => {
        asked.push(address);
        attempt += 1;
        if (attempt === 1) throw new Error("the archive is down");
        return { items: [archiveRow("older-1", JONAS, "2020-01-01T00:00:00.000Z")] as never, total: 7, direction: "from" as const };
      },
    });
    await engine.start();

    await mount(engine, JONAS, "any");
    await settle();
    expect(seen!.archive.state).toBe("failed");
    expect(asked).toEqual([JONAS]);

    // The press. `retry` lives on the failed arm, so this cannot be written against any other.
    const refused = seen!.archive;
    if (refused.state !== "failed") throw new Error("expected a failed pass to retry");
    await act(async () => { refused.retry(); });
    await settle();

    expect(asked).toEqual([JONAS, JONAS]);
    // Read afresh: the value asserted above is the REFUSAL, and this is the answer that replaced it.
    const answered = seen!.archive;
    expect(answered.state).toBe("ready");
    // The COUNT the view prints comes back with it — the point of the press.
    if (answered.state === "ready") expect(answered.total).toBe(7);
    expect(seen!.items.filter((r) => r.archiveOnly).map((r) => r.hit.message.id)).toEqual(["older-1"]);
  });

  it("discards an answer for an address the reader has navigated away from", async () => {
    // THE PROPERTY: the slow pass lands after the question changed. Rendering it would put one
    // person's mail under another person's header — worse here than on the search box, because
    // the header states whose mail this is.
    let release: (() => void) | null = null;
    const hold = { promise: new Promise<void>((r) => { release = r; }) };
    const engine = engineWith(
      (address) => ({
        items: [archiveRow(`only-for-${address}`, address, "2020-01-01T00:00:00.000Z")] as never,
        total: 1,
        direction: "from",
      }),
      hold,
    );
    await engine.start();

    await mount(engine, JONAS, "any");
    await settle();
    // The first pass is in flight and has not answered.
    expect(asked).toEqual([JONAS]);
    expect(seen!.archive.state).toBe("searching");

    // Navigate to somebody else while it is open, then let BOTH passes answer.
    await rerender(engine, "rahel@lichtgrat.example", "any");
    await settle();
    release!();
    await settle();

    // The rendered list holds nothing minted for the address we left.
    const ids = seen!.items.map((r) => r.hit.message.id);
    expect(ids).not.toContain(`only-for-${JONAS}`);
    // And the counts are the SECOND address's, from the device, not the first's.
    expect(seen!.counts).toEqual(messagesWith(engine, "rahel@lichtgrat.example", "any").counts);
  });

  it("an empty address asks nothing, renders nothing, and does not SPIN", async () => {
    const engine = engineWith(() => ({ items: [], total: 0, direction: "from" }));
    await engine.start();
    for (const blank of ["", "   "]) {
      await (blank === "" ? mount(engine, blank, "any") : rerender(engine, blank, "any"));
      await settle();
      expect(asked).toHaveLength(0);
      expect(seen!.items).toHaveLength(0);
      expect(seen!.counts).toEqual({ any: 0, from: 0, to: 0 });
      // THE STATE, not just the emptiness. Leaving the pass unset read as `searching` — a view
      // saying "searching the archive" about a question nobody will ever ask, with nothing that
      // could ever resolve it. `ready` with nothing is the true sentence.
      expect(seen!.archive.state).toBe("ready");
      if (seen!.archive.state === "ready") {
        expect(seen!.archive.total).toBe(0);
        expect(seen!.archive.items).toEqual([]);
      }
      // …and `coverage` is `complete`: there is no shortfall to caveat about no question.
      expect(seen!.coverage).toBe("complete");
    }
  });

  it("a failed pass is a named state, not an empty list", async () => {
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(),
      now: () => DEMO_NOW,
      serverAddressSearch: async (address: string) => {
        asked.push(address);
        throw new Error("the archive is down");
      },
    });
    await engine.start();
    await mount(engine, JONAS, "any");
    await settle();

    expect(seen!.archive.state).toBe("failed");
    if (seen!.archive.state === "failed") expect(seen!.archive.error).toBe("the archive is down");
    // The DEVICE half still rendered — a failed archive does not empty the list.
    expect(seen!.items.length).toBeGreaterThan(0);
    expect(seen!.items.every((r) => !r.archiveOnly)).toBe(true);
  });

  it("`null` from the transport is `unavailable`, never an empty `ready`", async () => {
    // "We searched the archive and this person sent nothing" is a claim; `null` is the case
    // where nothing was searched. The two must not render alike.
    const engine = engineWith(() => null);
    await engine.start();
    await mount(engine, JONAS, "any");
    await settle();
    expect(asked).toEqual([JONAS]);
    expect(seen!.archive.state).toBe("unavailable");
  });

  it("re-derives the device half when the mirror moves", async () => {
    const engine = engineWith(() => ({ items: [], total: 0, direction: "from" }));
    await engine.start();
    await mount(engine, JONAS, "any");
    await settle();
    expect(seen!.counts).toEqual({ any: 1, from: 1, to: 0 });

    // A real send through the engine, then a render at the new mirror version.
    const res = await engine.mutate({ kind: "mail_send", inReplyTo: "jonas", body: "The 18th." });
    expect(res.status).toBe("confirmed");
    await rerender(engine, JONAS, "any", 2);
    await settle();
    expect(seen!.counts).toEqual({ any: 2, from: 1, to: 1 });
  });
});
