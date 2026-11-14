/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ A DIFFERENT ENGINE IS A DIFFERENT MAILBOX, AND THE FACTS DIE WITH IT ════════════════════
 *
 * `MailStateProvider` polls `GET /mailboxes` every thirty seconds and publishes the answer to
 * every surface that needs to know what this account HAS: the strip's ladder, the compose From
 * selector, the reply's From line, and the Mailboxes pane's holdings sentence.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────
 *
 * The held answer outlived the engine that produced it. The provider already withdrew its
 * FRESHNESS verdict on an engine change — "a stale Cloud verdict surviving onto another engine
 * would label content it was never about" — and did not withdraw the facts on the same rule. On
 * the desktop that gap is wide rather than theoretical: the probe there is a MODULE FUNCTION
 * (`readMailboxFacts`), so its identity does not change when the engine does, the re-read effect
 * is keyed on that identity and does not even re-run, and the previous account's rows stand until
 * the next poll — up to `FACTS_POLL_MS`.
 *
 * What that window renders, on a Cloud → Cloud account switch:
 *
 *  · the Mailboxes pane pairs the NEW mirror's message count with the OLD account's
 *    `hostedMessageCount`, so "this computer holds N of your M messages" quotes somebody else's
 *    mailbox as the denominator (review finding, round 3);
 *  · `compose-from` offers sending addresses the new session does not have — the same rows it is
 *    documented to render nothing for when the facts are `null`.
 *
 * `null` is not a degradation here. It is this field's documented meaning — "we cannot see
 * mailboxes", never "there are none" — and every consumer already renders it as silence rather
 * than as a guess. A brief silence is the honest answer to a question that has just changed.
 *
 * ── WATCHED RED ──────────────────────────────────────────────────────────────────────────────
 *
 * Delete `setFacts(null)` from the engine-adoption effect in `MailStateProvider.tsx` and the
 * HANGING case fails with the first account's address still on screen under the second engine.
 * Delete the `void read()` beside it and the last case fails: the pane stays silent for a whole
 * poll interval. The first case cannot separate them and does not try to — it pins the outcome.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** An adapter that answers nothing. The engine is an IDENTITY here, not a data source. */
const inertAdapter = (): EngineAdapter =>
  ({
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "AA",
      hasMore: false,
      serverTime: new Date().toISOString(),
    }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  }) as unknown as EngineAdapter;

const mailbox = (address: string): MailboxFacts => ({
  id: `mbx-${address}`,
  address,
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: "2026-08-30T09:00:00.000Z",
  hostedMessageCount: 60_000,
  createdAt: "2026-08-01T08:00:00.000Z",
});

/**
 * THE PROBE IS ONE STABLE FUNCTION for the life of the test, which is the desktop's own shape and
 * the whole reason the defect existed: a probe whose identity changed with the engine would make
 * the re-read effect fire and hide it.
 */
let served: MailboxFacts[] = [mailbox("first@example.test")];
/** Set by the hanging case: the next read never settles, exactly as a dead bridge behaves. */
let hang = false;
/** Set by the LATE case: each read is parked here for the test to resolve when it chooses. */
let park: ((rows: MailboxFacts[]) => void) | null = null;
const probe = async (): Promise<MailboxFacts[]> => {
  if (hang) return new Promise<MailboxFacts[]>(() => {});
  if (park !== null) {
    return new Promise<MailboxFacts[]>((resolve) => { park = resolve; });
  }
  return served;
};

/**
 * EVERY frame this consumer was rendered with, TAGGED WITH THE ENGINE IT SAW.
 *
 * The pairing is the claim: not "the old rows went away eventually" but "no frame ever showed the
 * old rows under the new engine". Slicing by index cannot say that — a render can land between
 * two statements of the test — and the engine each frame carried can.
 */
const seen: string[] = [];
const engines: unknown[] = [];
const tag = (e: unknown): string => {
  if (!engines.includes(e)) engines.push(e);
  return `engine${engines.indexOf(e)}`;
};

