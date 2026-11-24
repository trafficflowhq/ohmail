/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { routeOf } from "@ohmail/app/frame/route";
import { PANE_IDS } from "@ohmail/app/settings/contract";

/**
 * `?settings=<pane>` — THE DEEP LINK THE CONSENT CEREMONY LANDS ON.
 *
 * The Microsoft callback bounces the browser to `/mailbox?settings=mailboxes&oauth=…#/settings`. The
 * hash opens the settings VIEW; without this parameter the view opens on General and the sentence
 * explaining what just happened is one click away and invisible. So the pane is part of the link, and
 * these are the two properties that make reading a pane name out of a URL safe.
 *
 * SORTED (the switch's older tests, sorted once). Today's Settings view and its `?settings=` reading leave with the
 * switch; Settings is the new frame's place, its section the address's own segment (`#/settings/<id>`), and the
 * consent return lands there itself. Two cases RETIRED to the new parts' own cases, seen green:
 *  - "opens the pane the URL asks for, and General when it asks for nothing": the consent return lands on Settings ›
 *    Mailboxes (`oauth-return-landing.test.tsx`, "completes the ceremony from a URL with NO fragment, and routes to
 *    Settings → Mailboxes"); a Settings address that names nothing stands on General
 *    (`packages/app/test/settings/frame/menu.test.ts`, "for an unknown or unlisted section ...");
 *  - "an UNRECOGNISED value is General, never a pane that renders nothing": the same menu case, and the place's own
 *    (`packages/app/test/settings/frame/place.test.tsx`, "an unknown or unlisted section shows General ...").
 * The list's census reads the new Settings contract's `PANE_IDS`; the address's case reads the frame's own route
 * (`routeOf`: the place and its section, where today's said the view and its pane). Every expectation as it stood.
 */
afterEach(() => { window.history.replaceState(null, "", "/mailbox"); });

describe("the settings pane can be named in a link", () => {
  it("every id in the list is one the pane switch actually has", () => {
    // The list is hand-written beside a `PaneId` union that the compiler checks, so this asserts the
    // pair is complete rather than merely well-typed: a pane added to the union and not to the list
    // is silently unreachable by link.
    const source = PANE_IDS.join(" ");
    for (const id of ["general", "notifications", "mailboxes", "screener", "away", "billing", "tags", "rules", "about", "security", "account", "desktop"]) {
      expect(source, id).toContain(id);
    }
  });
});

describe("the hash opens the VIEW — and it can name the pane now, which this link predates", () => {
  it("`#/settings` and `#/settings/mailboxes` are both the settings view", () => {
    // This used to assert the second form fell through to the Ohbox — the reason the ceremony's
    // pane rode a query parameter. The segment exists now (`#/settings/<pane>`, walkable with
    // Back/Forward; see `settings-subroutes.test.tsx`), and it OUTRANKS this parameter. The
    // parameter's own contract above is unchanged: it decides the BARE `#/settings` mounts,
    // which is exactly the hash the ceremony's redirect carries.
    expect(routeOf("#/settings").place).toBe("settings");
    expect(routeOf("#/settings").sub).toBeNull();
    expect(routeOf("#/settings/mailboxes")).toMatchObject({ place: "settings", sub: "mailboxes" });
  });
});
