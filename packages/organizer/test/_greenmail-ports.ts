/**
 * BOTH PORTS COME FROM THE ENVIRONMENT, OR THE LANE ISOLATES HALF ITS TRAFFIC.
 *
 * IMAP read its port from the environment and SMTP carried the literal 3025, so a lane running its
 * own GreenMail container isolated every read and delivered every SEND into the shared box. Two
 * send cases did, on fresh random users, before anyone noticed. A partial override is worse than
 * none: it looks isolated and is not. So an IMAP port that is not the default with no SMTP port
 * beside it is refused by name rather than silently half-applied.
 */
export function greenmailPorts() {
  const imap = Number(process.env.IMAP_PORT ?? 3143);
  const smtp = process.env.SMTP_PORT === undefined ? null : Number(process.env.SMTP_PORT);
  if (imap !== 3143 && smtp === null) {
    throw new Error(
      `IMAP_PORT is ${imap} and SMTP_PORT is unset: this run would read from your own GreenMail and `
        + "DELIVER into the shared box on 3025. Set SMTP_PORT (and IMAP_HOST/SMTP_HOST if the "
        + "container is not on 127.0.0.1) — a GreenMail container of this checkout's own "
        + "sets all of them. Nothing was measured.",
    );
  }
  return {
    imapHost: process.env.IMAP_HOST ?? "127.0.0.1",
    imapPort: imap,
    smtpHost: process.env.SMTP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1",
    smtpPort: smtp ?? 3025,
  };
}
