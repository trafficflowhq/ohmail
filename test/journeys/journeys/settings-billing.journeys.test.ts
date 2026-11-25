import { PEOPLE } from "../vocabulary/world.js";
import { paneGuards, paneJourneys } from "../bench/panes.js";
import { billingReturnPaint, billingReturnStyles, journey, journeysOf, personWith, type Guard } from "../bench/web.js";

/** The subscription. Listed only where the server meters the account; this bench's server meters nothing. */
const PANE = paneGuards("settings-billing");
const RETURN: Guard = {
  title: "The mailbox shows a loading frame promptly when returning from hosted billing",
  rows: [],
  surfaces: ["W-m"],
  needs: [],
};
const RETURN_STYLES: Guard = {
  title: "The mailbox waits for its styles and opens with the product canvas",
  rows: [],
  surfaces: ["W-m", "W-s"],
  needs: [],
};
const RETURN_STYLE_FAILURE: Guard = {
  ...RETURN_STYLES,
  title: "A failed mailbox stylesheet leaves a styled Reload action",
  // Chromium reports the injected abort and React reports the same link's error event.
  tolerates: [/^console: Failed to load resource: net::ERR_FAILED$/, new RegExp("^page error: Event$")],
};
export const GUARDS: Guard[] = [...PANE, RETURN, RETURN_STYLES, RETURN_STYLE_FAILURE];

journeysOf("settings-billing", () => {
  paneJourneys("settings-billing", PANE);
  journey(RETURN, async (bench) => {
    const { person } = await personWith(bench, {
      from: PEOPLE.ben, subject: "Workshop is ready", pile: "ohbox", unread: true, text: "See you there.",
    });
    await billingReturnPaint(bench, person);
  });

  for (const guard of [RETURN_STYLES, RETURN_STYLE_FAILURE]) {
    journey(guard, async (bench) => {
      const { person } = await personWith(bench, {
        from: PEOPLE.ben, subject: "Workshop is ready", pile: "ohbox", unread: true, text: "See you there.",
      });
      await billingReturnStyles(bench, person, guard === RETURN_STYLE_FAILURE);
    });
  }
});
