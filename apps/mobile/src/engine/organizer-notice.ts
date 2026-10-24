/**
 * THE ANDROID NOTIFICATION'S BODY FOLLOWS THE GATE (ANDROID-NOTIFICATION-SAYS-ORGANIZING-OVER-A-REFUSED-GATE).
 * Over a gate refused for `ohmail/_meta` or the phone's clock it says what the in-app strip says (`metaBlockedLine`, the
 * desktop row's sentence), never "Organizing". It stays shown: Android keeps a notification over a
 * running foreground service, and the claim, and Stop, are still this phone's.
 */
import { Copy } from "../copy";
import { gateBlockOf, metaBlockedLine } from "../ui/standalone-form";

export function organizerNoticeBody(
  address: string,
  runtimes: Readonly<Record<string, { readonly unreadableReason?: string | null }>>,
): string {
  const blocked = Object.values(runtimes).map((s) => gateBlockOf(s.unreadableReason)).find((r) => r !== null) ?? null;
  return blocked !== null ? metaBlockedLine(blocked) : Copy.notifBody(address);
}
