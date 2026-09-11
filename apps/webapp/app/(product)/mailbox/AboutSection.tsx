"use client";

/**
 * Settings → About ohmail. It was the (i) panel — a floating dialog over the mail; the content was right and
 * the container was not: these are facts about the installation, and facts are what a settings screen is. Here:
 * which mailbox is connected and when it last synced, which build runs, who publishes this — nothing else.
 * `lastSyncAt` is reported exactly as the server states it, including `null`: a mailbox connected thirty
 * seconds ago has genuinely never synced, and "just now" would be a lie. Publisher facts are not translated
 * (the imprint's rule: binding legal text, taken from that page, never re-worded); headings and link labels are
 * this pane's own chrome and read the catalogue — labels from the `footer` namespace, one label set for one set
 * of documents. In THIS file, not `SettingsView`: a standalone install passes no `aboutSection`, gets no pane.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { SettingsRow, SettingsSection } from "@ohmail/ui";
import { accountHeaderCapability, apiConfigured, mailboxes as mailboxApi, messageOf, type MailboxDTO } from "../../api-client";
import { SELF_HOST_BUILD, serverHello } from "../../hello";

/** Inlined by `next.config.mjs` from the commit sha — see `buildIdentity` there. */
const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "dev";
/**
 * The RELEASE, inlined by `next.config.mjs` from the workspace's `package.json` (`appVersion`). No
 * `?? "dev"`, and the difference from the line above is the whole reason this comment exists: the
 * build sha genuinely IS "dev" when there is no commit to name, so a fallback there states a true
 * fact; a version has no honest default — the number exists in the source of every build, so a
 * fallback could only fire when the inlining broke, and would then print a version that is not
 * this one, in the one place a person looks to find out which release they are running.
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
         * A failed read is not an empty result — this comment was the claim under test, and it was
         * false: it said "The panel says 'could not read' rather than showing nothing", but no such
         * sentence exists in the `about` namespace, and `setItems([])` actually produced
         * `mailboxLine`'s "No mailbox connected. Settings → Mailboxes." — the opposite claim
         * stated as fact, pointing the reader at a pane to fix a problem they do not have. The
         * sentence is the SERVER'S, not one invented here (`api-client.ts`: a second copy of the
         * taxonomy is how somebody is told the wrong thing about why), which also keeps the fix
         * inside `app/**` — the `about` namespace is not this change's to add a key to.
         */
        if (alive.current) { setItems(null); setFailure(messageOf(err)); }
      }
    })();
  }, []);

  /*
   * WHAT THE SERVER SAID ABOUT NAMING ITS ANSWERS. Read through `serverHello`, which is the only
   * thing that writes it, so this pane cannot invent the answer or infer it from having seen a
   * header. One extra `/hello` when somebody opens About is the cheapest request the API has, and
   * it is the request whose whole purpose is this question.
   */
  const [namesAccount, setNamesAccount] = useState<boolean | null>(() => accountHeaderCapability());
  useEffect(() => {
    let live = true;
    void serverHello().then(() => { if (live) setNamesAccount(accountHeaderCapability()); });
    return () => { live = false; };
  }, []);

  /* A TABLE OF FACTS, LIKE EVERY OTHER SETTINGS PANE — which is what this one had stopped being.
     It was five loose paragraphs and two `<h3>`s: a mailbox sentence, a version, a keyboard hint
     and an address block, each floating with nothing naming it, so the one pane whose whole job is
     to answer "what am I running and who wrote it" gave no way to find any single answer in it.
     `SettingsRow` is the shape the rest of Settings reads in — label left, fact right, a rule
     between — and the three facts that had no heading now carry one. Nothing here changed its
     words; the publisher block is still the imprint's own text, verbatim (see the header). */
  return (
    <SettingsSection className="about-pane">
      <SettingsRow
        label={t("mailboxesLabel")}
        description={
          failure === null ? (
            mailboxLine(items, t)
          ) : (
            <span role="alert">{failure}</span>
          )
        }
      />
      {/* ONE VALUE, TWO FACTS, and one copy key. "0.7.1 · build 1635001" — the release is what a
          person means when they ask which version they are on, and the sha is what makes two
          reports of the same version distinguishable. Splitting them would put a lone
          seven-character string in a row of its own with nothing to read it against. */}
      <SettingsRow label={t("buildLabel")} value={t("build", { version: VERSION, build: BUILD })} />
      <SettingsRow label={t("keyboardLabel")} description={t("keys")} />

      {/* ── THE ONE CHECK THIS INSTALL CANNOT MAKE, SAID OUT LOUD ─────────────────────────────
          `api()` refuses an answer that does not name the account it was produced for — but only
          where the server advertises that it names them. Requiring it everywhere would make this
          client unusable against any server that predates the header, so the requirement is
          negotiated; the cost of negotiating is that on such a server one guard is off.

          That cost is disclosed rather than carried quietly. Absent from a server that DOES
          advertise it, and absent while nobody has asked yet — a failed `/hello` is not evidence
          about a server, and a row appearing on a network blip would teach people to ignore it. */}
      {namesAccount === false ? (
        <SettingsRow
          label={t("accountHeaderLabel")}
          description={<span role="status">{t("accountHeaderMissing")}</span>}
        />
      ) : null}

      {/* The publisher. Same facts as ohmail.app/imprint, written the same way — see the
          header for why the FACTS are not translated (the heading and the link labels are). */}
      <SettingsRow
        label={t("publishedBy")}
        description={
          <>
            TrafficFlow GmbH
            <br />
            Staubstrasse 1, 8038 Zürich, Switzerland
            <br />
            UID CHE&#8209;364.165.705 · Commercial Register, Canton of Zurich
            <br />
            <a href="mailto:support@ohmail.app">support@ohmail.app</a>
          </>
        }
      />

      {/* WHERE TO READ WHAT WE DO WITH YOUR MAIL — on the deployment where that question has
          an answer we can give. These three documents describe the HOSTED service: its
          controller, its subprocessors, its imprint. A self-host build does not serve them at
          all (`app/self-host-marketing.ts` — they would be false on an origin we neither run
          nor can see), so linking them there would be three links to a 404 and, worse, an
          offer to explain a policy that does not govern the install the reader is looking at.
          What happens to mail on somebody's own server is between them and whoever runs it;
          the honest thing for this pane to do about it is nothing. The label goes with the
          links — a row header over an empty block is its own small lie. */}
      {SELF_HOST_BUILD ? null : (
        <SettingsRow
          label={t("yourMail")}
          control={
            <span className="about-links">
              <Link href="/privacy">{tf("privacy")}</Link>
              <Link href="/subprocessors">{tf("subprocessors")}</Link>
              <Link href="/imprint">{tf("imprint")}</Link>
            </span>
          }
        />
      )}
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
