/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  composeAttachBudgetFor, composeAttachCap, composeAttachCapBinding,
  COMPOSE_ATTACH_MAX_TOTAL_BYTES, COMPOSE_ATTACH_STAGED_SURFACE_BYTES,
  COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES,
} from "../../webapp/app/components/ComposeAttach";
import type { EngineStatus } from "../src/bridge-fetch.js";
import { CLOUD_URL } from "../src/doors.js";
import {
  DESKTOP_SELFHOST_SEND_MAX_TOTAL_BYTES, DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES, desktopSendSurface,
  stagesAttachments,
} from "../src/desktop-send-surface.js";

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
 * What IS this window's own is the DECLARATION, per door (`desktop-send-surface.ts`): what one
 * send from this window carries, and whether the door stages its bytes to the account's storage.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · make `composeAttachCap` read an unmeasured SIZE as 3 MB again → the 4 MB cases go red;
 *  · declare the standalone door `null` again → the standalone and binding cases go red;
 *  · stage on every cloud door → the self-hosted and paired staging cases go red;
 *  · let the self-hosted door declare nothing again → the self-hosted 32 MiB case goes red;
 *  · raise the window's ceiling past the outbox door's bound → the fit case goes red;
 *  · stop forwarding `smtpMaxSizeBytes` in `readMailboxFacts` → the probe cases go red.
 */

const MIB = 1024 * 1024;

