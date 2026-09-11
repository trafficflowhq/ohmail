import { notFound } from "next/navigation";
import { InviteScreen } from "./InviteScreen";

/**
 * `/join/invite#<token>` — the page an invite link opens (design in `InviteScreen.tsx`; the pane that mints the link
 * is `mailbox/InvitesSection.tsx`). SELF-HOST ONLY, decided at COMPILE time: on the managed deployment this page is a
 * constant 404 — nothing on managed mints a link of this shape (managed invites arrive as `/join?code=…`), and a page
 * that accepted one would advertise a ceremony the managed API does not mount; the literal env read mirrors
 * `middleware.ts`'s copy (a server component may not import the client module that also exports `serverHello`).
 */

/**
 * NO server-side inputs, deliberately: the one credential rides the URL FRAGMENT, which the browser never sends —
 * nothing to read here, nothing for logs, referrers or caches to retain; the strict nonce CSP is the load-bearing
 * header for a fragment credential.
 */
const SELF_HOST_BUILD = process.env.NEXT_PUBLIC_OHMAIL_FLAVOR === "selfhost";

export default function JoinInvitePage() {
  if (!SELF_HOST_BUILD) notFound();
  return <InviteScreen />;
}
