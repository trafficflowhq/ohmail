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
  it("finds all six of them", () => {
    expect(marks.map((m) => m.file).sort()).toEqual([
      // The card a signed-in browser waits behind while the account's standing is asked, before
      // any mail paints. No mount of this list reaches it: it stands for at most three seconds.
      "apps/webapp/app/(product)/mailbox/CloudShell.tsx",
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
