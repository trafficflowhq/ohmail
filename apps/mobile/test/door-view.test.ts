/**
 * WHAT A NATIVE VIEW MAY BE ASKED TO BE: one scope's page, or the door's page, which stands while no scope is live.
 * Never both: a page with no scope must not stand over a live scope's keeper. The props' type refuses the pair, and
 * both native halves refuse it when it is set all the same (`why: "door"`).
 *
 * WHERE THIS CASE BITES: only in its `@ts-expect-error` line, under the phone's type program
 * (`npm run typecheck:mobile`, which fails with TS2578 where the pair compiles). Its runtime expectations restate
 * the literals they read and cannot fail. The native refusal is read on a device, a proof owed at the milestone.
 */
import { describe, expect, it } from "vitest";
import type { ShellRefusal, ShellViewProps } from "../src/shell/shell-port";

const events = { onMessage: () => {}, onEpoch: () => {}, onLinkAsk: () => {}, onMailto: () => {}, onRefused: () => {} };
const SCOPE = `p${"0".repeat(32)}`;

describe("what a native view may be asked to be", () => {
  it("is one scope's page or the door's; the door's with a scope does not compile, and native names its refusal", () => {
    const scoped: ShellViewProps = { ...events, scope: SCOPE };
    const waiting: ShellViewProps = { ...events, scope: null };
    const door: ShellViewProps = { ...events, scope: null, door: true };
    // @ts-expect-error the door's page takes no scope
    const both: ShellViewProps = { ...events, scope: SCOPE, door: true };
    expect([scoped.door, waiting.door, door.door]).toEqual([undefined, undefined, true]);
    expect(both.scope).toBe(SCOPE);
    const refusal: ShellRefusal = { why: "door" };
    expect(refusal.why).toBe("door");
  });
});
