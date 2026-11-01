/**
 * WHERE OHMAIL KNOWS IT CANNOT SHOW A MEETING INVITATION'S EVENT, IT SAYS SO — on every body surface
 * (the reading pane, a conversation panel, the Screener's preview of mail still waiting), always
 * ABOVE and OUTSIDE the element that holds the mail. Never on the Screener's dull previews (spam,
 * junk, screened out): mail set aside for distrust gets no ohmail voice.
 *
 * Two sources, in order:
 *  1. The body TEXT is an Outlook Web App stub (`owaInvitationStub`): the reader's own Exchange or
 *     Microsoft 365 server served the invitation over IMAP as a link. The note says that and names
 *     the setting that makes future invitations arrive as events. The link is core's options URL,
 *     built from constants on Microsoft 365's own hosts, never the message's own URL, and it is
 *     reported to the shell (`useRenderedLinks`) so the desktop opens it on a press. Nothing is
 *     fetched.
 *  2. Otherwise the stored-header fact (`EngineMessage.invitationWithoutEvent`): the generic line.
 * The body text decides the first because a desktop signed in to Cloud holds no headers.
 */
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { owaInvitationStub } from "@ohmail/client-engine";
import { linkHref, useRenderedLinks } from "./rendered-links";

const NO_LINKS: readonly string[] = [];

export function InvitationNote({
  message,
  text,
  full,
  className,
}: {
  /** The header fact; absent on a surface that carries none (the Screener's held rows). */
  message?: { invitationWithoutEvent?: boolean } | null;
  /** The body's text part as drawn. */
  text: string | null | undefined;
  /** Whether `text` is the whole body; a snippet or a loading body is never read for the stub. */
  full: boolean;
  className: string;
}) {
  const tb = useTranslations("body");
  const stub = useMemo(() => (full && text ? owaInvitationStub(text) : null), [full, text]);
  const href = stub?.optionsHref ? linkHref(stub.optionsHref) : null;
  useRenderedLinks(href === null ? NO_LINKS : [href]);

  if (stub !== null) {
    return (
      <p className={className} role="note">
        {tb("invitationOwaLink")} {tb("invitationOwaRemedy")}
        {href !== null ? (
          <>
            {" "}
            <a href={href} target="_blank" rel="noopener noreferrer">
              {tb("invitationOwaOpenSetting")}
            </a>
          </>
        ) : null}
      </p>
    );
  }
  if (message?.invitationWithoutEvent === true) {
    return (
      <p className={className} role="note">
        {tb("invitationWithoutEvent")}
      </p>
    );
  }
  return null;
}
