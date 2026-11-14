/** @vitest-environment jsdom */
/**
 * WHAT ONE PUBLISH COSTS THE WINDOW — counted, per component and per whole-mirror pass.
 *
 * The renderer-peak rig reads the MAGNITUDE (megabytes of resident peak per shell re-render,
 * independent of the row count, on a real WebKit web process). It cannot say WHICH components
 * ran or WHY. This file is the other half: the mail frame over an engine whose publishes
 * are scripted one at a time, with every view and pane wrapped in a counter, so a publish's cost
 * is a number rather than an impression.
 *
 * THE INSTRUMENT IS EXACT, NOT A HEURISTIC. React's own profiler answers "did this subtree do
 * work" by timing, and a fiber that was never visited keeps its previous commit's duration —
 * which reads as work on a quiet subtree. So the count here is of FUNCTION-BODY INVOCATIONS:
 * each component is replaced by a wrapper that increments a counter and renders the real one.
 * `SyncBar` is the shell's own counter — `ShellInner` renders it unconditionally and nothing
 * memoizes it, so its count IS the whole-window re-render count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

const renders = new Map<string, number>();
const bump = (name: string): void => { renders.set(name, (renders.get(name) ?? 0) + 1); };
export const countOf = (name: string): number => renders.get(name) ?? 0;

/** Wrap one component export in a body-invocation counter, preserving everything it does. */
function counted<P>(name: string, Real: React.ComponentType<P>): React.ComponentType<P> {
  const Wrapped = (props: P): React.ReactElement => {
    bump(name);
    return React.createElement(Real as React.ComponentType<object>, props as object);
  };
  Wrapped.displayName = `counted(${name})`;
  return Wrapped as React.ComponentType<P>;
}

/* A publish can update the address book and reach Write's people line without redrawing the letter.
   Count both. The kit's Recipients owns the open chip list and its cursor. */
vi.mock("../../../packages/app/src/write/Letter", async (orig) => {
  const actual = await orig<typeof import("../../../packages/app/src/write/Letter")>();
  return { ...actual, Letter: counted("ComposeView", actual.Letter) };
});
vi.mock("../../../packages/app/src/write/head/People", async (orig) => {
  const actual = await orig<typeof import("../../../packages/app/src/write/head/People")>();
  return { ...actual, People: counted("ComposeView", actual.People) };
});
/* THE CHIP FIELD ITSELF, and not only the view above it. A loop in this component's own state
   re-renders THIS subtree and nothing higher, so a counter on `ComposeView` cannot see it —
   measured: the loop ran the file past five minutes while the view's count sat at its ordinary
   number. The instrument has to sit where the state does. */
vi.mock("@ohmail/ui/mail", async (orig) => {
  const actual = await orig<typeof import("@ohmail/ui/mail")>();
  return { ...actual, Recipients: counted("RecipientField", actual.Recipients) };
});

