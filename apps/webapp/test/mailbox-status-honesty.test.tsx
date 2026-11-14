/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import messages from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * "CONNECTED" IS A CLAIM, AND THE ROW WAS MAKING IT BEFORE ANYTHING HAD CONNECTED.
 *
 * `mailboxes.status` DEFAULTS to `'connected'` (`packages/db/src/schema.ts`) and
 * `MailboxService.create` inserts without setting it, so the column says `connected` the
 * instant the row exists — before the worker has resolved the host, before it has offered the
 * password, before a single message. Measured on an iCloud mailbox 2026-08-03:
 * the pane read "iCloud Mail · connected" at 09:57:03, TWENTY-SIX SECONDS before the first
 * message arrived and EIGHT AND A HALF MINUTES before the first completed cycle.
 *
 * The worker states the invariant it thought it was keeping, in `apps/worker/src/index.ts`:
 * the status column "may only say `connected` about one that has actually synced". Nothing
 * enforced it, because nothing else ever writes the column on the way IN.
 *
 * iCloud is where it bites hardest. An app-specific password is mandatory there once 2FA is
 * on, so typing the ordinary Apple ID password is the common mistake — and that account reads
 * "iCloud Mail · connected" until the worker's first attach fails and flips it to `error`.
 *
 * ── WHY NO MIGRATION ────────────────────────────────────────────────────────────────────
 *
 * The enum is `connected|error|disabled` with no third value, so the obvious fix is a fourth.
 * It is the wrong one: the fact is already in the row. `last_sync_at` is NULL until a cycle
 * completes, which is precisely "no cycle has confirmed this mailbox", and it is already on
 * the wire and already read four lines above for the timestamp. A `pending` status would add a
 * migration, a value every consumer of the column must learn, and a second source of truth
 * that can disagree with `last_sync_at` — for a sentence on one row.
 *
 * The derivation is one-directional and that is what makes it honest: it can only ever WEAKEN
 * the claim. A mailbox that has synced says `connected` because a cycle proved it; a mailbox
 * that has not says `connecting`, which is true whether the credentials are good or not.
 */

// `import.meta.url` is not a file URL under the jsdom environment, so paths are resolved from
// the vitest root (the repo root) instead.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, blockedReason: null, mailboxCount: 1,
  // Explicit — see `connect-gate-order.test.tsx`: the cast hides a missing field.
  settled: true,
  owed: false,
} as unknown as MailState;

const listed: MailboxDTO[] = [];

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
  messageOf: (e: unknown) => String(e),
  auth: {
    session: async () => ({
      user: { email: "owner@example.test", emailVerified: true }, scope: "full",
    }),
  },
  // the pane reads the server's entitlement before it offers a connect. A plan with room
  // on it, so the button is offered and this file keeps testing what it was written for.
  billing: {
    subscription: async () => ({
      subscription: {
        plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
        currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
      },
      balance: 0,
      plans: {},
      entitlements: {
        mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true,
        reason: "active",
      },
    }),
  },
  mailboxes: {
    list: async () => ({ items: listed }),
    create: async () => listed[0]!,
    resync: async () => undefined,
  },
}));

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

const mailbox = (over: Partial<MailboxDTO>): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "mila.brunner@lichtgrat.example",
  displayName: null, status: "connected", lastSyncAt: null, ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

/** Mount the real pane over a one-mailbox list and return the sub-line it renders. */
async function subLine(m: MailboxDTO): Promise<string> {
  await unmount();
  listed.splice(0, listed.length, m);
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
  });
  // The list arrives from an effect; let the microtasks settle.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host.querySelector(".mbx-sub")?.textContent ?? "";
}

afterEach(async () => { await unmount(); });

describe("Settings → Mailboxes says `connected` only about a mailbox that has synced", () => {
  it("THE REGRESSION: a never-synced mailbox does not read `connected`", async () => {
    const text = await subLine(mailbox({ status: "connected", lastSyncAt: null }));
    expect(text).toContain("iCloud Mail");
    expect(text, "the row asserted a connection nothing has confirmed").not.toMatch(/connected/i);
    expect(text).toContain(messages.mailboxes.status_connecting);
  });

  it("a mailbox that HAS synced reads `connected` — the claim is earned, not removed", async () => {
    const text = await subLine(mailbox({ status: "connected", lastSyncAt: "2026-08-03T10:05:33.000Z" }));
    expect(text).toContain(messages.mailboxes.status_connected);
  });

  it("`error` and `disabled` are untouched by the derivation", async () => {
    expect(await subLine(mailbox({ status: "error", lastSyncAt: null })))
      .toContain(messages.mailboxes.status_error);
    expect(await subLine(mailbox({ status: "disabled", lastSyncAt: null })))
      .toContain(messages.mailboxes.status_disabled);
  });

  it("the wording the never-synced row shows on its RIGHT does not claim it either", async () => {
    // `syncFirstPending` read "No mail yet — connected {when}" and `{when}` is `createdAt`.
    // Same unverified claim, same row, four words to the right of the one just fixed.
    expect(messages.mailboxes.syncFirstPending).not.toMatch(/connected/i);
    const text = await subLine(mailbox({ status: "connected", lastSyncAt: null }));
    expect(host!.textContent ?? "").not.toMatch(/connected/i);
    expect(text).toBeTruthy();
  });
});

describe("the derivation is a display rule, not a schema change", () => {
  it("no fourth status value was added to the column", () => {
    /* `schema.ts` became a BARREL when the mail and cloud halves were split, so reading it
       for a column declaration returned "" and this assertion passed over nothing — the
       empty-slice shape that has made a guard here vacuous before. It reads the file that
       actually declares `mailboxes` now, and asserts the slice is non-empty first so the
       same silence fails instead of passing. */
    const schema = read("packages/db/src/schema-mail.ts");
    const at = schema.indexOf('status: text("status")');
    expect(at, "the mailboxes status column moved — find it and re-point this guard")
      .toBeGreaterThan(-1);
    const decl = schema.slice(at);
    expect(decl.slice(0, decl.indexOf("\n"))).toMatch(/connected\|error\|disabled/);
  });

  it("the row's rule is exactly `connected` + never synced", () => {
    const src = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");
    expect(src).toMatch(/lastSyncAt === null \? "status_connecting"/);
  });

  it("every status label the row can ask for exists", () => {
    for (const s of ["connected", "connecting", "error", "disabled"]) {
      expect(messages.mailboxes[`status_${s}` as keyof typeof messages.mailboxes],
        `missing mailboxes.status_${s}`).toBeTruthy();
    }
  });
});
