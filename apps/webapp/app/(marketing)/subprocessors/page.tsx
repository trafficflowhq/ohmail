import type { Metadata } from "next";
import { Wordmark } from "../components/Wordmark";
import { legalRobots } from "../legal-robots";
import { refuseOnSelfHost } from "../../self-host-marketing";

export const metadata: Metadata = {
  title: "Subprocessors — ohmail",
  // Same rule as the imprint's: noindex only while the site is a pre-launch waitlist.
  robots: legalRobots(),
};

/* Legal content is intentionally NOT routed through i18n — it is the binding legal text of the
 * Swiss operator and changes only deliberately. SCOPE: this page is FACTS — who processes what,
 * where, for how long — which is why it publishes ahead of the product privacy policy rather than
 * inside it; the full policy (legal bases, transfer mechanisms, data-subject procedure) publishes
 * before the first real mailbox connects and will point here for the list. MAINTENANCE RULE: a new
 * vendor that touches customer data is added HERE on the day it is wired, not the day someone
 * remembers; retention rows are defaults — counsel confirms the wording of the transfer basis, not
 * the numbers.
 */
export default function SubprocessorsPage() {
  /* NOT SERVED ON A SELF-HOST BUILD. This page is FACTS about who processes data for
     ohmail.app — the vendors we contract with. An operator's install has its own hosting and
     none of ours, so every row here would be a false statement about their processing. */
  refuseOnSelfHost();
  return (
    <main className="l-legal l-legal-wide">
      <a className="l-legal-brand" href="/">
        <Wordmark />
      </a>
      <h1 className="l-legal-title">Subprocessors and retention</h1>

      <div className="l-legal-body">
        <p>
          ohmail Cloud is operated by TrafficFlow GmbH, Staubstrasse 1, 8038
          Zürich, Switzerland (
          <a href="mailto:support@ohmail.app">support@ohmail.app</a>). Running it
          means using other companies. Here is every one of them, what it holds,
          and where.
        </p>
        <p>
          <strong>ohmail Desktop uses none of this.</strong> It has no account and
          no server of ours: nothing on this page touches you if you never sign up
          for Cloud. On macOS, Windows and Linux alike the app is a real mail
          client, running against your own server rather than ours.
        </p>
        <p>
          Not all of these are processing on any given day. They are listed
          regardless, because this page is meant to be complete before it is
          flattering, and because a subprocessor added quietly on the day it
          starts processing is exactly the thing this page exists to prevent.
        </p>

        <h2>Subprocessors</h2>
        <div className="l-legal-scroll">
          <table className="l-legal-table">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">What it does for us</th>
                <th scope="col">Data it can hold</th>
                <th scope="col">Where</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Supabase</th>
                <td>The database, and storage for large attachments you send</td>
                <td>Your mail, rules, tags, notes, account</td>
                <td>Switzerland (Zurich)</td>
              </tr>
              <tr>
                {/* Listed while it still holds the copy; the row goes in the change that deletes it. */}
                <th scope="row">Neon</th>
                <td>
                  The former database, frozen since the move to Supabase on 3
                  August 2026; to be deleted
                </td>
                <td>
                  A copy of mail, rules, tags, notes and accounts, and of waitlist and
                  invitation addresses, as of the move
                </td>
                <td>EU (Frankfurt)</td>
              </tr>
              <tr>
                <th scope="row">Vercel</th>
                <td>Website and API hosting</td>
                <td>Requests in transit; connection logs</td>
                <td>USA</td>
              </tr>
              <tr>
                <th scope="row">Railway</th>
                <td>The sync worker</td>
                <td>Your mail, while it is being fetched and filed</td>
                <td>EU</td>
              </tr>
              <tr>
                <th scope="row">Anthropic</th>
                <td>The AI model</td>
                <td>Message content sent for a suggestion or a draft</td>
                <td>USA</td>
              </tr>
              <tr>
                <th scope="row">Stripe</th>
                <td>Payments</td>
                <td>Your billing details. Never your mail.</td>
                <td>USA / EU</td>
              </tr>
              <tr>
                <th scope="row">Resend</th>
                <td>Our own transactional mail to you</td>
                <td>Your address and the message we send you</td>
                <td>USA / EU</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Anthropic processes under commercial API terms: your mail is never used
          to train models, and requests are retained only briefly under its
          standard policy (currently up to 30 days). We have{" "}
          <strong>not</strong> negotiated a zero-data-retention agreement, and we
          will say here when we do. Where mail carries a credential — a
          verification code, a login link, a reset token — the credential is
          removed before the request is built. Your own client shows you the
          message in full — it is your own mail — while the model receives a
          version with the credential removed. Automatic background routing does
          not send that class of mail to a model at all; a suggestion you ask for
          reads it with the code gone.
        </p>

        <h2>How long things are kept</h2>
        <div className="l-legal-scroll">
          <table className="l-legal-table">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Kept for</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Mail, rules, tags, notes</th>
                <td>
                  As long as your account exists. Removing a mailbox erases its
                  mail. Past your plan&rsquo;s storage, the contents of your oldest
                  messages are emptied to make room for new mail; their sender,
                  subject and preview stay.
                </td>
              </tr>
              <tr>
                <th scope="row">The copy in the former database</th>
                <td>Frozen on 3 August 2026; kept until that database is deleted</td>
              </tr>
              <tr>
                <th scope="row">
                  Blocked-tracker records: the tracker&rsquo;s host and the image
                  address taken from your mail
                </th>
                <td>Until you remove the mailbox or delete your account</td>
              </tr>
              <tr>
                <th scope="row">Sign-in links and challenges</th>
                <td>
                  Each works for 5 minutes at most, an email-verification link for
                  24 hours. A passkey challenge&rsquo;s record is deleted from an
                  hour after it expires, at the next passkey sign-in; the other
                  records have no expiry of their own and go when you delete your
                  account, and a desktop sign-in request nobody confirmed is never
                  deleted.
                </td>
              </tr>
              <tr>
                <th scope="row">Sign-in sessions</th>
                <td>
                  A session refreshes while you use it, so using ohmail keeps you
                  signed in. In a browser it stops after 90 days without use at the
                  latest; the desktop app renews on every launch and stops after
                  400 days without use. Signing out, or removing a device, ends it
                  immediately. The rows go when you delete your account — no
                  automatic expiry yet
                </td>
              </tr>
              <tr>
                <th scope="row">Sync change log</th>
                <td>
                  Entries for deleted items and superseded changes are deleted once
                  they are 30 days behind your least recently synced device or
                  browser (one unseen for 90 days no longer holds them back). The
                  first entry for each item you still have, your own moves back to
                  the inbox and the newest entry stay until you delete your account.
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Sign-in history: sign-ins, failed attempts and sign-outs, with the
                  IP address and device
                </th>
                <td>180 days</td>
              </tr>
              <tr>
                <th scope="row">
                  Limits on sign-in attempts: keyed hashes of the address typed and
                  of the IP address
                </th>
                <td>48 hours; for a device that has signed in, 90 days after it last did</td>
              </tr>
              <tr>
                <th scope="row">Action history: what an action changed, so it can be undone</th>
                <td>365 days</td>
              </tr>
              <tr>
                <th scope="row">Attachments uploaded ahead of a send</th>
                <td>
                  24 hours, whether the message was sent or not, then deleted by the
                  next hourly pass
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Stored answers to retried requests, and the guard against sending
                  a message twice
                </th>
                <td>24 hours, then deleted by the next hourly pass</td>
              </tr>
              <tr>
                <th scope="row">After you delete your account: hashes of its sign-in tokens</th>
                <td>
                  Up to 400 days after each token expires, so an app still signed in
                  is told the account is gone
                </td>
              </tr>
              <tr>
                <th scope="row">Billing records</th>
                <td>10 years, pseudonymised (Swiss CO art. 958f)</td>
              </tr>
              <tr>
                <th scope="row">Backups</th>
                <td>
                  The database provider&rsquo;s, expiring on its own schedule; we have
                  not confirmed how long that is, so no number is published here
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A pass runs every hour and deletes what the table says has expired:
          stored answers to retried requests and the double-send guard, sign-in
          attempt limits, staged attachments and the token hashes of deleted
          accounts. It also ages out sign-in and action history and compacts the
          sync change log. Where a row says a record stays until you delete your
          account, there is no automatic expiry yet, and we would
          rather write it than publish a period no job enforces.
        </p>

        <h2>Deleting your account</h2>
        <p>
          Deleting your account removes every user, mailbox, message, body,
          credential, rule, tag and note from live systems immediately, and from
          backups when those backups expire. What survives is the billing record,
          under a random account id with no name attached: Swiss law requires a
          business to keep its books, and a money trail that can be deleted on
          request is not a money trail. For up to 400 days after they expire,
          hashes of the account&rsquo;s sign-in tokens survive too, so an app
          still signed in is told the account is gone.
        </p>
        <p>
          One copy is not covered yet: the former database (Neon, in the table
          above) still holds every account that existed on 3 August 2026,
          including ones deleted since, and the waitlist and invitation addresses
          it held then, until that database is deleted.
        </p>
        <p>
          <strong>The copy we hold is what goes.</strong> The originals were never
          ours: they are on your own IMAP server, in the <code>ohmail/…</code>{" "}
          folders ohmail created there, and deleting your account leaves that
          mailbox exactly as organised as it was.
        </p>
        <p>
          <strong>How to do it:</strong> the control is in the app, under your
          account. It asks for a second factor first — a password alone must not
          be able to erase an account — and the erasure then runs as a single
          database transaction behind a step-up-authenticated endpoint. No
          retention interview, no delay, no email to us required. If you would
          rather we ran it, <a href="mailto:support@ohmail.app">support@ohmail.app</a>{" "}
          still works.
        </p>

        <h2>Reporting a security problem</h2>
        <p>
          Email <a href="mailto:support@ohmail.app">support@ohmail.app</a> with{" "}
          <code>SECURITY</code> in the subject. That address covers this website,
          ohmail.app and the ohmail Cloud backend as well as the open-source
          desktop apps, whose policy is{" "}
          <a href="https://github.com/trafficflowhq/ohmail/blob/main/SECURITY.md">
            published in that repository
          </a>
          . We acknowledge within 5 working days, tell you our assessment and a
          rough timeline, and credit you if you want the credit. We do not run a
          bug bounty, and we will not threaten anyone who reports in good faith.
          Please do not test against other people&rsquo;s accounts or mailboxes.
        </p>
        <p>
          If personal data of yours is ever breached, we will notify the competent
          authority within 72 hours of becoming aware, and you directly where the
          risk to you is high.
        </p>

        <h2>The full policy</h2>
        <p>
          This page is the list. The full product privacy policy — legal bases,
          the mechanism for the two transfers to the USA, the data-subject
          procedure, and the conditions under which a human at TrafficFlow can
          reach production data — is still being written. This page is what is
          true in the meantime rather than a placeholder for it.
        </p>
      </div>

      <a className="btn" href="/privacy">
        Website privacy policy
      </a>
    </main>
  );
}
