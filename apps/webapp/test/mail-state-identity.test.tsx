/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * A POLL THAT LEARNED NOTHING PUBLISHES NOTHING, AND A POLL THAT LEARNED SOMETHING THE PARTITION
 * DOES NOT CARE ABOUT DOES NOT REBUILD IT.
 *
 * Two seams, one cost. `GET /mailboxes` is re-read every thirty seconds and parses a fresh array
 * out of the wire each time, so `setFacts(got)` used to publish a NEW IDENTITY on every poll even
 * when every field was identical; and `ownAddresses` was keyed on that array, so it produced a new
 * value whenever ANY mailbox field moved — including `pendingMoves`, which decrements on every poll
 * for as long as the organizer has a backlog. `ownAddresses` is a dependency of `consentView`, so
 * either one rebuilt the whole-mirror consent partition and the projection over every message in
 * the mailbox. On a mailbox of a few thousand messages that is about a gigabyte an hour of retained memory
 * (the project's design notes).
 *
 * ── WHAT MAKES THIS CENSUS NON-VACUOUS, AND IT IS THREE THINGS ───────────────────────────────
 *
 * 1. The probe resolves a STRUCTURALLY-CLONED copy per call. A probe handing back the same array
 *    would make the identity assertion true for a reason that has nothing to do with the gate.
 * 2. The partition must actually be running. `AppShell` returns `null` from `consentView` in demo
 *    mode, so a demo-mode census counts zero calls and passes green over a shell that derives
 *    nothing. This mounts the standalone (desktop) shape and asserts `placeOf.size` equals the
 *    message count BEFORE it counts anything.
 * 3. The `pendingMoves` case asserts BOTH halves: the facts identity is allowed to change (the
 *    equality gate must not swallow a real change), and the partition must not be rebuilt for it.
 *
 * ── MUTATIONS WATCHED ───────────────────────────────────────────────────────────────────────
 *
 *  · revert `MailStateProvider`'s `setFacts`/`setProbedFreshness` equality gate to `setFacts(got)`
 *    → "an unchanged answer keeps its identity" fails: two polls, two identities.
 *  · revert `ownAddresses` to `[facts, rememberedOwn]`
 *    → "a pendingMoves-only change does not rebuild the partition" fails: the spy counts a second
 *      call.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "";
process.env.NEXT_PUBLIC_DESKTOP = "1";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollTo ??= function scrollTo() {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const N_MESSAGES = 60;

/** Every partition the shell has derived, so the census can count them and inspect the last. */
const partitions: Array<{ placeOf: Map<string, unknown> }> = [];
/** The `ownAddresses` each derivation was actually GIVEN — see the address-change case. */
const ownArgs: string[][] = [];

vi.mock("@ohmail/client-engine", async (importActual) => {
  const actual = await importActual<typeof import("@ohmail/client-engine")>();
  return {
    ...actual,
    consentPartition: (...args: Parameters<typeof actual.consentPartition>) => {
      const part = actual.consentPartition(...args);
      partitions.push(part as unknown as { placeOf: Map<string, unknown> });
      ownArgs.push([...((args[1] as { ownAddresses?: string[] } | undefined)?.ownAddresses ?? [])]);
      return part;
    },
  };
});

const NOW = new Date("2026-08-02T12:00:00.000Z");
const {
  MemoryMirrorStore, OhmailEngine,
} = await import("@ohmail/client-engine");
const { FACTS_POLL_MS } = await import("@ohmail/app-logic/mail-state/mail-state-binding");
type EngineMessage = import("@ohmail/client-engine").EngineMessage;
type SyncChange = import("@ohmail/client-engine").SyncChange;

let seq = 0;
function msg(i: number): EngineMessage {
  const d = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
  return {
    id: `m${i}`, accountId: "acct_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${i}`, from: { name: null, address: `s${i % 6}@example.invalid` },
    to: [], cc: [], date: d, folder: "ohmail/Screener",
    snippet: `snippet ${i}`, unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: d,
  } as unknown as EngineMessage;
}
const create = (m: EngineMessage): SyncChange =>
  ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m }) as SyncChange;

interface Row { [k: string]: unknown; address: string; pendingMoves: number }
/* `organizedBy` is NESTED on purpose. Every scalar in this row could be compared by a shallow
   walk, so a comparator that only looked one level deep would pass every case here while freezing
   a structured change — and `organizedBy` is a real `MailboxFacts` field, not a probe. */