/** What a surface sees when it asks the provider what this account has. */
function FactsProbe(): React.ReactElement {
  const { useMailState } = hooks;
  const { mailboxes } = useMailState();
  const shown = mailboxes === null ? "«cannot see»" : mailboxes.map((m) => m.address).join(", ");
  seen.push(`${tag(engineHook())}|${shown}`);
  return h("div", { "data-testid": "facts" }, shown);
}
let engineHook: () => unknown;
let hooks: typeof import("../app/shell/MailStateProvider");

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
  served = [mailbox("first@example.test")];
  hang = false;
  park = null;
  strict = false;
  seen.length = 0;
  engines.length = 0;
});

/** A SECOND freshness probe object — a door change that leaves the engine alone. */
const freshA = async () => ({ state: "current" as const, asOf: "2026-08-30T09:00:00.000Z" });
const freshB = async () => ({ state: "current" as const, asOf: "2026-08-30T09:00:00.000Z" });

/** Set by the StrictMode case: React mounts every effect, tears it down, and mounts it again. */
let strict = false;

async function mount(
  engine: OhmailEngine,
  freshnessProbe?: typeof freshA,
): Promise<{
  el: HTMLElement;
  swap: (e: OhmailEngine, f?: typeof freshA) => Promise<void>;
}> {
  const engineModule = await import("../app/shell/engine");
  const { EngineProvider } = engineModule;
  engineHook = engineModule.useEngine;
  hooks = await import("../app/shell/MailStateProvider");
  const { MailStateProvider } = hooks;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (e: OhmailEngine, f?: typeof freshA) =>
    root.render(
      h(strict ? React.StrictMode : React.Fragment, null, h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(EngineProvider, {
          demo: false,
          engine: e,
          children: h(MailStateProvider, {
            probe,
            ...(f ? { freshnessProbe: f } : {}),
            mirrored: 4_200,
            children: h(FactsProbe, null),
          }),
        }),
      })),
    );
  await act(async () => { render(engine, freshnessProbe); });
  return {
    el: container,
    swap: async (e, f) => { await act(async () => { render(e, f); }); },
  };
}

const text = (el: HTMLElement) => el.querySelector('[data-testid="facts"]')?.textContent ?? "";

