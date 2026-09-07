/**
 * THE HOST DOOR'S STATIC HALF, ABSENT — substituted for `../host-static.js`.
 *
 * The desktop's module serves the packaged browser client a QR code sends a phone to, with a
 * traversal defence and a credential-page CSP. There is no such client here and no door to serve it
 * on.
 *
 * REFUSES, and may: `createHostStatic` is called only when host mode is armed, which this build
 * makes impossible. The refusal is at CONSTRUCTION rather than inside `serve`, so the failure lands
 * during composition with a sentence about the build, instead of on some later request.
 */
import type { HostStatic } from "../host-static.js";

export function createHostStatic(
  _opts: { assetsDir: string | null; log?: unknown },
): HostStatic & { ready(): Promise<void> } {
  throw new Error(
    "createHostStatic was reached on a build with no host door. This is a composition error: a " +
      "phone serves no browser client to another device, so host mode can never be armed here.",
  );
}
