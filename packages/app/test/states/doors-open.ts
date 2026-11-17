import type { Page } from "@playwright/test";
import { doorsPage } from "./build-doors.mjs";

/**
 * THE DOORS' STATES PAGE, for the subjects that draw it: every door's page by address over a fake door, bundled with
 * its sheets and read under today's sheets as the product page loads them (`build-doors.mjs`). A subject opens it at
 * a registered key; `DRAWN` names the states it draws, by the reference's ids, and the first one a screen opens at.
 */
export const DRAWN: Readonly<Record<string, { readonly first: string; readonly states: readonly string[] }>> =
  {
    signedout: {
      first: "out",
      states: ["out", "unchecked", "checking", "revoked", "pending", "expired", "absent", "reused", "busy"],
    },
    nopage: { first: "missing", states: ["missing", "noserver"] },
    subscribed: { first: "continuing", states: ["continuing", "back"] },
    verify: {
      first: "form",
      states: ["form", "code", "badlink", "badpw", "locked", "slowed", "done", "handed", "unavailable"],
    },
    serversetup: {
      first: "form",
      states: ["checking", "form", "badtoken", "spent", "settled", "unreachable"],
    },
    invite: { first: "form", states: ["opening", "form", "dead", "used", "incomplete", "unavailable"] },
    approve: {
      first: "ask",
      states: [
        "ask",
        "othernet",
        "factor",
        "busy",
        "stillbusy",
        "discarded",
        "done",
        "denied",
        "expired",
        "used",
        "none",
        "bare",
        "unchecked",
        "closed",
      ],
    },
    authorize: { first: "ask", states: ["ask", "factor", "done", "over", "signin"] },
    linkdesktop: {
      first: "start",
      states: ["start", "code", "factor", "cancelled", "busy", "stillbusy", "signin"],
    },
    deleteaccount: {
      first: "facts",
      states: [
        "facts",
        "typed",
        "factor",
        "erasing",
        "done",
        "donepay",
        "donetab",
        "refused",
        "refusedsub",
        "unconfirmed",
        "cancelled",
        "window",
        "own",
        "signedout",
      ],
    },
    wall: {
      first: "trial",
      states: [
        "trial",
        "canceled",
        "unpaid",
        "suspended",
        "plain",
        "never",
        "pending",
        "checking",
        "nolink",
        "unverified",
        "undated",
        "nofile",
        "erased",
        "erasedtab",
      ],
    },
  };

let html: Promise<string> | null = null;

export async function openDoorsPage(page: Page, query: string): Promise<void> {
  html ??= doorsPage();
  const body = await html;
  /* The document is served from a stand-in address on loopback's terms, so `location.search` carries the key. */
  await page.route("http://doors.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
  await page.goto(`http://doors.test/?${query}`);
}

/** The words of a registered state's address that the doors' page reads; any other belongs to another task. */
const READ = new Set(["screen", "state", "device", "face", "scheme"]);
/** The wall's states on the phone are the phone app's own wall (`phone-screens`), not the web page at a phone's size. */
const PHONE_APPS: ReadonlySet<string> = new Set(["wall"]);

/**
 * A door screen's subjects: each registered key of the screen whose state the page draws (its first one where the
 * key names none, as the screen's seven looks do), opened at its own address. Keys with words the page does not read
 * (the desktop app's and the phone app's variants of the wall, the duo's and the book's postures) are other tasks'.
 */
export function doorSubjects(
  screen: string,
  registered: readonly { readonly key: string; readonly screen: string }[],
): { key: string; open(page: Page): Promise<void> }[] {
  const drawn = DRAWN[screen];
  if (!drawn) throw new Error(`no door screen named ${screen}`);
  return registered
    .filter((row) => row.screen === screen)
    .filter((row) => {
      const words = new URLSearchParams(row.key);
      if ([...words.keys()].some((word) => !READ.has(word))) return false;
      if (["duo", "book"].includes(words.get("device") ?? "")) return false;
      if (PHONE_APPS.has(screen) && words.get("device") === "phone" && words.has("state")) return false;
      return drawn.states.includes(words.get("state") ?? drawn.first);
    })
    .map((row) => ({ key: row.key, open: (page: Page) => openDoorsPage(page, row.key) }));
}
