import { cookies } from "next/headers";
import { OWNER_COOKIE } from "../../shell/owner-cookie";
import { ResumeScreen } from "./ResumeScreen";

/**
 * The resume splash. Reached ONLY as `/` — `middleware.ts` rewrites the root here when the
 * session gate answers `"resume"`, and answers a direct request for this path with a 308 back
 * to `/`, exactly as it does for `/mailbox`. The address bar never shows `/resume` and the
 * product keeps one public URL.
 *
 * The gate sends a browser here when it holds the `tf_resume` marker but no usable access
 * cookie: the fifteen-minute access token lapsed, or `SameSite=Strict` withheld it on a
 * cross-site navigation. Either way a ninety-day rolling refresh token is probably still in the jar,
 * and only the browser can spend it — see `ResumeScreen`.
 */
export default function Page() {
  /*
   * ── WHICH ACCOUNT WAS THIS SURFACE CHOSEN FOR? READ HERE, ON THE SERVER ─────────────────
   *
   * The edge picks this page under the cookies of the request that asked for `/`. The screen's
   * effect does not run until the document has been delivered and hydrated, and another tab can
   * replace the shared jar in between — after which the refresh below would spend THAT account's
   * refresh token from a window that was never theirs.
   *
   * A client-side read cannot see that gap, because it happens after it. So the account is read
   * where the choice was made and handed down; the screen compares it against the jar at the
   * moment the request actually leaves. `tf_owner` is a marker and authorises nothing, so
   * reading it here costs nothing and reveals nothing.
   */
  const owner = cookies().get(OWNER_COOKIE)?.value ?? null;
  return <ResumeScreen initialOwner={owner} />;
}
