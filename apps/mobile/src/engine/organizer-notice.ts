/**
 * THE ANDROID NOTIFICATION'S BODY FOLLOWS THE GATE (ANDROID-NOTIFICATION-SAYS-ORGANIZING-OVER-A-REFUSED-GATE).
 * Over a gate refused for `ohmail/_meta` it says what the in-app strip says (`metaBlockedLine`, the
 * desktop row's sentence), never "Organizing". It stays shown: Android keeps a notification over a
 * running foreground service, and the claim, and Stop, are still this phone's.
 */
import { Copy } from "../copy";
import { metaBlockedLine } from "../ui/standalone-form";

export function organizerNoticeBody(
  address: string,
  runtimes: Readonly<Record<string, { readonly unreadableReason?: string | null }>>,
): string {
  const blocked = Object.values(runtimes).map((s) => s.unreadableReason)
    .find((r) => r === "meta_folder_full" || r === "meta_undeletable");
  return blocked === "meta_folder_full" || blocked === "meta_undeletable" ? metaBlockedLine(blocked) : Copy.notifBody(address);
}