const row = (pendingMoves: number, organizerName = "this Mac"): Row => ({
  organizedBy: { kind: "device", name: organizerName, since: NOW.toISOString() },
  id: "mb_1", address: "rig@example.invalid", status: "connected",
  errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: NOW.toISOString(), pendingMoves, serverMessageCount: N_MESSAGES,
});

async function bareEngine(): Promise<InstanceType<typeof OhmailEngine>> {
  const store = new MemoryMirrorStore();
  await store.load();
  return new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
    } as never,
  });
}

async function mountShell(probe: () => Promise<Row[]>): Promise<{ root: Root; drain: () => Promise<void> }> {
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(Array.from({ length: N_MESSAGES }, (_, i) => msg(i)).map(create));
  // Rules that RELOCATE, so the partition places rows somewhere other than their own folder and the
  // projection actually clones — without them the derivation under test is a near no-op.
  for (let k = 0; k < 5; k++) {
    await store.putLocal("rule", `r${k}`, {
      id: `r${k}`, kind: "sender", match: `s${k}@example.invalid`,
      destination: k % 2 === 0 ? "ohmail/News" : "INBOX",
      priority: 0, provenance: "manual", enabled: true, createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => ({ text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    } as never,
  });

  const { AppShell } = await import("./_todays-shell.js");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: messages as never, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, {
        storageKey: null as never,
        children: h(ToastHost as never, {
          children: h(AppShell as never, { engine, mailboxFacts: probe } as never),
        } as never),
      }),
    } as never));
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  };
  await settle();
  /* ONE WHOLE POLL INTERVAL, on fake timers. `MailStateProvider` re-reads `GET /mailboxes` on a
     `setInterval` at FACTS_POLL_MS, and a driver that only flushed microtasks never fired it — the
     first cut of this test did exactly that, so it counted zero extra polls and stayed green under
     a mutation that removed the equality gate entirely. Advancing the clock is what makes the
     subject run. */
  const poll = async (): Promise<void> => {
    await act(async () => { await vi.advanceTimersByTimeAsync(FACTS_POLL_MS + 50); });
    await settle();
  };
  return { root, drain: poll };
}

afterEach(() => { vi.useRealTimers(); });

