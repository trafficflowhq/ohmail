import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_PARAM, isDemoBuild, isDemoRequested } from "../app/demo-mode.js";

/**
 * THE DEMO PROMISE, asserted (the demo-content and testing-bar invariants).
 *
 * `?demo=1` says: fixtures only, zero network, nothing leaves this tab. The failure that
 * matters is not "the demo did not open" — it is "a URL presented as the demo booted the
 * HttpAdapter against a signed-in user's real mailbox". Two real ways that happened:
 *
 *  1. `searchParams.demo === "1"` with `searchParams.demo` typed `string`. Next hands a
 *     REPEATED key an array, so `/?demo=1&demo=0` compared `["1","0"] === "1"` → false →
 *     live client, from a link anyone can write.
 *  2. A prerendered `/`. A server component only sees the query when the page renders per
 *     request; any static prerender bakes `searchParams = {}` into the single emitted HTML
 *     and the runtime `?demo=1` never reaches the gate at all.
 *
 * So the rule is: EVERY value is inspected, ANY of them asking wins, and the client
 * re-derives the same answer from `window.location.search` before the engine is built.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

describe("isDemoRequested — repeated parameters cannot turn the demo off", () => {
  it("THE regression: /?demo=1&demo=0 is a demo, in every order", () => {
    // `?demo=1&demo=0` used to be LIVE. An attacker's extra value must only ever be ignored.
    expect(isDemoRequested({ demo: ["1", "0"] })).toBe(true);
    expect(isDemoRequested({ demo: ["0", "1"] })).toBe(true);
    expect(isDemoRequested("?demo=1&demo=0")).toBe(true);
    expect(isDemoRequested("?demo=0&demo=1")).toBe(true);
    expect(isDemoRequested(new URLSearchParams("demo=0&demo=1"))).toBe(true);
    expect(isDemoRequested("?demo=nonsense&demo=1&x=2")).toBe(true);
  });

  it("the ordinary shapes", () => {
    expect(isDemoRequested({ demo: "1" })).toBe(true);
    expect(isDemoRequested("?demo=1")).toBe(true);
    expect(isDemoRequested("demo=1")).toBe(true);            // no leading `?`
    expect(isDemoRequested("?demo=true")).toBe(true);
    expect(isDemoRequested("?demo=TRUE")).toBe(true);
    expect(isDemoRequested("?demo")).toBe(true);             // a bare `?demo` plainly means yes
    expect(isDemoRequested("?demo=%201%20")).toBe(true);     // encoded whitespace
  });

  it("and the shapes that are NOT a demo request", () => {
    expect(isDemoRequested(undefined)).toBe(false);
    expect(isDemoRequested(null)).toBe(false);
    expect(isDemoRequested("")).toBe(false);
    expect(isDemoRequested("?x=1")).toBe(false);
    expect(isDemoRequested({})).toBe(false);
    expect(isDemoRequested({ demo: "0" })).toBe(false);
    expect(isDemoRequested({ demo: ["0", "false"] })).toBe(false);
    expect(isDemoRequested("?demonstration=1")).toBe(false);  // not a prefix match
    expect(isDemoRequested("?Demo=1")).toBe(false);           // query keys are case-sensitive
  });

  it("the parameter name is the one the gate links to", () => {
    expect(DEMO_PARAM).toBe("demo");
    expect(read("../app/(product)/NoPageRoute.tsx")).toContain(`/?${DEMO_PARAM}=1`);
  });
});

describe("isDemoBuild — NEXT_PUBLIC_DEMO", () => {
  it("1 / true only", () => {
    expect(isDemoBuild({ NEXT_PUBLIC_DEMO: "1" })).toBe(true);
    expect(isDemoBuild({ NEXT_PUBLIC_DEMO: "true" })).toBe(true);
    expect(isDemoBuild({ NEXT_PUBLIC_DEMO: "0" })).toBe(false);
    expect(isDemoBuild({})).toBe(false);
  });
});

/**
 * The direction of the client's re-derivation is the whole safety property, and it is not
 * expressible as a call: `resolveDemo` lives inside a `"use client"` module that pulls in
 * React and the engine. So it is pinned structurally — a change that lets the URL turn the
 * demo OFF (downgrading a `NEXT_PUBLIC_DEMO` build to the network engine) has to edit these
 * exact lines.
 */
