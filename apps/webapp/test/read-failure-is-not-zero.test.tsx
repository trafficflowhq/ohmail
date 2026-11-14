/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ── A READ THAT FAILED IS NOT A READ THAT RETURNED ZERO ─────────────────────────────────
 *
 * NOT the worker's soft-failure gap, and the distinction matters because the brief this change came from
 * conflated them. That gap is a WORKER/DB row — `status='error'` is too strong for a
 * bounded provider refusal, and it wants a migration, a DTO field and copy. This is a
 * different defect in a different layer, found while reading for that one: webapp panes
 * that answer a rejected read with the value they use for an empty one.
 *
 * Every pane below asks the server one question on mount, and every one of them used to
 * answer a REJECTION with the same value it would use for an empty result. The rendered
 * consequence is not a missing spinner — it is a **false statement of fact**, made in the
 * product's own voice, about the thing the person came to the pane to check:
 *
 *   MailboxSection   `catch { setItems([]) }`      → "No mailbox connected yet."
 *   SecuritySection  `catch { /* nothing *\/ }`      → "You have no unused recovery codes."
 *                                                     "No authenticator app is set up."
 *   AboutSection     `catch { setItems([]) }`      → "No mailbox connected. Settings → Mailboxes."
 *   AccountSection   `catch { /* nothing *\/ }`      → "Deleting an account needs a live session
 *                                                      on that account." (in a signed-in tab)
 *
 * Two of them are worse than a wrong sentence, and those are the reason this is one file
 * rather than a note per pane:
 *
 *  · SecuritySection's false "you have no recovery codes" sits directly above a button that
 *    REPLACES the set the account already holds. A swallowed read talks a person into
 *    destroying codes they are currently relying on.
 *  · MailboxSection's `refresh` is also on a 10 s poll, so the `[]` is rewritten every ten
 *    seconds for as long as the outage lasts. It is a stable false state, not a flicker.
 *
 * ── WHY THE ASSERTIONS ARE PAIRED, AND WHY BOTH HALVES ARE NEEDED ───────────────────────
 *
 * Each pane gets two: the false sentence is ABSENT, and the server's own sentence is
 * PRESENT in a live region. Neither half alone is the property.
 *
 *  · "the false sentence is absent" passes for a pane that renders NOTHING, and rendering
 *    nothing is the other way to fail a person — `AttachmentStrip`'s refusal row and its timeout are
 *    both that shape, and this repo has already paid for it twice.
 *  · "an error is shown" passes for a pane that ALSO still says "No plan yet" underneath it,
 *    which is a contradiction on one screen and reads as a bug in the error, not in the read.
 *
 * ── THE SENTENCE IS THE SERVER'S, AND THAT IS DELIBERATE ────────────────────────────────
 *
 * `api-client.ts`'s header states the rule: "Every refusal in this flow already has a true,
 * actionable message written by the service that made the decision… The UI's job is to
 * display it, not to re-derive it: a second copy of the taxonomy in the client is how a user
 * ends up being told they are out of mailbox slots when the real problem is an unpaid
 * subscription." `onboarding.test.ts` enforces that by forbidding those sentences in webapp
 * source at all. So the fix adds NO new copy — it routes `messageOf(err)` into the `error`
 * slot each of these panes already has and already renders with `role="alert"`.
 *
 * `AboutSection` is the one exception and it is called out here rather than left to be
 * discovered: it has no error state at all, and its catch carries a comment claiming *"The
 * panel says 'could not read' rather than showing nothing"* — a sentence that exists nowhere
 * in the `about` namespace. The comment was the claim under test and it was false.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, blockedReason: null, mailboxCount: 0,
  // Explicit — see `connect-gate-order.test.tsx`: the cast hides a missing field.
  settled: true,
  owed: false,
} as unknown as MailState;

/**
 * THE SENTENCE THE SERVER WROTE. Distinctive on purpose: an assertion that merely looked for
 * "error" would pass against any sentence at all, including one the client invented.
 */
const SERVER_SAID = "ohmail is having a bad minute — this read did not complete.";

/** Which reads are currently refusing. `mock`-prefixed: `vi.mock`'s factory is hoisted. */
let mockFails = true;
const mockListed: MailboxDTO[] = [];

function answer<T>(value: T): Promise<T> {
  if (mockFails) {
    return Promise.reject(Object.assign(new Error(SERVER_SAID), { code: "internal", status: 503 }));
  }
  return Promise.resolve(value);
}


vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    assertPasskey: async () => ({}),
    codeOf: (e: unknown) => (e as { code?: string }).code ?? "unknown",
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    auth: {
      /**
       * THE ONE READ THREE PANES SHARE. `SecuritySection` takes `user.twofaEnrolled` from it,
       * `AccountSection` takes `user.accountId` and `MailboxSection` takes the address — so one
       * refusal here reproduces three of the defects at once, which is why they are one file.
       */
      session: () => answer({
        user: {
          userId: "u1", accountId: "acct-1", email: "person@example.test",
          displayName: "Person", emailVerified: true,
          twofaEnrolled: { webauthn: true, totp: true, recoveryCodes: true },
        },
        scope: "full",
      }),
      login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
      totpVerify: async () => undefined,
      recoveryVerify: async () => undefined,
      recoveryCodes: async () => ({ codes: ["a"] }),
      totpEnroll: async () => ({ secret: "s", otpauthUrl: "u" }),
      totpActivate: async () => undefined,
      totpRemove: async () => undefined,
      webauthnAssertOptions: async () => ({ options: {} }),
      webauthnAssertVerify: async () => undefined,
    },
    aiSettings: {
      get: () => answer({ aiEnabled: true }),
      set: async () => undefined,
    },
    mailboxes: {
      list: () => answer({ items: mockListed }),
      create: async () => ({}),
      resync: async () => undefined,
    },
    account: {
      erase: async () => undefined,
      /* The erasure pane asks where the subscription is managed, to decide whether to say
         anything about one at all. FAILS with everything else here — this file's whole subject
         is that a refused read is not an empty result — and the pane's own answer to a refusal
         is to say nothing, which is the honest one and not the defect under test. */
      access: () => answer({ metered: false }),
      manageLink: () => answer(null),
    },
  };
});

/** `AccountSection` wipes the local mirror on the way out; nothing here reaches that path. */
vi.mock("@ohmail/client-engine", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@ohmail/client-engine");
  return { ...actual, clearAllMirrors: async () => undefined };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

/* ── mounting ────────────────────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function mount(Pane: React.ComponentType): Promise<HTMLDivElement> {
  await unmount();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(Pane) }));
  });
  await settle();
  return host;
}

/** Everything a live region announces, joined — where a reason is owed, it must be. */
function announced(el: HTMLElement): string {
  return [...el.querySelectorAll('[role="alert"], [role="status"]')]
    .map((n) => (n.textContent ?? "").trim())
    .join(" | ");
}

const panes = {
  mailbox: async () => (await import("../app/(product)/mailbox/MailboxSection.js")).MailboxSection,
  security: async () => (await import("../app/(product)/mailbox/SecuritySection.js")).SecuritySection,
  about: async () => (await import("../app/(product)/mailbox/AboutSection.js")).AboutSection,
  account: async () => (await import("../app/(product)/mailbox/AccountSection.js")).AccountSection,
};

beforeEach(() => { mockFails = true; });
afterEach(async () => { await unmount(); vi.clearAllMocks(); });

/**
 * ONE TABLE, ONE PROPERTY, FIVE PANES.
 *
 * A table rather than five hand-written cases because the property is the same one every
 * time, and writing it five times is how four of them end up subtly weaker than the fifth.
 * `forbidden` is read from `messages/en.json` — the file the pane itself renders from — so a
 * copy change moves the fixture with the surface instead of leaving a guard matching a string
 * nothing says any more.
 */
const CASES: { name: keyof typeof panes; forbidden: string[]; why: string }[] = [
  {
    name: "mailbox",
    forbidden: [messages.mailboxes.noneYet],
    why: "a customer with three working mailboxes is told they have none",
  },
  {
    name: "security",
    forbidden: [messages.security.codesNone, messages.security.totpOff],
    why: "and is then offered a button that replaces the codes they still hold",
  },
  {
    name: "about",
    forbidden: [messages.about.noMailbox],
    why: "the (i) panel states a fact it could not read",
  },
  {
    name: "account",
    forbidden: [messages.account.signedOutBody],
    why: "a signed-in tab is told the session is not live",
  },
];

describe("a failed read never renders as an empty result", () => {
  for (const { name, forbidden, why } of CASES) {
    it(`${name}: says what happened instead of "${forbidden[0]}"`, async () => {
      const el = await mount(await panes[name]());
      const text = el.textContent ?? "";

      for (const claim of forbidden) {
        expect(text, `${name}: ${why} — the read FAILED and the pane asserts "${claim}"`)
          .not.toContain(claim);
      }

      // …and the other way to fail a person: saying nothing at all. The reason has to be
      // announced, not merely painted, because these panes are opened after something already
      // looked wrong, and a silent surface is what sent the reader here in the first place.
      expect(announced(el), `${name}: the read failed and nothing anywhere says so`)
        .toContain(SERVER_SAID);
    });
  }

  /**
   * THE CONTROL, and it is what keeps the cases above from passing for the wrong reason.
   *
   * A pane that rendered an error unconditionally would satisfy every assertion in this file.
   * With the reads SUCCEEDING, the alert must be gone — and the ordinary empty state, which is
   * a true sentence about a real answer, must be free to appear.
   */
  it("a read that SUCCEEDS says nothing about a failure", async () => {
    mockFails = false;
    const el = await mount(await panes.mailbox());
    expect(announced(el)).not.toContain(SERVER_SAID);
    // `mockListed` is empty and that is now a MEASURED zero, so the honest sentence is back.
    expect(el.textContent ?? "").toContain(messages.mailboxes.noneYet);
  });
});