describe("the mailbox poll", () => {
  it("republishes NOTHING when the answer did not change", async () => {
    vi.useFakeTimers();
    const seen: Array<readonly unknown[] | null> = [];
    let calls = 0;
    // STRUCTURALLY CLONED per call: equal content, never the same object — see the header. A probe
    // handing back one array would make this assertion true without the gate existing.
    const probe = async (): Promise<Row[]> => { calls++; return structuredClone([row(7)]); };
    /* THE FRESHNESS HALF, which the first version of this test never ran at all: with no
       freshnessProbe supplied, `setProbedFreshness` is unreachable and removing ITS equality gate
       changed nothing observable. Same contract — a fresh object per call, equal content. */
    let freshCalls = 0;
    const freshness = async (): Promise<unknown> => {
      freshCalls++;
      return structuredClone({ state: "current", asOf: NOW.toISOString() });
    };
    const seenFresh: unknown[] = [];

    const { EngineProvider } = await import("../app/shell/engine.js");
    const { MailStateProvider } = await import("@ohmail/app/mail-state");
    const { useMailState } = await import("@ohmail/app-logic/mail-state/mail-state-binding");
    const engine = await bareEngine();

    function Watch(): React.ReactElement {
      const b = useMailState();
      seen.push(b.mailboxes);
      seenFresh.push(b.freshness);
      return h("i", null, "x");
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages: messages as never, timeZone: "UTC", now: NOW,
        children: h(EngineProvider as never, {
          demo: false, engine,
          children: h(MailStateProvider as never, { scope: null, probe, freshnessProbe: freshness, mirrored: 0, children: h(Watch) } as never),
        } as never),
      } as never));
    });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    };
    await settle();

    const published = seen.filter((m): m is readonly unknown[] => m !== null);
    // The probe must have ANSWERED, or every identity below is `null` and the test is vacuous.
    expect(published.length).toBeGreaterThan(0);
    const first = published[published.length - 1]!;

    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(FACTS_POLL_MS + 50); });
      await settle();
    }
    // The polls must have RUN — otherwise the gate was never asked anything.
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(freshCalls).toBeGreaterThanOrEqual(4);

    const after = seen.filter((m): m is readonly unknown[] => m !== null);
    expect(after[after.length - 1]).toBe(first);
    // …and every identity the consumer ever saw after the first answer is that same one.
    expect(new Set(after).size).toBe(1);
    /* The freshness verdict, same rule and same reason — but only the PROBED answers. Before the
       first one lands the provider presents a fresh `{state: "unknown"}` literal per render, which
       is its own (bounded, pre-answer) churn and not what this gate is about. */
    const freshSeen = seenFresh.filter(
      (f): f is { state: string } =>
        typeof f === "object" && f !== null && (f as { state?: string }).state === "current");
    expect(freshSeen.length).toBeGreaterThan(0);
    expect(new Set(freshSeen).size).toBe(1);
    root.unmount();
  });

  it("PUBLISHES a changed fact and a changed freshness verdict — the gate must not freeze either", async () => {
    /* THE OTHER DIRECTION OF THE EQUALITY GATE, and without it the gate is untestable in the way
       that matters. Every other case here asserts that an UNCHANGED answer is not republished — a
       comparator that only looked at the addresses, or a `setProbedFreshness(prev => prev ?? got)`
       that keeps the first verdict for ever, satisfies all of them perfectly while silently
       freezing the strip on stale facts. This asserts the changes REACH the consumer. */
    vi.useFakeTimers();
    let moves = 40;
    let organizer = "this Mac";
    let state = "current";
    let asOf = NOW.toISOString();
    const probe = async (): Promise<Row[]> => structuredClone([row(moves, organizer)]);
    const freshness = async (): Promise<unknown> => structuredClone({ state, asOf });

    const seen: Array<ReadonlyArray<{ pendingMoves?: number }> | null> = [];
    const seenFresh: unknown[] = [];

    const { EngineProvider } = await import("../app/shell/engine.js");
    const { MailStateProvider } = await import("@ohmail/app/mail-state");
    const { useMailState } = await import("@ohmail/app-logic/mail-state/mail-state-binding");
    const engine = await bareEngine();

    function Watch(): React.ReactElement {
      const b = useMailState();
      seen.push(b.mailboxes as never);
      seenFresh.push(b.freshness);
      return h("i", null, "x");
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages: messages as never, timeZone: "UTC", now: NOW,
        children: h(EngineProvider as never, {
          demo: false, engine,
          children: h(MailStateProvider as never,
            { scope: null, probe, freshnessProbe: freshness, mirrored: 0, children: h(Watch) } as never),
        } as never),
      } as never));
    });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    };
    await settle();

    const first = seen.filter((m) => m !== null).pop();
    expect(first?.[0]?.pendingMoves).toBe(40);

    /* A SCALAR alone first. `asOf` moves WITHOUT `state` changing in the same step — that is the
       common case for the "as of 14:32" label, and a comparator looking only at `state` swallows
       it. */
    moves = 12;
    asOf = "2026-08-02T13:30:00.000Z";
    await act(async () => { await vi.advanceTimersByTimeAsync(FACTS_POLL_MS + 50); });
    await settle();

    const latest = seen.filter((m) => m !== null).pop();
    expect(latest?.[0]?.pendingMoves).toBe(12);
    const latestFresh = seenFresh.filter(
      (f): f is { state: string; asOf: string } =>
        typeof f === "object" && f !== null && typeof (f as { state?: unknown }).state === "string").pop();
    expect(latestFresh?.asOf).toBe("2026-08-02T13:30:00.000Z");

    /* NOW A NESTED FIELD ALONE, every scalar identical. Moving it alongside a scalar proves
       nothing: a comparator that never descends still republishes for the scalar and the nested
       change rides along — measured, that exact mutation stayed green. Only a step where the
       nested field is the ONLY difference can tell a deep walk from a shallow one. */
    organizer = "the other laptop";
    await act(async () => { await vi.advanceTimersByTimeAsync(FACTS_POLL_MS + 50); });
    await settle();
    const nested = seen.filter((m) => m !== null).pop();
    expect((nested?.[0] as { organizedBy?: { name?: string } } | undefined)?.organizedBy?.name)
      .toBe("the other laptop");
    root.unmount();
  });

  it("DOES rebuild the partition when an address actually changes", async () => {
    /* THE OTHER DIRECTION, and without it the key is untestable: a review found that replacing
       `ownAddressKey` with a CONSTANT passed every assertion in this file, because every case only
       ever asserted that the partition was NOT rebuilt. A key that never changes satisfies that
       perfectly and silently freezes the presentation on the first account's addresses. */
    vi.useFakeTimers();
    partitions.length = 0;
    ownArgs.length = 0;
    let address = "rig@example.invalid";
    const probe = async (): Promise<Row[]> => structuredClone([{ ...row(0), address }]);

    const { root, drain } = await mountShell(probe);
    expect(partitions.length).toBeGreaterThan(0);
    expect(partitions[partitions.length - 1]!.placeOf.size).toBe(N_MESSAGES);

    const afterMount = partitions.length;
    address = "moved@example.invalid";
    await drain();

    expect(partitions.length).toBeGreaterThan(afterMount);
    /* AND THE REBUILD USED THE NEW ADDRESS. Counting invocations alone is not enough: replacing the
       `ownAddresses` VALUE with `() => []` while leaving its key live still rebuilds on every
       address change and still passes a count — and the partition then cannot recognise the
       account's own sent mail at all. The input is the thing worth asserting. */
    expect(ownArgs[ownArgs.length - 1]).toContain("moved@example.invalid");
    /* Over the SEQUENCE, not at index 0: the first derivation legitimately runs before the probe
       has answered, so its own-set is empty. What must be true is that the original address DID
       reach a derivation before the change — otherwise the "changed" one proves nothing. */
    expect(ownArgs.some((a) => a.includes("rig@example.invalid"))).toBe(true);
    root.unmount();
  });

  it("does not rebuild the partition when only pendingMoves moved", async () => {
    vi.useFakeTimers();
    partitions.length = 0;
    let moves = 40;
    const probe = async (): Promise<Row[]> => structuredClone([row(moves)]);

    const { root, drain } = await mountShell(probe);
    expect(partitions.length).toBeGreaterThan(0);
    expect(partitions[partitions.length - 1]!.placeOf.size).toBe(N_MESSAGES);

    const afterMount = partitions.length;
    // The organizer files a batch: a REAL change, which the equality gate must publish…
    moves = 39;
    await drain();
    moves = 38;
    await drain();
    // …and which the partition must not be rebuilt for, because no address moved.
    expect(partitions.length).toBe(afterMount);
    root.unmount();
  });

  /**
   * ── THE STRIP'S OWN `refresh` HANDLE IS PART OF THIS PROPERTY ─────────────────────────────
   *
   * `useMailState().refresh` was built inline in the binding's `useMemo`, whose deps include
   * `facts` — so it took a NEW identity on every poll, i.e. on exactly the `pendingMoves`-only
   * change the case above exists to keep cheap.
   *
   * That was harmless while its consumers only passed it down as a prop. It stopped being
   * harmless when a filing decision had to re-read the facts behind the strip: the shell's
   * `fileAndRefresh` depends on it, and `onMessageAction`/`onBulkAction` depend on that — so an
   * unstable handle rebuilds the shell's action handlers 120 times an hour, and a memoized
   * callback rebuilt per render pins the render that made it. That is the retained-scope chain
   * measured at about a gigabyte an idle hour, reached through a status poll.
   *
   * Measured through the SHELL and not the provider alone, deliberately: what has to hold is that
   * the identity the shell receives is constant, and the shell is where the consumers are.
   */
  it("the refresh handle keeps ONE identity across polls — the shell's handlers depend on it", async () => {
    vi.useFakeTimers();
    const handles: Array<() => void> = [];
    let moves = 12;
    // A CHANGING answer, so `facts` takes a new identity on every poll and the binding's memo —
    // the thing that used to rebuild the handle — actually recomputes. An unchanging probe would
    // pass through the equality gate above and prove nothing about this.
    const probe = async (): Promise<Row[]> => structuredClone([row(moves--)]);

    const { EngineProvider } = await import("../app/shell/engine.js");
    const { MailStateProvider } = await import("@ohmail/app/mail-state");
    const { useMailState } = await import("@ohmail/app-logic/mail-state/mail-state-binding");
    const engine = await bareEngine();

    function Watch(): React.ReactElement {
      handles.push(useMailState().refresh);
      return h("i", null, "x");
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages: messages as never, timeZone: "UTC", now: NOW,
        children: h(EngineProvider as never, {
          demo: false, engine,
          children: h(MailStateProvider as never, { scope: null, probe, mirrored: 0, children: h(Watch) } as never),
        } as never),
      } as never));
    });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
    };
    await settle();
    const afterMount = handles.length;
    expect(afterMount, "no render published a refresh handle, so nothing was measured")
      .toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(FACTS_POLL_MS + 50); });
      await settle();
    }
    // The polls must have REACHED the consumer, or a frozen handle is indistinguishable from a
    // component that never re-rendered.
    expect(handles.length, "the consumer never re-rendered after a poll")
      .toBeGreaterThan(afterMount);

    const distinct = new Set(handles);
    expect(
      distinct.size,
      `refresh took ${distinct.size} identities across ${handles.length} renders`,
    ).toBe(1);
    root.unmount();
  });
});
