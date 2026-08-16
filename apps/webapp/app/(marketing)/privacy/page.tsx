import type { Metadata } from "next";
import { Wordmark } from "../components/Wordmark";

export const metadata: Metadata = {
  title: "Privacy — ohmail",
  robots: { index: false },
};

/* Legal content is intentionally NOT routed through i18n — it is the binding
 * legal text of the Swiss operator and changes only deliberately.
 * SCOPE: this policy covers the ohmail.app WEBSITE. The ohmail product's
 * per-tier data model is described on the homepage and will carry its own
 * policy at launch.
 *
 * THE SIGN-UP SECTION WAS FALSE AND IS FIXED. It said "The waitlist form
 * currently saves your entry in your own browser only — nothing is sent to us
 * yet", which stopped being true when the waitlist began writing a
 * `waitlist` row on EU infrastructure; the note-to-self that used to sit here
 * asked for exactly this update and nobody did it. It now describes the waitlist
 * row AND the account data that open registration collects. The lesson worth
 * keeping: a note-to-self in a comment is not a mechanism, and this page is the
 * one surface where a stale sentence is a legal claim rather than marketing. */
export default function PrivacyPage() {
  return (
    <main className="l-legal">
      <a className="l-legal-brand" href="/">
        <Wordmark />
      </a>
      <h1 className="l-legal-title">Privacy Policy</h1>

      <div className="l-legal-body">
        <p>
          This policy covers the ohmail.app website, operated by TrafficFlow
          GmbH, Staubstrasse 1, 8038 Zürich, Switzerland (
          <a href="mailto:support@ohmail.app">support@ohmail.app</a>).
        </p>

        <h2>No analytics, no trackers</h2>
        <p>
          This website uses no analytics, no advertising trackers, no
          third-party scripts, and no tracking cookies. Your theme preference
          is stored in your own browser (localStorage) and is never
          transmitted.
        </p>

        <h2>The live demo</h2>
        <p>
          The product demo on this site runs entirely in your browser with
          fictional sample data. Nothing you click or type in the demo is
          transmitted anywhere.
        </p>

        <h2>Signing up</h2>
        <p>
          Creating an ohmail Cloud account sends us the email address, name and
          password you type, and we store them on EU servers to operate the
          account. Passwords are stored only as a scrypt hash — never in a form
          we can read. We also record the connection details every sign-in and
          sign-up attempt arrives with (IP address, browser user agent) to
          rate-limit abuse and to show you your own active devices. Legal basis:
          performance of the contract, and our legitimate interest in keeping
          accounts secure.
        </p>
        <p>
          The &ldquo;keep me posted&rdquo; form stores the address and the
          interest you pick, on the same EU servers, so we can write to you when
          there is something to tell you. It is used for nothing else, and asking
          us to remove it removes it.
        </p>

        <h2>Hosting and server logs</h2>
        <p>
          ohmail.app is served by Vercel Inc. (USA). Like every web server,
          Vercel processes technical connection data (IP address, request
          time, user agent) in server logs for delivery and security. Legal
          basis: our legitimate interest in operating the website securely.
          We add no logging of our own.
        </p>

        <h2>Your rights</h2>
        <p>
          Under the Swiss Federal Act on Data Protection (FADP) and, where
          applicable, the GDPR, you may request access to, correction of, or
          deletion of personal data concerning you. If you have an account, the
          product deletes it and its data itself; otherwise write to us. Contact:{" "}
          <a href="mailto:support@ohmail.app">support@ohmail.app</a>.
        </p>

        <h2>The ohmail product</h2>
        <p>
          ohmail Desktop is designed so your mail never touches our servers, and
          on macOS that is how it works today: the app is a real mail client that
          connects to your own IMAP server and organises your mailbox on your
          machine, with no ohmail server in the loop. It makes one signed check
          for its own updates, and can optionally sign in to ohmail Cloud; the
          default local mode talks only to your mail server and that update feed.
          No telemetry, no analytics. The Windows and Linux builds are still the
          interface running on a fictional mailbox, with only that same update
          check, while their engine lands. The interface-only demo on this site
          makes no network calls at all.
        </p>
        <p>
          Your mailbox stays the original. ohmail Cloud holds a synced{" "}
          <em>copy</em>: everything it stores also exists on your own IMAP
          server, the organising ohmail does is written back there as real
          folders, and cancelling leaves that mailbox exactly as it is. Leaving
          is not a migration.
        </p>
        <p>
          That copy is a full one — bodies, headers, subjects and senders, not
          only metadata — on EU servers, solely to provide sync, push and
          search. It is encrypted at rest and your
          mailbox credentials are additionally encrypted at the application
          level, but the mail itself is not: it is <strong>not</strong>{" "}
          end-to-end encrypted, and a small number of people with production
          database access could technically read it.
        </p>
        <p>
          Attachments you send from the web app are handled separately, and the
          size of the file decides how. A small one travels inside the send
          request and is never written down. A larger one is uploaded first to
          private storage on the same EU infrastructure, and the send then
          fetches it from there — so those bytes exist at rest for a short
          window. They are encrypted at rest, no public or anonymous access is
          granted to that storage, and they are deleted within 24 hours whether
          the message was sent or not. Nothing on your account records them
          afterwards. On ohmail Desktop in its default local mode this does not
          apply at all: attachments go from your machine to your own mail server
          and touch no ohmail server.
        </p>
        <p>
          Connections between your devices and ohmail use TLS, and so does the
          connection onward to your own mail provider: implicit TLS on the
          secure ports (993 and 465), a required STARTTLS upgrade on the
          submission ports (143 and 587), certificates verified, and TLS 1.2 as
          the minimum version. A provider that offers no encryption, or whose
          certificate does not validate, fails to connect rather than being
          used anyway — ohmail will not send your mailbox password over a
          connection that never became encrypted. The one exception is a mail
          server on ohmail&rsquo;s own machine, which is how the test suite
          runs and is never a real provider.
        </p>
        <p>
          Optional AI features send message content to Anthropic under
          commercial API terms: your mail is never used to train models, and
          Anthropic retains requests only briefly under its standard policy
          (currently up to 30 days). We have not negotiated a zero-retention
          agreement and do not claim one.
        </p>
        <p>
          Where mail carries a credential — a verification code, a login link, a
          password-reset token — the credential itself is removed before any AI
          request is built. That redaction applies only to what leaves for a
          model, never to what is kept or shown: your own copy of the message is
          never redacted — you read your own code in full — and on the way to a
          model it goes a little further: opaque tokens are blanked
          out of every link in the message, including the ones a marketing
          click-tracker has wrapped. So there is no version of the message with
          the credential in it going anywhere. That is a detector, not a proof: it
          recognises authentication wording in twenty-four languages and blanks
          code-shaped and token-shaped runs, and the way it fails is by blanking
          an order number, not by sending a code.
        </p>
        <p>
          What is <em>not</em> withheld is the subject matter. If you ask ohmail
          to suggest where a sender belongs, a message about a password reset is
          read as a message about a password reset — with the token gone. That
          changed on 8 August 2026, and it is a deliberate narrowing of an
          earlier promise: this page used to say such mail was kept away from a
          model entirely. It was, and the effect was that a detector decided on your
          behalf that a feature you had asked for and paid for would not run,
          for 293 of one account&rsquo;s 1,698 waiting senders. AI still runs
          only where you turn it on, and automatic background routing — the
          filing that happens without anyone pressing anything — does not send
          this class of mail to a model at all. On 3 August 2026, 183 messages
          from the founder&rsquo;s own mailbox — the only mail on our servers at
          the time — were classified this way in production; no other account has
          had mail sent to Anthropic.
        </p>
        <p>
          Who processes what, where, and for how long is published in full on the{" "}
          <a href="/subprocessors">subprocessors and retention</a> page — including
          how account deletion works. Real mailboxes are connected: there is
          customer mail on our servers now, and everything on this page describes
          it. The longer legal document — lawful bases, transfer mechanisms, the
          formal processor register — is still being written, and this page is
          what is true in the meantime rather than a placeholder for it.
        </p>
      </div>

      <a className="btn" href="/">
        Back to ohmail.app
      </a>
    </main>
  );
}