describe("the client may turn the demo ON, never OFF", () => {
  const src = read("../app/shell/engine.tsx");

  it("resolveDemo short-circuits on the server's answer before reading the URL", () => {
    expect(src).toMatch(/function resolveDemo\(serverDemo: boolean\): boolean \{\s*\n\s*if \(serverDemo\) return true;/);
  });

  it("the DEMO engine is built from the RESOLVED mode, in the first-render initializer", () => {
    // Not in an effect: an effect runs after the first commit, and `EngineProvider`'s start
    // effect would already have fired a request from the live engine by then.
    expect(src).toMatch(/useState<Binding>\(\(\) => \{/);
    expect(src).toMatch(/const demo = resolveDemo\(serverDemo\);/);
    // THE DEMO IS DECIDED AND RETURNED FIRST. It is checked before anything else in the
    // initializer and it returns, so no cookie, no remembered account and no later branch can
    // reach past it and hand a `?demo=1` page an HttpAdapter.
    expect(src).toMatch(/if \(demo\) return \{ status: "ready", demo, engine: createEngine\(demo\) \};/);
  });

  /**
   * THE LIVE ENGINE IS BUILT THERE NOW, AND ONLY FROM AN ID THE SERVER ONCE ISSUED.
   *
   * This test used to assert the opposite, and the old sentence was right about its reason and
   * wrong about what follows from it. The reason is unchanged: a live engine persists into
   * IndexedDB, a persistent mirror has to be named for the account it holds, and the name has
   * to be one the server issued — `packages/client-engine/test/idb-owner.test.ts` is the leak
   * that made it necessary. What changed is where the id can come from. The API now writes it
   * into a readable cookie beside the session, so the browser HAS a server-issued id before it
   * asks anything, and the round trip in front of the first paint bought nothing.
   *
   * What must not soften is the CONFIRMATION. The cookie decides which mirror to open; the
   * session check still decides whether this tab may keep it, and it is a comparison rather
   * than a presence test. `warm-open.test.tsx` drives all of that behaviourally, against a real
   * provider — these are the structural pins on the lines that could quietly remove it.
   *
   * ── THE WARM OPEN MOVED ONE RENDER LATER, AND THE GATES DID NOT MOVE WITH IT ────────────
   *
   * It used to be the last branch of the initializer above. The server cannot read that cookie,
   * so a browser that had one produced a hydration render with the whole mail client in it
   * against a server render of the session gate — a mismatch at every level, which React
   * answers by discarding the server's markup and re-rendering the root. It now happens on the
   * render after hydration, which is a layout-effect flip and therefore still the first frame
   * anybody sees. The three conditions are the same three; only the render they are read in
   * changed.
   */
  it("the LIVE engine is built ONLY from a remembered id AND a confirmable session", () => {
    expect(src).toMatch(/\{ status: "resolving" \}/);
    // Both gates on the optimistic branch. Dropping the resolver check would let a client that
    // cannot ask open a mailbox on a cookie alone — and the third gate is what keeps the whole
    // decision off the hydration render.
    expect(src).toMatch(
      /if \(browserPass && binding\.status === "resolving" && !desired && !provided && resolveOwner\) \{/,
    );
    expect(src).toMatch(/const remembered = readOwner\(\);/);
    expect(src).toMatch(/if \(remembered !== null\) \{/);
    // The confirmation still runs, and it still covers the un-remembered path — and it now
    // also drives the retry ladder, so `checking` has to be in the same guard. All three
    // named, so dropping any one of them is red rather than merely slower.
    expect(src).toMatch(
      /if \(binding\.status !== "resolving" && binding\.status !== "warm" && binding\.status !== "checking"\) return;/,
    );
    // The cold path builds the engine into a local first, so that its sync gate can be opened
    // for the account the server just named BEFORE the binding changes — see
    // `confirmSyncOwner`. The claim is unchanged: a live engine is only ever constructed from
    // a server-named owner.
    expect(src).toMatch(/createEngine\(false, undefined, owner\)/);
    /*
     * THE ORDER, NOT THE ADJACENCY — and the difference is why this was rewritten.
     *
     * The property is that the cold engine's gate is opened BEFORE the binding changes, so the
     * scheduler's first tick after the transition sees an open gate rather than racing it. The
     * assertion matched the two calls as neighbouring LINES, which made an ordinary insertion
     * between them (`onConfirmed`, which must also run after the gate opens) look like the gate
     * having been dropped. A guard that fires on a correct edit teaches people to edit the guard.
     *
     * So: both calls exist in the cold arm, and `confirmSyncOwner` comes first, with nothing
     * between them that could publish a binding.
     */
    const cold = src.slice(src.indexOf("const built = createEngine(false, undefined, owner);"));
    const arm = cold.slice(0, cold.indexOf("\n      })"));
    const opensAt = arm.indexOf("confirmSyncOwner(built, owner);");
    const bindsAt = arm.indexOf('setBinding({ status: "ready"');
    expect(opensAt, "the cold-built engine is bound without opening its gate").toBeGreaterThan(-1);
    expect(bindsAt, "the cold arm stopped publishing a ready binding").toBeGreaterThan(-1);
    expect(opensAt, "the binding is published before the gate is opened — the first tick races it")
      .toBeLessThan(bindsAt);
    expect(arm.slice(opensAt, bindsAt), "something publishes a binding between the two")
      .not.toMatch(/setBinding\(/);
    // …and it is a COMPARISON. A presence test here would hand a tab painting one account's
    // mail to whatever session the browser happens to hold.
    expect(src).toMatch(/owner === warm\.owner/);
    // A live engine may never be constructed from anything but a named owner.
    expect(src).not.toMatch(/createEngine\(false\)/);
  });

  it("SECURITY is withheld from the demo, like every other ceremony pane", () => {
    // Settings -> Security is nothing but step-up calls against `auth`: regenerate recovery
    // codes, enrol or remove TOTP. `?demo=1` has no session and no account, so offering the
    // pane there would render controls that 401 on click -- the same defect that put an
    // "erase my account" button in front of the fixture world before `accountSection` was
    // gated. The gate is a ternary at the SettingsView call site in AppShell, so read THAT
    // file: the first version of this test asserted against `engine.tsx`, where the string
    // can never appear, and so could only ever have failed.
    const shell = read("../app/shell/AppShell.tsx");
    expect(shell).toMatch(/securitySection=\{demo \? undefined : securitySection\}/);
    // Every ceremony pane is gated the same way; none may be handed over unguarded.
    expect(shell).not.toMatch(/\n\s*securitySection=\{securitySection\}\s*\n\s*accountSection=/);
  });

  it("a mode change after mount REPLACES the engine", () => {
    // Capturing the mode once was how a live→demo navigation kept the network engine.
    expect(src).toMatch(/if \(binding\.status === "ready" \? desired === binding\.demo : !desired\) return;/);
    expect(src).toMatch(/desired \? \{ status: "ready", demo: true, engine: createEngine\(true\) \} : \{ status: "resolving" \}/);
  });

  it("the chrome reads the engine's mode, not the server's prop", () => {
    // The ribbon and the frozen demo clock must never disagree with the adapter the data
    // is coming from.
    const shell = read("../app/shell/AppShell.tsx");
    expect(shell).toMatch(/const demo = useDemoMode\(\);/);
    expect(shell).not.toMatch(/function ShellInner\(\{ demo \}/);
  });
});
