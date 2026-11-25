/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installShellEnv, mailbox, mountShell, teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";
import { FACTS_POLL_MS } from "@ohmail/app-logic/mail-state/mail-state-binding";

/**
 * ═══ THE MAILBOX-FACTS POLL BELONGS TO ONE ACCOUNT TOO ═════════════════════════════════════
 *
 * `MailStateProvider` re-reads `GET /mailboxes` every thirty seconds, and it already had an
 * ownership test: an answer is published only when the ENGINE, the probe and the freshness probe
 * are still the ones the request was made for. That is exactly right for the switch it was
 * written for — the shell replaced the engine, so an answer about the old one may not be
 * published over the new one.
 *
 * It cannot see the case that costs mail. When somebody signs in as another account in a second
 * tab of the same profile, the API rewrites the cookie jar and NOTHING in this tree changes:
 * the same engine object, the same probe function, the same callbacks. The next poll therefore
 * asks under the new session, the identity comparison is trivially true, and the other account's
 * mailbox ids, addresses, sync state, errors and timestamps are published into this account's
 * sync strip and From selectors. Automatically, on a timer, with nobody pressing anything.
 *
 * So the identity that matters here is the SESSION's, and the mirror's sync gate already holds
 * it. What is pinned below: the poll is shown WORKING first (or the refusal proves nothing), and
 * then a rewritten jar stops both the asking and the publishing.
 */

const MINE = "walker@example.invalid";
const THEIRS = "someone-else@example.invalid";

// A refused provider sign-in is announced immediately, which makes a published row
// observable without crossing the quiet notice delay.
const failedMailbox = (options: Parameters<typeof mailbox>[0] = {}) =>
  mailbox({ status: "error", errorCode: "auth", ...options });

let asks = 0;
let answer = (): Promise<ReturnType<typeof mailbox>[]> => Promise.resolve([failedMailbox()]);

const probe = async (): Promise<ReturnType<typeof mailbox>[]> => {
  asks += 1;
  return answer();
};

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  asks = 0;
  answer = () => Promise.resolve([failedMailbox()]);
});

afterEach(async () => {
  // Cleared here rather than at the end of the case that sets it: a failing assertion skips the
  // tail of its own test, and a `tf_owner` left behind signs every later case in the file out.
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  await teardownShellEnv();
});

describe("the mailbox facts poll", () => {
  it("stops asking, and stops publishing, once the browser holds another account's session", async () => {
    const el = await mountShell([], { probe });
    await tick(1_000);

    // THE CONTROL. The poll has to be shown answering and publishing, or every assertion below
    // is green over a strip that was silent all along.
    expect(asks, "the probe was never called, so the refusal below proves nothing")
      .toBeGreaterThanOrEqual(1);
    expect(textOf(el), "the strip never published this account's own mailbox").toContain(MINE);

    await tick(FACTS_POLL_MS * 2);
    const polled = asks;
    expect(polled, "the thirty-second poll is not running").toBeGreaterThan(1);

    // Somebody signs in as another account in a second tab. The jar is rewritten; this tree
    // re-renders nothing, holds the very same engine, and the very same probe function.
    document.cookie = "tf_owner=acct_someone_else; Path=/";
    answer = () => Promise.resolve([failedMailbox({ address: THEIRS })]);

    await tick(FACTS_POLL_MS * 3);
    expect(asks, "the poll kept asking under another account's session").toBe(polled);
    expect(textOf(el), "another account's mailbox address was published into this strip")
      .not.toContain(THEIRS);
  });

  /**
   * AND AN ANSWER ALREADY IN FLIGHT WHEN THE JAR CHANGES IS REFUSED TOO — which is why the
   * question is asked twice, before and after the await, rather than once at the top.
   */
  it("drops an answer that arrives after the jar has been rewritten", async () => {
    let release: ((v: ReturnType<typeof mailbox>[]) => void) | null = null;
    const el = await mountShell([], { probe });
    await tick(1_000);
    expect(textOf(el)).toContain(MINE);

    /* THE CONTROL, and it is the whole reason this case is shaped as two rounds rather than
       one: a deferred answer that is never published for some unrelated harness reason would
       make the assertion below green with the check deleted. Round one proves the deferral
       mechanism DOES reach the screen. */
    const OTHER = "control@example.invalid";
    answer = () => new Promise((resolve) => { release = resolve; });
    await tick(FACTS_POLL_MS);
    expect(release, "the poll never issued the request this case is about").toBeTruthy();
    release!([failedMailbox({ address: OTHER })]);
    await tick(1_000);
    expect(textOf(el), "a deferred answer never reaches the strip at all").toContain(OTHER);

    // Round two: the request leaves while the jar still agrees, and the sign-in in the other
    // tab lands while it is still in the air.
    release = null;
    answer = () => new Promise((resolve) => { release = resolve; });
    await tick(FACTS_POLL_MS);
    expect(release, "the second request never left").toBeTruthy();
    document.cookie = "tf_owner=acct_someone_else; Path=/";
    release!([failedMailbox({ address: THEIRS })]);
    await tick(1_000);

    expect(textOf(el), "an in-flight answer was published after the jar changed hands")
      .not.toContain(THEIRS);
  });
});
