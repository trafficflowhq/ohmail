/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  optionsFromFacts, resolveComposeFrom,
} from "../../webapp/app/shell/compose-from";

/**
 * ═══ THE WINDOW NAMES THE MAILBOX IT WILL SEND FROM — on the STANDALONE door too ═══════════
 *
 * The composer's From line is rendered only where the account's mailboxes can be named; with
 * nothing to name it renders nothing, which is the honest answer for a surface that has no
 * mailbox list and for a hosted tab before its first poll. Nothing asserted that this window
 * is neither of those, so "the desktop can never name its sender" was arguable from the source
 * while the window had been handing the list over on both doors all along.
 */

/**
 * Two halves, because the claim has two: the window PASSES the probe on either door, and what
 * the probe answers RESOLVES to an address. The second is driven through the real narrowing
 * over a mocked pipe — `desktop-attach-cap.test.ts`'s harness, for its reasons.
 *
 * MUTATIONS WATCHED RED, restored `cmp`-equal: the probe gated on the cloud door in
 * `DesktopGate` → the door cases (2/7); `address` dropped from the narrowing in
 * `mailbox-facts-wire.ts` → the resolution cases (2/7); the empty answer made to name a guess
 * → the control (1/7).
 */

const MIB = 1024 * 1024;

/* `import.meta.url` is not a `file:` URL under jsdom, so the gate is resolved from the root the
   suite runs in — the fallback pair `desktop-attach-cap.test.ts` uses, for the same reason. */
function gateSource(): string {
  try {
    return readFileSync(resolve(process.cwd(), "apps/desktop/src/DesktopGate.tsx"), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/DesktopGate.tsx"), "utf8");
  }
}
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

describe("the window hands the mailbox list to the shell on BOTH doors", () => {
  const src = stripComments(gateSource());

  it("resolved a real file", () => {
    expect(src).toContain("export function DesktopGate()");
  });

  /**
   * The engine is the only condition. `GET /mailboxes` is served by both doors out of the
   * database on this machine, so a door term here would be the standalone install's composer
   * naming nothing for ever — and the neighbouring props that ARE door-gated show what that
   * would look like in this file (`mode === "cloud"` for the freshness probe).
   */
  it("passes `mailboxFacts` with no door in the condition", () => {
    expect(src.match(/mailboxFacts:\s*readMailboxFacts/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/\{\s*\.\.\.\(engine\s*\?\s*\{\s*mailboxFacts:\s*readMailboxFacts\s*\}/);
  });

  it("…and never behind a door test", () => {
    expect(src).not.toMatch(/mode === "(cloud|local)"[^\n]*mailboxFacts/);
    expect(src).not.toMatch(/mailboxFacts[^\n]*mode === "(cloud|local)"/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   AND WHAT IT HANDS OVER RESOLVES TO AN ADDRESS. The rows below are the shape the standalone
   engine answers with: its own roster, ordered by `createdAt` then id, carrying the organizer
   columns and no announced SMTP ceiling. The chain is the shipped one — the window's narrowing,
   then the shared rule the composer and the reply head both read.
   ───────────────────────────────────────────────────────────────────────────────────────── */

let wireItems: unknown[] = [];

const wireAnswer = (): Response =>
  new Response(JSON.stringify({ items: wireItems }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/* THE WHOLE MODULE, then the overrides: a factory that names its exports leaves every other one
   `undefined`, and the failure then reads as a mock error three frames down rather than as the
   assertion under test. `readMailboxFacts` takes the retrying read; both arms serve one body. */
vi.mock("../src/bridge-fetch.js", async () => {
  const real = await vi.importActual<typeof import("../src/bridge-fetch.js")>(
    "../src/bridge-fetch.js",
  );
  return { ...real, bridgeFetch: async () => wireAnswer(), retryingBridgeFetch: async () => wireAnswer() };
});

/** One roster row as the standalone engine serves it. */
const rosterRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "mbx-1",
  address: "one@example.test",
  status: "connected",
  organizerRole: "organizer",
  organizeConsentedAt: "2026-08-01T08:05:00.000Z",
  lastSyncAt: "2026-08-10T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
  ...over,
});

async function resolveFromTheWire(): Promise<ReturnType<typeof resolveComposeFrom>> {
  const { readMailboxFacts } = await import("../src/local-mailbox-facts.js");
  return resolveComposeFrom(optionsFromFacts(await readMailboxFacts()), null);
}

describe("the standalone roster resolves to a sender", () => {
  it("one mailbox: the composer names that address, with nothing to choose", async () => {
    wireItems = [rosterRow()];
    const from = await resolveFromTheWire();
    expect(from.address, "the standalone composer could name no address").toBe("one@example.test");
    expect(from.mailboxId).toBe("mbx-1");
    expect(from.choices, "a one-option selector is a choice nobody has").toHaveLength(1);
  });

  /* The roster's own order is the rule (`identity.ts` reads it `createdAt, id`), and the shared
     default is the oldest CONNECTED row — so the answer must not follow the order the list
     happened to arrive in. Handed newest-first here, which is the order that would hide it. */
  it("two mailboxes: the OLDEST connected one, whatever order the list arrived in", async () => {
    wireItems = [
      rosterRow({ id: "newer", address: "newer@example.test", createdAt: "2026-08-04T08:00:00.000Z" }),
      rosterRow({ id: "older", address: "older@example.test", createdAt: "2026-08-01T08:00:00.000Z" }),
    ];
    const from = await resolveFromTheWire();
    expect(from.mailboxId).toBe("older");
    expect(from.address).toBe("older@example.test");
    expect(from.choices.map((o) => o.id)).toEqual(["older", "newer"]);
  });

  /* The ceiling rides with the address, per mailbox: an install whose server announced one must
     state that number and not the product constant. The narrowing dropped this field once. */
  it("carries the mailbox's own announced ceiling onto the resolution", async () => {
    wireItems = [rosterRow({ smtpMaxSizeBytes: 25 * MIB })];
    expect((await resolveFromTheWire()).maxMessageBytes).toBe(25 * MIB);
  });

  /* THE CONTROL. An install with no mailbox yet — the first launch, before the door is entered —
     must still name nothing: the point of the row is a named sender, not a guessed one. */
  it("names nothing when this install holds no mailbox", async () => {
    wireItems = [];
    const from = await resolveFromTheWire();
    expect(from).toMatchObject({ mailboxId: null, address: null });
  });
});
