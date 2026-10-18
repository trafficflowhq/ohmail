/** @vitest-environment jsdom */
/**
 * The PRODUCT group's three wordmarks: the login card, the join card, and the gate
 * inside `mailbox/page.tsx` (the route a signed-in `/` is rewritten to).
 *
 * Scoped to `app/(product)` deliberately. Since that change the marketing site lives in the
 * same app under `app/(marketing)`, and `wordmark-marketing.test.ts` owns those —
 * a scan of `app/` alone would give the two tests overlapping claims and make
 * `test/wordmark-completeness.test.ts`'s ownership map a lie.
 *
 * All three paint the mark as `<em>oh</em>mail` so `.wordmark em` can carry
 * accent-ink — which means the brand never appears in this source as one
 * string, and the `mailoh → ohmail` rename left all three reading the OLD name
 * while its commit claimed the sweep was "verified by grep". The webapp had no
 * wordmark test at all, which is the reason nothing objected.
 *
 * These assert the rendered text. See test/support/wordmark.ts for why the
 * markup is put into a DOM rather than mounted: `mailbox/page.tsx` is an async
 * server component and `Shell` in JoinScreen is not exported, so no mount
 * reaches them, and the surfaces a rename breaks are exactly the ones no mount
 * reaches.
 */
import { describe, expect, it } from "vitest";
import { assertReadsOhmail, marksUnder, renderedText } from "../../../test/support/wordmark.js";

const marks = [
  ...marksUnder("apps/webapp/app/(product)"),
  // The SHARED shell, which is not in the route group and is not the marketing site
  // either: `shell/engine.tsx` renders the signed-out panel when the API will not confirm
  // whose mailbox this is. It belongs to this test because it is a product
  // screen, and it is listed separately because `apps/desktop` ships this same file.
  ...marksUnder("apps/webapp/app/shell"),
];

describe("webapp wordmarks", () => {
  it("finds all nineteen of them", () => {
    // Email verification adds `VerifyEmailScreen`, which paints the mark in its own `Shell` for the same
    // reason `JoinScreen` does: neither `Shell` is exported, so no mount reaches either — and
    // the surfaces a rename breaks are exactly the ones no mount reaches.
    expect(marks.map((m) => m.file).sort()).toEqual([
      // The one-confirm desktop sign-in: the desktop sends a person here, `/link-desktop`'s audience.
      "apps/webapp/app/(product)/approve/ApproveScreen.tsx",
      // The confirmation in front of the native sign-in. Fifth of the unexported-`Shell` family,
      // and it shares `/link-desktop`'s audience for the same reason: the desktop app sends a
      // person here, so this screen can be a stranger's first sight of the brand on the web.
      "apps/webapp/app/(product)/authorize-desktop/AuthorizeDesktopScreen.tsx",
      "apps/webapp/app/(product)/join/JoinScreen.tsx",
      // The invite landing — the page an invite link from Settings → Invites opens. Fourth of
      // the unexported-`Shell` family: no mount reaches it, and it is many an invited person's
      // very first sight of the brand.
      "apps/webapp/app/(product)/join/invite/InviteScreen.tsx",
      // The desktop sign-in handoff page. Third of the unexported-`Shell` family, and the one
      // with the widest audience for a broken mark: it is the page the DESKTOP APP opens, so a
      // stranger's first sight of the brand on the web can be this screen rather than the
      // landing.
      "apps/webapp/app/(product)/link-desktop/LinkDesktopScreen.tsx",
      "apps/webapp/app/(product)/login/LoginScreen.tsx",
      // THE ACCESS LOCK — what an account the service has refused sees instead of its mail. It
      // gained the mark when it came off Tailwind utilities onto `.gate-card`, the shell every
      // other full-screen sentence here already stood in. Somebody can arrive here cold, from a
      // mail about a payment, and no mount reaches it — the family's usual reason.
      "apps/webapp/app/(product)/mailbox/AccessLock.tsx",
      // The card a signed-in browser waits behind while the account's standing is asked, before
      // any mail paints. No mount of this list reaches it: it stands for at most three seconds.
      "apps/webapp/app/(product)/mailbox/CloudShell.tsx",
      // THE ERASED-ACCOUNT WALL — the whole page for an account deleted from another browser, in
      // the same `.gate-card` shell as the lock beside it; reached by the erased door, never a mount.
      "apps/webapp/app/(product)/mailbox/ErasedWall.tsx",
      "apps/webapp/app/(product)/mailbox/page.tsx",
      // The session-resume splash paints the mark in every state, its wait included, for the same
      // reason the others do: no mount reaches it, so a rename would break it silently.
      "apps/webapp/app/(product)/resume/ResumeScreen.tsx",
      // The self-host FIRST-RUN ceremony — an operator's very first sight of the brand on
      // their own box, which makes a broken mark here a first impression rather than a typo.
      "apps/webapp/app/(product)/setup/SetupScreen.tsx",
      // The return from the payment page — public, and often a person's first ohmail screen in a
      // browser that is not the one they read mail in.
      "apps/webapp/app/(product)/subscribed/SubscribedScreen.tsx",
      "apps/webapp/app/(product)/verify-email/VerifyEmailScreen.tsx",
      // THE FIRST-RUN STAGE. The mark sits at the top of the setup card, which on the standalone
      // door is the very first ohmail screen anybody sees — there is no login page in front of
      // it. Unreached by any mount for the family's usual reason: the stage renders only behind
      // a route flag and a door that can make its calls.
      "apps/webapp/app/shell/FirstRun.tsx",
      // engine.tsx FOUR times, one per card: the signed-out gate (`SessionScreen`), the
      // mid-use re-auth prompt (`SessionEnded`), and the two surfaces that say the session
      // check did not finish — `UnconfirmedOverlay` over a warm mirror and `UnconfirmedGate`
      // on a cold browser. Each paints the mark on its own card, and none of the four is
      // reached by a mount.
      "apps/webapp/app/shell/engine.tsx",
      "apps/webapp/app/shell/engine.tsx",
      "apps/webapp/app/shell/engine.tsx",
      "apps/webapp/app/shell/engine.tsx",
    ]);
  });

  it.each(marks.map((m) => [`${m.file}:${m.line}`, m] as const))(
    "%s reads 'ohmail', however it is split",
    (_where, mark) => assertReadsOhmail(mark, expect),
  );

  it("the accent run is 'oh' on every one of them", () => {
    for (const mark of marks) {
      const host = document.createElement("div");
      host.innerHTML = mark.markup;
      const accent = host.querySelector("em");
      expect(accent?.textContent, `${mark.file}:${mark.line}`).toBe("oh");
      expect(renderedText(mark.markup)).toBe("ohmail");
    }
  });
});
