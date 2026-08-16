"use client";

/**
 * SETTINGS → ABOUT OHMAIL.
 *
 * It was the (i) panel: a floating dock button opening a dialog over the mail. The content
 * was right and the container was not — these are facts about the installation, and facts
 * are what a settings screen is. The dialog is gone; this is the pane it became.
 *
 * ── WHAT GOES HERE ──────────────────────────────────────────────────────────────────────
 *
 * Which mailbox is connected and when it last synced; which build is running; who publishes
 * this and where to read what they do with your mail. Those are the things a person cannot
 * find out any other way. Nothing else — not a description of the sync engine, not a summary
 * of what the app does, not reassurance.
 *
 * `lastSyncAt` is the load-bearing one and it is reported exactly as the server states it,
 * including `null`. A mailbox connected thirty seconds ago has genuinely never synced; the
 * worker runs on its own cycle, and "waiting for the first sync" is the true sentence there.
 * Rendering it as "just now" would be the same class of lie this pane was first fixed for.
 *
 * ── THE PUBLISHER FACTS ARE NOT TRANSLATED, AND THAT IS THE EXISTING RULE ───────────────
 *
 * `app/(marketing)/imprint/page.tsx` states it: *"Legal content is intentionally NOT routed
 * through i18n — it is the binding legal text of the Swiss operator and changes only
 * deliberately."* The same facts appear here, so they are written the same way and taken
 * from that page rather than re-worded. Two renderings of one imprint that can drift is
 * exactly what a translated copy would be.
 *
 * The rule covers the FACTS — the company name, the address, the register entry — and only
 * them. The headings above the facts and the labels on the policy links are this pane's own
 * chrome, and a German session was showing them in English ("Published by" over a German
 * page), so they read the catalogue like every other sentence here. The link labels come from
 * the `footer` namespace rather than a second copy in `about`: they name the same three
 * documents the marketing footer names, and two label sets for one set of documents is the
 * same drift argument as the imprint's, one level up.
 *
 * It also has to live in THIS file rather than in the shared `SettingsView`: the company
 * named is the operator of the hosted service, and a standalone Desktop install has no such
 * operator. Desktop passes no `aboutSection` and gets no pane.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { SettingsSection } from "@ohmail/ui";
import { apiConfigured, mailboxes as mailboxApi, messageOf, type MailboxDTO } from "../../api-client";

/** Inlined by `next.config.mjs` from the commit sha — see `buildIdentity` there. */
const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "dev";
/**
 * The RELEASE, inlined by `next.config.mjs` from the workspace's `package.json` — see
 * `appVersion` there.
 *
 * NO `?? "dev"`, and the difference from the line above is the whole reason this comment exists.
 * The build sha genuinely IS "dev" when there is no commit to name, so a fallback there states a
 * true fact. A version has no such honest default: the number exists in the source of every build
 * and is read from it, so a fallback here could only ever fire when the inlining broke — and it
 * would then print a version that is not this one, in the one place a person looks to find out
 * which release they are running.
 */
const VERSION = process.env.NEXT_PUBLIC_APP_VERSION;

export function AboutSection() {
  const t = useTranslations("about");
  /** The three policy-link labels — the footer's, shared rather than copied (see the header). */
  const tf = useTranslations("footer");
  const [items, setItems] = useState<MailboxDTO[] | null>(null);
  /**
   * A failed read is not an empty result. The server's own sentence when the read was refused, or `null`.
   *
   * A FIFTH state beside {@link mailboxLine}'s four, held here rather than folded into that
   * function, because it is the one line on this panel that does not come from the `about`
   * namespace — see the catch below.
   */
  const [failure, setFailure] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (!apiConfigured()) return;
    void (async () => {
      try {
        const { items: got } = await mailboxApi.list();
        if (alive.current) { setItems(got); setFailure(null); }
      } catch (err) {
        /**
         * ── A FAILED READ IS NOT AN EMPTY RESULT — THIS COMMENT WAS THE CLAIM UNDER TEST, AND IT WAS FALSE ─────────
         *
         * It said *"The panel says 'could not read' rather than showing nothing"*. There is
         * no such sentence in the `about` namespace and there never was; what `setItems([])`
         * actually produced is `mailboxLine`'s **"No mailbox connected. Settings →
         * Mailboxes."** — which is not "could not read", it is the opposite claim stated as
         * fact, and it points the reader at a pane to fix a problem they do not have.
         *
         * The sentence is the SERVER'S, not one invented here, for the reason `api-client.ts`
         * gives: a second copy of the taxonomy in the client is how somebody is told the
         * wrong thing about why. That also keeps this fix inside `app/**` — the `about`
         * namespace in `messages/en.json` is not this change's to add a key to.
         */
        if (alive.current) { setItems(null); setFailure(messageOf(err)); }
      }
    })();
  }, []);

  return (
    <SettingsSection className="about-pane">
      {failure === null
        ? <p className="about-line">{mailboxLine(items, t)}</p>
        : <p className="about-line" role="alert">{failure}</p>}
      {/* ONE LINE, TWO FACTS, and one copy key. "0.7.1 · build 1635001" — the release is what a
          person means when they ask which version they are on, and the sha is what makes two
          reports of the same version distinguishable. Splitting them into two paragraphs would
          put a lone seven-character string on a line of its own with nothing to read it against. */}
      <p className="about-build">{t("build", { version: VERSION, build: BUILD })}</p>
      <p className="about-build">{t("keys")}</p>

      {/* The publisher. Same facts as ohmail.app/imprint, written the same way — see the
          header for why the FACTS are not translated (the headings and link labels are). */}
      <h3 className="acct-sub about-h">{t("publishedBy")}</h3>
      <p className="about-line">
        TrafficFlow GmbH
        <br />
        Staubstrasse 1, 8038 Zürich, Switzerland
        <br />
        UID CHE&#8209;364.165.705 · Commercial Register, Canton of Zurich
      </p>
      <p className="about-line">
        <a href="mailto:support@ohmail.app">support@ohmail.app</a>
      </p>

      <h3 className="acct-sub about-h">{t("yourMail")}</h3>
      <p className="about-line about-links">
        <Link href="/privacy">{tf("privacy")}</Link>
        <Link href="/subprocessors">{tf("subprocessors")}</Link>
        <Link href="/imprint">{tf("imprint")}</Link>
      </p>
    </SettingsSection>
  );
}

type T = ReturnType<typeof useTranslations<"about">>;

/**
 * The one line. Deliberately a function rather than nested ternaries in the JSX: the four
 * states are four different true sentences and each one should be readable on its own.
 */
function mailboxLine(items: MailboxDTO[] | null, t: T): string {
  if (items === null) return t("loading");
  const active = items.filter((m) => m.status !== "disabled");
  if (active.length === 0) return t("noMailbox");

  const first = active[0]!;
  const when = first.lastSyncAt ? absolute(first.lastSyncAt) : null;
  const synced = when === null ? t("neverSynced") : t("syncedAt", { when });

  return active.length === 1
    ? t("oneMailbox", { address: first.address, synced })
    : t("manyMailboxes", { address: first.address, others: active.length - 1, synced });
}

/** The viewer's own locale and zone; not a relative stamp, which would go stale unpainted. */
function absolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
