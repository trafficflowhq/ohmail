/**
 * "WE FOUND YOUR OHMAIL SETTINGS ON THIS MAILBOX" IN THE DESKTOP WINDOW — the transport, and
 * deliberately nothing else. The card, the counts-in-words, the fingerprint-as-consent and the
 * durable "Not now" are the shared client's (`app/shell/ProfileImportCard.tsx`); this window's
 * Cloud client is a refusing stub, so the three calls go down the pipe to the engine. Live on
 * BOTH doors (`profileImportDoorFor` in `doors.js`): standalone serves the confirm routes from
 * the store on this machine, hosted forwards all three to the account — a dismissal here
 * dismisses everywhere. A rejection's `message` is the ENGINE's own sentence, shown verbatim.
 * The route, narrowing and refusal contract are `profile-import-wire.ts`'s, with no door in it.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { ProfileImportTransport } from "../../webapp/app/shell/ProfileImportCard";
import { profileImportVia } from "./profile-import-wire.js";

export { profileImportPath, profileImportVia } from "./profile-import-wire.js";
export type { ProfileImportFetch } from "./profile-import-wire.js";

/**
 * The WINDOW's instance, over the bridge. A module constant rather than a per-render factory
 * call: it holds no state, and one object per module means the shell's `useProfileImport` sees a
 * stable identity across renders.
 */
export const profileImportOverBridge: ProfileImportTransport = profileImportVia(bridgeFetch);
