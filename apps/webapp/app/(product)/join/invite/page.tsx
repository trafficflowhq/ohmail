import { notFound } from "next/navigation";
import { InviteScreen } from "./InviteScreen";

/**
 * `/join/invite#<token>` — the page an invite link opens (see `InviteScreen.tsx` for the whole
 * design, and `mailbox/InvitesSection.tsx` for the pane that mints the link).
 *
 * SELF-HOST ONLY, decided at COMPILE time: the flavor is a build arm (`app/hello.ts`), so on
 * the managed deployment this page is a constant 404 — nothing on managed ever mints a link of
 * this shape (managed invites arrive as `/join?code=…` from the invite mail), and a page that
 * accepted one would be advertising a ceremony the managed API does not mount. The literal env
 * read mirrors `middleware.ts`'s own copy: a server component may not import the client module
 * that also exports `serverHello`.
 *
 * NO server-side inputs, deliberately: the one credential this page handles — the pairing
 * token — rides the URL FRAGMENT, which the browser never sends, so there is nothing to read
 * here and nothing for access logs, referrers or caches to retain. `middleware.ts` serves the
 * path under the strict nonce CSP with `no-referrer`/`no-store`, the same treatment every
 * credential screen gets — for a fragment credential the nonce policy is the load-bearing one,
 * because an injected inline script reading `location.hash` is the exposure that remains.
 */
const SELF_HOST_BUILD = process.env.NEXT_PUBLIC_OHMAIL_FLAVOR === "selfhost";

export default function JoinInvitePage() {
  if (!SELF_HOST_BUILD) notFound();
  return <InviteScreen />;
}
