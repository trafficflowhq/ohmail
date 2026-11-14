/**
 * WHAT THE "TOO OLD" CARD OFFERS, decided here and drawn by `ui/UpdateCard.tsx`: where an update of THIS
 * build comes from, and the way into the web, which is there from the first day. Pure, so the node suite holds
 * every arm without a renderer, and a verb with nowhere to go is WITHHELD, never drawn dead.
 *
 *  · a store build goes to its store: Play on Android, the App Store on iOS by its listing's numeric id
 *    (`APP_STORE_ID`; an id that is empty or not numeric withholds the verb rather than drawing a dead button);
 *  · a build from the release page (`sideload`) goes to the download page;
 *  · both, where the phone knows a page a browser can open for its server ({@link webAddressOf}), can
 *    open it in the browser.
 */
import type { Distribution } from "../distribution";
import { APP_STORE_PAGE, DOWNLOAD_PAGE, PLAY_STORE_PAGE, WEB_APP_URL } from "./account";
import { MANAGED_ORIGIN } from "./pairing";

export { DOWNLOAD_PAGE };

/** `app.json`'s `android.package`, held equal by `test/update-verbs.test.ts`. */
export const PLAY_PACKAGE = "app.ohmail";

/** The App Store listing's numeric id, from the published listing. An empty id withholds the verb. */
export const APP_STORE_ID: string = "6810824816";

/** What a numeric App Store id looks like. */
export const APP_STORE_ID_SHAPE = /^\d{6,12}$/;

export type UpdateVerbId = "store" | "download" | "browser";

export interface UpdateVerb {
  id: UpdateVerbId;
  url: string;
}

/** The store page for this platform, or `null` where there is none to name. */
export function storeUrlOf(os: string, appStoreId: string = APP_STORE_ID): string | null {
  if (os === "android") return `${PLAY_STORE_PAGE}${PLAY_PACKAGE}`;
  if (os === "ios" && APP_STORE_ID_SHAPE.test(appStoreId)) return `${APP_STORE_PAGE}${appStoreId}`;
  return null;
}

/** The server a pairing is with, as its profile holds it. */
export interface PairedServer {
  origin: string;
  flavor: string;
}

/**
 * THE ADDRESS A BROWSER CAN OPEN FOR THIS SERVER, or `null` where the phone knows none. A server the
 * person runs and a computer of theirs serve their pages at the origin the phone paired with. The
 * hosted service does not: the phone pairs with its API host, which serves no page, and the web app
 * is at an address of its own. Any other server has no page this app can name, so the verb is withheld.
 */
export function webAddressOf(server: PairedServer): string | null {
  if (server.flavor === "selfhost" || server.flavor === "desktop-host") return server.origin;
  if (server.flavor === "managed" && server.origin.replace(/\/+$/, "") === MANAGED_ORIGIN) return WEB_APP_URL;
  return null;
}

/** The verbs, in the order a person meets them: the way to the update first, the way into the web second. */
export function updateVerbs(input: {
  os: string;
  distribution: Distribution;
  /** The server this session is paired with; `null` where there is none. */
  server: PairedServer | null;
  appStoreId?: string;
}): UpdateVerb[] {
  const out: UpdateVerb[] = [];
  if (input.distribution === "sideload") {
    out.push({ id: "download", url: DOWNLOAD_PAGE });
  } else {
    const store = storeUrlOf(input.os, input.appStoreId);
    if (store !== null) out.push({ id: "store", url: store });
  }
  const web = input.server === null ? null : webAddressOf(input.server);
  if (web !== null && /^https?:\/\/\S+$/.test(web)) out.push({ id: "browser", url: web });
  return out;
}
