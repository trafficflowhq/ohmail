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
  return <ResumeScreen />;
}