describe("the mailbox facts are withdrawn with the engine that produced them", () => {
  it("a swapped engine puts the pane back to «cannot see», not to the previous account's rows", async () => {
    const first = new OhmailEngine({ adapter: inertAdapter() });
    const { el, swap } = await mount(first);
    expect(text(el), "the first account's facts never arrived").toContain("first@example.test");

    // The switch. The probe is the same function object — the desktop's shape — so nothing else
    // in the provider re-runs on its own.
    served = [mailbox("second@example.test")];
    await swap(new OhmailEngine({ adapter: inertAdapter() }));

    expect(
      text(el),
      "the previous account's mailbox rows survived onto a different engine",
    ).not.toContain("first@example.test");
  });

  it("THE CLEAR IS THE LOAD-BEARING HALF: a re-read that never answers leaves «cannot see»", async () => {
    /* The re-read alone is not the fix, and this is the case that separates them. `read()` KEEPS
       THE LAST ANSWER on failure, by design — "if we DID see mailboxes a moment ago, the last
       thing we knew is a better answer than a fabricated empty account" — which is right within
       one mirror's life and exactly wrong across a switch. With a bridge that hangs (a sidecar
       mid-restart, a dead pipe) the only thing standing between the new engine and the previous
       account's rows is the clear. Watched red by deleting `setFacts(null)`. */
    const { el, swap } = await mount(new OhmailEngine({ adapter: inertAdapter() }));
    expect(text(el)).toContain("first@example.test");
    hang = true;
    await swap(new OhmailEngine({ adapter: inertAdapter() }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(text(el), "a hung re-read left the previous account on screen").toBe("«cannot see»");
  });

  it("A LATE ANSWER FROM THE ENGINE THAT ASKED IT IS DROPPED, not published over the clear", async () => {
    /* Review finding, round 4, and the one the clear alone does not cover. A request issued
       against engine A resolves whenever the network says so; `alive.current` only asks whether
       the component is still mounted. Without a generation guard the previous account's rows land
       straight back on top of the clear and look exactly like a correct poll. */
    park = () => {};                       // the first read parks
    const { el, swap } = await mount(new OhmailEngine({ adapter: inertAdapter() }));
    const resolveFirst = park!;
    expect(text(el), "the parked read should not have answered yet").toBe("«cannot see»");

    park = () => {};                       // the adoption's own read parks too
    await swap(new OhmailEngine({ adapter: inertAdapter() }));

    // Engine A's answer, arriving after engine B is on screen.
    await act(async () => {
      resolveFirst([mailbox("first@example.test")]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(text(el), "a dead engine's answer was published over the live one").toBe("«cannot see»");
  });

  it("NO FRAME EVER CARRIES THE OLD ACCOUNT UNDER THE NEW ENGINE — the clear is during render", async () => {
    /* A passive effect runs AFTER the commit, so the clear-in-an-effect leaves exactly one painted
       frame pairing the previous account's rows with the new mirror. One frame is enough to render
       a sentence quoting somebody else's message total. This walks every render the consumer was
       given and asserts the first account disappears at the switch rather than one frame later. */
    const first = new OhmailEngine({ adapter: inertAdapter() });
    const { el, swap } = await mount(first);
    expect(text(el)).toContain("first@example.test");

    served = [mailbox("second@example.test")];
    const second = new OhmailEngine({ adapter: inertAdapter() });
    await swap(second);

    expect(seen.some((f) => f.startsWith(`${tag(second)}|`)), "the swap rendered nothing at all")
      .toBe(true);
    expect(
      seen.filter((f) => f === `${tag(second)}|first@example.test`),
      "a committed frame paired the previous account's rows with the new engine",
    ).toEqual([]);
    // And the first engine's own frames are untouched — this is a pairing rule, not a ban.
    expect(seen).toContain(`${tag(first)}|first@example.test`);
  });

  it("A DOOR CHANGE WITHOUT AN ENGINE CHANGE COUNTS TOO — the identity is all three", async () => {
    /* Review finding, round 5. The freshness probe can change while the engine does not — a
       Cloud → local door switch drops it, and the window's engine is replaced separately — so an
       identity keyed on the engine alone would leave the previous door's rows standing and let its
       late answers repopulate them. `identity` is engine + probe + freshnessProbe for that reason;
       this drives the middle case, where ONLY the freshness probe is swapped. */
    const engine = new OhmailEngine({ adapter: inertAdapter() });
    const { el, swap } = await mount(engine, freshA);
    expect(text(el)).toContain("first@example.test");

    hang = true;                             // the re-ask never answers, so only the clear shows
    await swap(engine, freshB);              // SAME engine, different door
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(text(el), "a door change left the previous door's mailbox rows on screen").toBe("«cannot see»");
  });

  it("UNDER StrictMode THE ANSWERS STILL ARRIVE — the mounted flag is restored on setup", async () => {
    /* Review finding, round 6, and a defect this file's own subject depends on. The mounted flag
       used to be a CLEANUP with no setup half. StrictMode mounts every effect, tears it down and
       mounts it again, so a development build ran that cleanup once on a component that was very
       much still there and left the flag false for the rest of the session — after which every
       probe answer was dropped on the way in and the provider never learned anything again.
       Watched red by deleting the `alive.current = true` line. */
    strict = true;
    const { el } = await mount(new OhmailEngine({ adapter: inertAdapter() }));
    expect(text(el), "StrictMode's effect replay left every answer rejected").toContain("first@example.test");
  });

  it("and the new engine's own answer arrives, so the silence is a gap and not a dead end", async () => {
    const { el, swap } = await mount(new OhmailEngine({ adapter: inertAdapter() }));
    served = [mailbox("second@example.test")];
    await swap(new OhmailEngine({ adapter: inertAdapter() }));
    // The adoption effect clears; the read effect the provider already had re-reads. Flush the
    // promise the probe returns and the second account is on screen.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(text(el)).toContain("second@example.test");
  });
});