describe("what the declaration buys, in the form's own rule", () => {
  it("the acceptance pair: uncapped surface follows a probed SIZE, and never 'unbounded'", () => {
    // The announcement's budget for RAW bytes, not its face value: `SIZE` bounds the ENCODED
    // message, and attachments are base64 on the way into one. `composeAttachBudgetFor` holds the
    // derivation and is pinned against the send's own copy by the repository's parity suite.
    expect(composeAttachCap(25 * MIB, null)).toBe(composeAttachBudgetFor(25 * MIB));
    expect(composeAttachBudgetFor(25 * MIB)).toBeGreaterThan(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(null, null)).toBe(composeAttachBudgetFor(COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES));
  });

  it("an undeclared surface keeps the strict constant, whatever the mailbox announces", () => {
    expect(composeAttachCap(25 * MIB, undefined)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(25 * MIB)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE WINDOW'S OWN DECLARATION, per door (`desktop-send-surface.ts`), and where the gate hands
   it to the shared shell. Every send's attachments cross the bridge as base64 inside the queued
   change the window records before anything leaves this computer, so the window has a ceiling of
   its own on every door; the hosted door also stages its bytes to storage.
   ───────────────────────────────────────────────────────────────────────────────────────── */

const local = { state: "serving", mode: "local" } as EngineStatus;
const managed = { state: "serving", mode: "cloud", cloudUrl: CLOUD_URL } as EngineStatus;
const selfhost = { state: "serving", mode: "cloud", cloudUrl: "https://mail.example.org" } as EngineStatus;
const paired = { state: "serving", mode: "cloud", flavor: "desktop-host", cloudUrl: "https://10.0.0.2:4848" } as EngineStatus;

describe("each door declares what one send from this window carries", () => {
  it("the standalone door: the window's own ceiling, never uncapped", () => {
    expect(desktopSendSurface(local)).toBe(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES);
  });

  it("the hosted door: the window's ceiling or the staging bound, whichever is smaller", () => {
    expect(desktopSendSurface(managed))
      .toBe(Math.min(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES, COMPOSE_ATTACH_STAGED_SURFACE_BYTES));
  });

  it("the self-hosted door: the server's own 32 MiB, not the Cloud web's 3 MB inline cap", () => {
    // Every self-hosted server takes 32 MiB of attachments inline (`SELF_HOST_SEND_MAX_TOTAL_BYTES`).
    expect(desktopSendSurface(selfhost)).toBe(DESKTOP_SELFHOST_SEND_MAX_TOTAL_BYTES);
    expect(DESKTOP_SELFHOST_SEND_MAX_TOTAL_BYTES).toBe(32 * MIB);
    expect(composeAttachCap(70 * MIB, desktopSendSurface(selfhost))).toBe(32 * MIB);
    expect(composeAttachCapBinding(70 * MIB, desktopSendSurface(selfhost))).toBe("surface");
    expect(composeAttachCap(25 * MIB, desktopSendSurface(selfhost))).toBe(composeAttachBudgetFor(25 * MIB));
    expect(composeAttachCap(25 * MIB, desktopSendSurface(selfhost))).toBeGreaterThan(4 * MIB);
  });

  it("the paired door and an unknown one declare nothing: the strict inline constant, as before", () => {
    expect(desktopSendSurface(paired)).toBeUndefined();
    expect(desktopSendSurface(null)).toBeUndefined();
    expect(composeAttachCap(25 * MIB, desktopSendSurface(paired))).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("only the hosted door stages to the account's storage", () => {
    expect(stagesAttachments(managed)).toBe(true);
    expect(stagesAttachments(local)).toBe(false);
    expect(stagesAttachments(selfhost)).toBe(false);
    expect(stagesAttachments(paired)).toBe(false);
    expect(stagesAttachments(null)).toBe(false);
  });

  it("the reported refusal: a 4 MB file fits on the standalone door, unprobed or announced", () => {
    expect(composeAttachCap(null, desktopSendSurface(local))).toBeGreaterThan(4 * MIB);
    expect(composeAttachCap(25 * MIB, desktopSendSurface(local))).toBeGreaterThan(4 * MIB);
  });

  it("…and on the hosted door, where it used to read 3 MB", () => {
    expect(composeAttachCap(25 * MIB, desktopSendSurface(managed))).toBeGreaterThan(4 * MIB);
    expect(composeAttachCap(25 * MIB, undefined)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("a large announcement binds at the window's ceiling, and the form says why", () => {
    // A 70 MiB SIZE budgets 51 MiB of files, more than one send from this window carries.
    expect(composeAttachCap(70 * MIB, desktopSendSurface(local))).toBe(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES);
    expect(composeAttachCapBinding(70 * MIB, desktopSendSurface(local))).toBe("surface");
    // Gmail's SIZE (26 MiB of files) is the mail server's own limit here, under the window's.
    expect(composeAttachCapBinding(35_882_577, desktopSendSurface(local))).toBe("mailbox");
  });

  it("the hosted door states the browser's number for every mailbox", () => {
    for (const announced of [null, 10 * MIB, 25 * MIB, 35_882_577, 57 * MIB, 70 * MIB]) {
      expect(composeAttachCap(announced, desktopSendSurface(managed)))
        .toBe(composeAttachCap(announced, COMPOSE_ATTACH_STAGED_SURFACE_BYTES));
    }
  });
});

/* WHY 40 MiB: the window records each send's change through the engine's outbox door before it
   publishes it, attachments as base64, and that door refuses a write over its bound. Read from
   the engine's source so the two cannot drift apart. */
function sidecarOutboxBound(): number {
  let src: string;
  try {
    src = readFileSync(resolve(process.cwd(), "apps/sidecar/src/window-outbox.ts"), "utf8");
  } catch {
    return Number.NaN;
  }
  const m = src.match(/const WINDOW_OUTBOX_MAX_BODY_BYTES = (\d+) \* 1024 \* 1024;/);
  return m ? Number(m[1]) * MIB : Number.NaN;
}

describe("the window's ceiling fits the one write a send takes", () => {
  it("40 MiB of files, base64, plus a megabyte of message, is under the outbox door's bound", () => {
    const bound = sidecarOutboxBound();
    // The client-half publish carries no engine source; the bound is then unread, not green.
    if (Number.isNaN(bound)) return;
    const base64 = Math.ceil(DESKTOP_WINDOW_SEND_MAX_TOTAL_BYTES / 3) * 4;
    expect(base64 + MIB).toBeLessThan(bound);
  });
});

/* The gate hands the declaration over and builds the engine with the staging decision — from
   source, comments stripped: what regressed in this family before is a property missing from a
   literal, and a guard a comment can satisfy is worth nothing. */
function gateSource(): string {
  try {
    return readFileSync(resolve(process.cwd(), "apps/desktop/src/DesktopGate.tsx"), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/DesktopGate.tsx"), "utf8");
  }
}
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

describe("the gate passes each door's declaration and staging decision", () => {
  const src = stripComments(gateSource());

  it("resolved a real file", () => {
    expect(src).toContain("export function DesktopGate()");
  });

  it("declares `sendSurfaceMaxTotalBytes` once, from the door", () => {
    expect(src.match(/sendSurfaceMaxTotalBytes/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/sendSurfaceMaxTotalBytes:\s*desktopSendSurface\(status\)/);
    expect(src).not.toMatch(/sendSurfaceMaxTotalBytes:\s*null/);
  });

  it("builds the window's engine with the door's staging decision", () => {
    expect(src).toMatch(/createLocalEngine\(mount\.key, \{ stageAttachments: stage \}\)/);
    expect(src).toMatch(/const stage = stagesAttachments\(/);
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

/* BOTH READS, because `readMailboxFacts` takes the retrying one. A partial mock of this module
   leaves the export `undefined` and the three cases below fail with a mock error rather than an
   assertion — which says nothing about the SIZE they are here to measure. The wrapper is
   transparent for the one answer this file produces, so both arms serve the same body. */
const wireAnswer = (): Response =>
  new Response(JSON.stringify({ items: wireItems }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

vi.mock("../src/bridge-fetch.js", async () => {
  /* THE WHOLE MODULE, then the overrides. A factory that NAMES its exports leaves every
     other one `undefined`, so the day a consumer here starts importing one the rig fails as
     a TypeError three frames down instead of as the assertion under test. Spreading
     `importActual` cannot half-apply. */
  const real = await vi.importActual<typeof import("../src/bridge-fetch.js")>(
    "../src/bridge-fetch.js",
  );
  return {
    ...real,
    bridgeFetch: async () => wireAnswer(),
    retryingBridgeFetch: async () => wireAnswer(),
  };
});

const WIRE_ROW = {
  id: "mbx-1",
  address: "someone@example.test",
  status: "connected",
  lastSyncAt: "2026-08-10T09:00:00.000Z",
  createdAt: "2026-08-01T08:00:00.000Z",
};

describe("readMailboxFacts forwards the announced SIZE", () => {
  it("a probed value arrives as itself", async () => {
    const { readMailboxFacts } = await import("../src/local-mailbox-facts.js");
    wireItems = [{ ...WIRE_ROW, smtpMaxSizeBytes: 25 * MIB }];
    const [fact] = await readMailboxFacts();
    expect(fact!.smtpMaxSizeBytes).toBe(25 * MIB);
  });

  it("`null` (no announcement) arrives as null, and the cap is the assumed provider SIZE", async () => {
    const { readMailboxFacts } = await import("../src/local-mailbox-facts.js");
    wireItems = [{ ...WIRE_ROW, smtpMaxSizeBytes: null }];
    const [fact] = await readMailboxFacts();
    expect(fact!.smtpMaxSizeBytes).toBeNull();
    expect(composeAttachCap(fact!.smtpMaxSizeBytes, desktopSendSurface(local)))
      .toBe(composeAttachBudgetFor(COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES));
  });

  it("an ABSENT field (an engine that predates the column) stays absent, not null", async () => {
    const { readMailboxFacts } = await import("../src/local-mailbox-facts.js");
    wireItems = [{ ...WIRE_ROW }];
    const [fact] = await readMailboxFacts();
    expect("smtpMaxSizeBytes" in fact!).toBe(false);
  });
});