import {
  ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

import { MemoryMirrorStore, OhmailEngine, type EntityReader } from "@ohmail/client-engine";

/** Every whole-mirror pass a render made, by type — the derivation counter. */
const scans: string[] = [];

/**
 * WHO MADE THE PASS, with `OHMAIL_SCAN_STACKS=1`. Off by default because it is noise, kept
 * because it is how the three whole-mirror reads that ran on EVERY render — regardless of any
 * version — were found: the compose fallback's sending mailbox (which sorts the entire mailbox),
 * the shared date order behind it, and the durable outbox's pending-lane read. A count says a
 * pass happened; only a stack says who asked for it.
 */
const stacks: string[] = [];
const noteCaller = (what: string): void => {
  if (!process.env.OHMAIL_SCAN_STACKS) return;
  stacks.push(`${what}\n${(new Error().stack ?? "").split("\n").slice(1, 7).join("\n")}`);
};
export const callersSeen = (): string[] => stacks;

/**
 * The reader the shell reads through, wrapped once per underlying object so the memo identities
 * the shell keys on are untouched. `list`/`entries` on a mail type IS the whole-mirror pass the
 * store's own bucket cache rebuilds per version, so counting the calls counts the derivations.
 *
 * It forwards the STAMPS, and that is not boilerplate: a wrapper that dropped them would hand
 * the shell a stamp that never moves, and the window would hold a projection of a mirror that had
 * changed. This one dropped them while it was being written and the mount died on the spot —
 * which is the loud version of the failure `derived-stamp-census.test.ts` exists to catch quietly.
 */
const wrapped = new WeakMap<object, EntityReader>();
function counting(real: EntityReader): EntityReader {
  const had = wrapped.get(real as object);
  if (had) return had;
  const proxy: EntityReader = {
    get: (t, i) => real.get(t, i),
    list: (t) => { scans.push(`list:${t}`); noteCaller(`list:${t}`); return real.list(t); },
    entries: (t) => { scans.push(`entries:${t}`); noteCaller(`entries:${t}`); return real.entries(t); },
    version: () => real.version(),
    stampOf: (t) => real.stampOf(t),
    stampExcept: (i) => real.stampExcept(i),
  } as EntityReader;
  wrapped.set(real as object, proxy);
  return proxy;
}

let seqNo = 0;
const ISO_NOW = "2026-08-04T09:00:00.000Z";

/** One `/sync` page of `n` fresh messages plus a consent rule for each sender. */
function messagePage(n: number): { changes: unknown; cursor: string; hasMore: boolean; serverTime: string } {
  const creates: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const id = `mm${++seqNo}`;
    creates.push({
      type: "message", op: "create", id, seq: seqNo, updatedAt: ISO_NOW,
      entity: {
        id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
        subject: `subject of ${id}`,
        from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
        to: [], cc: [], date: ISO_NOW, folder: "INBOX", snippet: `snippet of ${id}`,
        unread: true, hasAttachments: false, attachmentCount: 0, sensitivity: {},
        triage: null, labels: [], remoteContent: "none", updatedAt: ISO_NOW,
      },
    });
    creates.push({
      type: "rule", op: "create", id: `rule_${id}`, seq: ++seqNo, updatedAt: ISO_NOW,
      entity: {
        id: `rule_${id}`, kind: "sender", match: `${id}@example.invalid`, destination: "INBOX",
        priority: 0, provenance: "seeded-from-sent", enabled: true,
        stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO_NOW, updatedAt: ISO_NOW,
      },
    });
  }
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seqNo}`, hasMore: false, serverTime: ISO_NOW };
}

/** The engine the shell is handed, with a feed the test pushes one page at a time into. */
async function buildEngine(): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore; feed: unknown[] }> {
  const store = new MemoryMirrorStore();
  const feed: unknown[] = [];
  const adapter = {
    sync: async () => feed.shift() ?? { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: `c${seqNo}`, hasMore: false, serverTime: ISO_NOW },
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => ({ text: `body of ${id}`, html: null, loadedRemoteContent: false }),
    fetchBodies: async (ids: string[]) => ids.map((id) => ({ messageId: id, text: `body of ${id}`, html: null, loadedRemoteContent: false })),
    /* THE ATTACHMENT CAPABILITY, present on purpose. `attachmentsAvailable()` reads these two off
       the adapter, and it gates the shell's attachment notice — an adapter without them would
       switch that subscription off for every arm below and measure a window the product is not. */
    listAttachments: async (id: string) => [
      { id: `${id}-a1`, filename: "note.txt", mimeType: "text/plain", sizeBytes: 12, inline: false },
    ],
    fetchAttachment: async () => ({ blob: new Blob([]), name: "x", mime: "text/plain" }),
  };
  const engine = new OhmailEngine({ adapter: adapter as never, store, eagerBodies: false });
  const realRead = engine.read.bind(engine);
  (engine as unknown as { read: () => EntityReader }).read = () => counting(realRead());
  await engine.start();
  return { engine, store, feed };
}


/**
 * THE CONSTANT — what a publish costs the window whatever it carried.
 *
 * Not zero, and it should not be: `useFreshness` publishes the mirror's "as of" stamp, which a
 * completed drain genuinely moves, and the shell draws it. Two renders per drain is that label
 * and nothing else; a body publish moves no stamp and is expected to cost none at all.
 */
const PUBLISH_CONSTANT = 2;

/** The components a body landing may not redraw. Each is a whole subtree of the window. */
const UNRELATED_TO_A_BODY = ["SyncBar", "TodaysOhbox", "FoldersRailGroup"] as const;

/**
 * ═══ A MIRROR DELTA LANDING ON AN OPEN COMPOSER ═══════════════════════════════════════
 *
 * The 0.20.0 review caught ONE production `Minified React error #185` (maximum update depth)
 * during its compose cell and could not reproduce it in three replays. The standing hypothesis
 * was a live sync delta racing the composer's recipient-chip state: the address book is DERIVED
 * FROM THE MIRROR, so every arriving message rebuilds `RecipientField`'s `suggestions` memo,
 * its `labels` memo behind that, and re-runs the one effect in the composer's chip path that
 * sets state from a value it also depends on —
 *
 *     useEffect(() => { if (cursor >= suggestions.length) setCursor(0); },
 *              [suggestions.length, cursor]);
 *
 * which is the shape that ping-pongs when the guard does not hold. This drives exactly that: a
 * composer open with a live tail in To, a cursor moved off zero, and fifty pages of mail landing
 * underneath it, each one adding a sender the tail matches.
 *
 * WHAT THIS CATCHES, AND WHAT IT DOES NOT — both measured, because a guard described by its
 * intention is a guard nobody has watched.
 *
 *  · IT CATCHES the cheap version: a derived value turned into state written from an effect.
 *    Driven twice into `RecipientField` (`live` and the label count) it costs two extra renders
 *    per publish and this case goes red by name. That is how this defect usually arrives.
 *  · IT DOES NOT convert a true update LOOP into a named red. Driven — the labels memo dropped
 *    so the derived array is fresh per render, plus state mirroring it with the array in deps —
 *    the file ran past four minutes and was killed by the timeout, with no assertion reached. A
 *    counter tripwire was tried and did not fire either: the throw lands inside the shell's own
 *    view boundary. So a loop here reads as a SUITE TIMEOUT, which is red but names nothing, and
 *    the production `#185` the 0.20.0 review saw once is NOT REPRODUCED by this file.
 *
 * The standing answer to the loud version is the route-level boundary (`app/(product)/error.tsx`,
 * landed before this): a render throw in the shell now renders a sentence and a reload rather
 * than Next's blank "Application error", which is the half of that change that was actually missing.
 */
