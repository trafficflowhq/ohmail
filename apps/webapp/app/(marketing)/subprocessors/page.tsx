import type { Metadata } from "next";
import { Wordmark } from "../components/Wordmark";

export const metadata: Metadata = {
  title: "Subprocessors — ohmail",
  robots: { index: false },
};

/* Legal content is intentionally NOT routed through i18n — it is the binding
 * legal text of the Swiss operator and changes only deliberately.
 *
 * SCOPE. This page is FACTS, which is why it publishes ahead of the product
 * privacy policy rather than inside it: who processes what, where, and for how
 * long. It needed no lawyer to write and it needs none to read. The full product
 * privacy policy — legal bases, transfer mechanisms, data-subject procedure —
 * publishes before the first real mailbox connects, and it will point here for
 * the list rather than restate it.
 *
 * MAINTENANCE RULE: a new vendor that touches customer data is added HERE on the
 * day it is wired, not on the day someone remembers. Retention rows are defaults;
 * counsel confirms the wording of the transfer basis, not the numbers. */
export default function SubprocessorsPage() {
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
          for Cloud. On macOS the app is already a real mail client, running
          against your own server rather than ours; the Windows and Linux builds
          hold no mail yet, their engine still landing.
        </p>
        <p>
          Some of these are not processing anything yet. Two mailboxes are
          connected, both the founder&rsquo;s own, and on 3 August 2026 Anthropic
          processed 183 of those messages — sender, subject and the first 200
          characters — to classify them. No other customer mail has been sent to
          it. Stripe has taken no payment. They are listed regardless, because
          this page is meant to be complete before it is flattering, and because
          a subprocessor added quietly on the day it starts processing is exactly
          the thing this page exists to prevent.
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
                <th scope="row">Neon</th>
                <td>The database</td>
                <td>Your mail, rules, tags, notes, account</td>
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
                <td>As long as your account exists, then 30 days in backups</td>
              </tr>
              <tr>
                {/* The tracker blocker is not switched on in the reading path, so nothing
                    writes this table today. Saying "until you delete your account" implied a
                    record that does not exist. State the truth until the blocker ships, then restore
                    the retention line in the same change that starts producing rows. */}
                <th scope="row">Blocked-tracker records</th>
                <td>None — the tracker blocker is not switched on yet</td>
              </tr>
              <tr>
                <th scope="row">Sign-in links and challenges</th>
                <td>5 minutes</td>
              </tr>
              <tr>
                <th scope="row">Sign-in sessions</th>
                <td>
                  A session refreshes while you use it, so using ohmail keeps you
                  signed in. In a browser it stops after 90 days without use; the
                  desktop app renews on every launch and stops after 400 days
                  without use. Signing out, or removing a device, ends it
                  immediately. The rows go when you delete your account — no
                  automatic expiry yet
                </td>
              </tr>
              <tr>
                <th scope="row">Sync change log</th>
                <td>
                  Until you delete your account — no automatic expiry yet
                </td>
              </tr>
              <tr>
                <th scope="row">Billing records</th>
                <td>10 years, pseudonymised (Swiss CO art. 958f)</td>
              </tr>
              <tr>
                <th scope="row">Backups</th>
                <td>30 days maximum, then they expire on their own</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          &ldquo;No automatic expiry yet&rdquo; means exactly that, and we would
          rather write it than publish a period no job enforces. Today the only
          time-based deletion that actually runs is the sweep of expired
          idempotency keys; everything else is removed when you delete your
          account, which erases it in one transaction. Shortening those three to
          real, enforced windows is queued work, and this table changes the day
          each sweep ships — not before.
        </p>

        <h2>Deleting your account</h2>
        <p>
          Deleting your account removes every user, mailbox, message, body,
          credential, rule, tag and note from live systems immediately, and from
          backups when those backups expire — within 30 days. What survives is the
          billing record, under a random account id with no name attached: Swiss
          law requires a business to keep its books, and a money trail that can be
          deleted on request is not a money trail.
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
          reach production data — publishes before the first real mailbox
          connects. Until then no customer mail exists on our servers to describe.
        </p>
      </div>

      <a className="btn" href="/privacy">
        Website privacy policy
      </a>
    </main>
  );
}
