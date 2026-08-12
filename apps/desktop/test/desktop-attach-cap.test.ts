/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  composeAttachCap,
  COMPOSE_ATTACH_MAX_TOTAL_BYTES,
} from "../../webapp/app/components/ComposeAttach";

/**
 * ═══ THE WINDOW'S HALF OF "THE FORM'S PROMISE AND THE SEND'S REFUSAL ARE ONE RULE" ═════════
 *
 * `composeAttachCap` is what the compose surface states and admits against, and the invariant
 * it mirrors is stated at `ComposeAttach`'s render site: a number stated that the send would
 * refuse is a claim the product cannot keep, and a refusal below the promise wastes a composed
 * message. The value-for-value comparison against the send's own rule lives in the repository's
 * parity suite (`compose-attach-cap-parity.test.ts`), NOT here — this file ships with the
 * desktop tests in both publish variants, and the send rule's package is in neither's client
 * half, so an import of it from here is one the published tree could not compile.
 *
 * What IS this window's own is the DECLARATION: the standalone door runs the send in the same
 * process as the SMTP dial (the mail engine declares `sendSurfaceMaxTotalBytes: null` on its
 * service bag, asserted from source by the engine's own suite), and this window makes the SAME
 * declaration to the shared shell. Both halves are asserted here from source, the engine
 * guard's own method, because what regressed in this family before is a property missing from
 * a literal.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · make `composeAttachCap` read a `null` surface as "not declared" → the acceptance pair
 *    below goes red (and the parity suite's matrix with it);
 *  · make it read an unmeasured SIZE as "unbounded" under a null surface → red the same way;
 *  · drop the local-door guard in `DesktopGate` (declare both doors uncapped) → the door guard
 *    goes red — the CLOUD door forwards `POST /drafts/:id/send` verbatim to the hosted API
 *    (the engine's `cloud-proxy.ts`), so an uncapped promise there is one the forwarded
 *    send must refuse;
 *  · declare a number instead of `null` → the no-number guard goes red;
 *  · stop forwarding `smtpMaxSizeBytes` in `readMailboxFacts` → the probe cases go red, which
 *    is the wire this slice had to add: the engine has announced the value all along
 *    (`mailbox-service.ts`, mail 0055) and the desktop's probe simply dropped it.
 */

const MIB = 1024 * 1024;

describe("what the declaration buys, in the form's own rule", () => {
  it("the acceptance pair: uncapped surface follows a probed SIZE, and never 'unbounded'", () => {
    expect(composeAttachCap(25 * MIB, null)).toBe(25 * MIB);
    expect(25 * MIB).toBeGreaterThan(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(null, null)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("an undeclared surface keeps the strict constant, whatever the mailbox announces", () => {
    expect(composeAttachCap(25 * MIB, undefined)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(25 * MIB)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE WINDOW'S OWN DECLARATION — from source, the sidecar guard's own method and reasons.
   `DesktopGate` is JSX glue around an engine, a shell channel and a menu; observing one prop
   of one spread would take an engine's worth of setup, and the regression this family has
   already had is a property missing from a literal. Comments are stripped first — the prose
   here quotes the code it describes, and a guard a comment can satisfy is worth nothing.
   ───────────────────────────────────────────────────────────────────────────────────────── */

/* `import.meta.url` is not a `file:` URL under the jsdom environment, so the gate's source is
   resolved from the repo root the suite runs in — the same fallback pair `compose-cancel.
   test.tsx` uses for the identical reason. */
function gateSource(): string {
  try {
    return readFileSync(resolve(process.cwd(), "apps/desktop/src/DesktopGate.tsx"), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/DesktopGate.tsx"), "utf8");
  }
}
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

describe("the desktop window declares the surface uncapped on the LOCAL door only", () => {
  const src = stripComments(gateSource());

  it("resolved a real file", () => {
    expect(src).toContain("export function DesktopGate()");
  });

  it("declares `sendSurfaceMaxTotalBytes: null`, exactly once", () => {
    expect(src.match(/sendSurfaceMaxTotalBytes/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/sendSurfaceMaxTotalBytes:\s*null/);
  });

  it("…gated on the local door — the cloud door's sends ride the hosted body limit", () => {
    expect(src).toMatch(/mode === "local"[\s\S]{0,200}?sendSurfaceMaxTotalBytes:\s*null/);
  });

  it("…and never declares a NUMBER, which would re-impose a limit that is not this host's", () => {
    expect(src).not.toMatch(/sendSurfaceMaxTotalBytes:\s*\d/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE OTHER HALF OF THE PROMISE — the probed `SIZE` has to reach the From options at all.
   The engine has served `smtpMaxSizeBytes` on `GET /mailboxes` since mail 0055; the window's
   probe narrows that wire to `MailboxFacts`, and a field the narrowing drops is a ceiling the
   compose surface can never state. Driven through the real `readMailboxFacts` over a mocked
   pipe, the same harness `desktop-mailboxes.test.ts` uses.
   ───────────────────────────────────────────────────────────────────────────────────────── */

let wireItems: unknown[] = [];

vi.mock("../src/bridge-fetch.js", () => ({
  bridgeFetch: async () =>
    new Response(JSON.stringify({ items: wireItems }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

const WIRE_ROW = {
  id: "mbx-1",
  address: "someone@example.test",
  status: "connected",
  lastSyncAt: "2026-08-10T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
};

describe("readMailboxFacts forwards the announced SIZE", () => {
  it("a probed value arrives as itself", async () => {
    const { readMailboxFacts } = await import("../src/DesktopMailboxes.js");
    wireItems = [{ ...WIRE_ROW, smtpMaxSizeBytes: 25 * MIB }];
    const [fact] = await readMailboxFacts();
    expect(fact!.smtpMaxSizeBytes).toBe(25 * MIB);
  });

  it("`null` (no announcement) arrives as null, and the cap then falls back to the constant", async () => {
    const { readMailboxFacts } = await import("../src/DesktopMailboxes.js");
    wireItems = [{ ...WIRE_ROW, smtpMaxSizeBytes: null }];
    const [fact] = await readMailboxFacts();
    expect(fact!.smtpMaxSizeBytes).toBeNull();
    expect(composeAttachCap(fact!.smtpMaxSizeBytes, null)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("an ABSENT field (an engine that predates the column) stays absent, not null", async () => {
    const { readMailboxFacts } = await import("../src/DesktopMailboxes.js");
    wireItems = [{ ...WIRE_ROW }];
    const [fact] = await readMailboxFacts();
    expect("smtpMaxSizeBytes" in fact!).toBe(false);
  });
});