describe("fifty deltas under an open composer", () => {
  beforeEach(() => { renders.clear(); scans.length = 0; installShellEnv(); });
  afterEach(teardownShellEnv);

  /**
   * Per publish: the composer redraws for the book behind its suggestions, and no more. MEASURED
   * at 2 — `PUBLISH_CONSTANT`, the same cost every other surface pays for a publish — with the
   * ceiling one above it so a regression to three is red rather than absorbed.
   */
  const COMPOSE_RENDERS_PER_PUBLISH = 3;
  const DELTAS = 50;

  it("the composer survives fifty publishes with a live recipient tail and a moved cursor", async () => {
    const { engine, feed } = await buildEngine();
    const el = await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(100);
    feed.push(messagePage(20));
    await act(async () => { await engine.syncOnce(); });
    await tick(50);

    await act(async () => {
      window.location.hash = "#/compose";
      window.dispatchEvent(new Event("hashchange"));
    });
    await tick(300);

    /** Write's new letter's To line (today's `#compose-to`). */
    const toLine = (): HTMLInputElement | null =>
      el.querySelector<HTMLInputElement>('[role="region"][aria-label="New message"] [role="combobox"][aria-label="To"]');
    const to = toLine();
    expect(to, "the composer never rendered its To field, so nothing below measures anything")
      .not.toBeNull();

    /* A TAIL THAT MATCHES EVERY ARRIVING SENDER (`mm<n>@example.invalid`), so the suggestion
       list genuinely moves under the open list on every publish. */
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value",
      )!.set!;
      setter.call(to!, "mm");
      to!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(50);

    /* CURSOR OFF ZERO is the precondition: at zero the guard's `setCursor(0)` is a no-op write
       React bails out of, and the case would pass for a reason that has nothing to do with the
       rule under test. */
    for (const key of ["ArrowDown", "ArrowDown"]) {
      await act(async () => {
        to!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    }
    await tick(50);
    renders.clear(); scans.length = 0;

    for (let i = 0; i < DELTAS; i++) {
      feed.push(messagePage(1));
      await act(async () => { await engine.syncOnce(); });
    }
    await tick(200);

    // It genuinely ran: a case where no publish reached the composer would satisfy any ceiling.
    expect(countOf("ComposeView"), "no publish reached the open composer").toBeGreaterThan(0);
    expect(countOf("RecipientField"), "no publish reached the chip field").toBeGreaterThan(0);
    for (const name of ["ComposeView", "RecipientField"] as const) {
      expect(
        countOf(name),
        `${name} redrew ${countOf(name)} times for ${DELTAS} publishes`,
      ).toBeLessThanOrEqual(DELTAS * COMPOSE_RENDERS_PER_PUBLISH);
    }
    // And the form is still on screen — a composer that unmounted under the deltas would be a
    // worse failure than a loud one, and it would pass the ceiling.
    expect(toLine(), "the composer left the screen").not.toBeNull();
  });
});
