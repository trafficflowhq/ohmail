import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import {
  PROFILE_MESSAGE_EXCERPT,
  PROFILE_MESSAGE_FOLDER,
  PROFILE_MESSAGE_SUBJECT,
} from "./profile-message.data";

/**
 * The mirror's own paths — a contract with the public repository's layout, like the
 * asset filenames in `../downloads.ts` are a contract with the release pipeline. The
 * self-host guides and the profile specification live at these exact paths in
 * `github.com/trafficflowhq/ohmail`; the host-mode anchor is that README's own
 * heading. All four were fetched and answered 200 when their cards shipped, and
 * `test/get-ohmail.test.ts` pins the strings so a mirror reorganization fails a test
 * here instead of quietly 404ing the landing.
 */
export const SELF_HOST_GUIDE_URL =
  "https://github.com/trafficflowhq/ohmail/blob/main/docs/self-host/README.md";
export const UMBREL_GUIDE_URL =
  "https://github.com/trafficflowhq/ohmail/blob/main/docs/self-host/UMBREL.md";
export const HOST_MODE_README_URL =
  "https://github.com/trafficflowhq/ohmail#host-your-own-devices-from-your-desktop";
export const PROFILE_SPEC_URL =
  "https://github.com/trafficflowhq/ohmail/blob/main/docs/organizer-profile.md";

/**
 * The self-host icons — original stroke drawings on the landing's 16-grid, in the base layer's line
 * weight (`svg.ic`: 1.3px, round caps and joins), like the feature checkmarks. Each names the
 * MACHINE its card is about, because the lede says "pick by the machine you have": a closed box
 * for a rented server, a house with rack slots for a box at home, a laptop broadcasting for the
 * desktop already here. They keep `ic` and take their size from the scoped `.l-get-disc .l-sh-ic`
 * rule — never a bare class, which loses to the reset on specificity (see landing-story.test.ts's
 * checkmark guards for the incident this discipline comes from).
 */
function ServerIcon() {
  return (
    <svg className="ic l-sh-ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.9 13.9 5.2v5.6L8 14.1 2.1 10.8V5.2Z" />
      <path d="M2.1 5.2 8 8.4l5.9-3.2M8 8.4v5.7" />
    </svg>
  );
}
function HomeIcon() {
  return (
    <svg className="ic l-sh-ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.8 7.4 8 2.9l5.2 4.5v5.9H2.8Z" />
      <path d="M5.9 9.7h4.2M5.9 11.6h4.2" />
    </svg>
  );
}
function DesktopIcon() {
  return (
    <svg className="ic l-sh-ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.4 6.1h9.2v5H3.4ZM1.9 13.1h12.2" />
      <path d="M5.4 3.1a3.7 3.7 0 0 1 5.2 0M6.9 4.6a1.55 1.55 0 0 1 2.2 0" />
    </svg>
  );
}
/** The managed band's machine is the one that is ours, not yours: a cloud. */
function CloudIcon() {
  return (
    <svg className="ic l-sh-ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11.9 6.7h-.8A5.3 5.3 0 1 0 6 13.2h5.9a3.25 3.25 0 0 0 0-6.5Z" />
    </svg>
  );
}

/**
 * The three self-host ways: card → its one link. Flagship first: the full stack on a
 * server you rent or own, then the home-server box, then the close that costs no new
 * hardware at all — the desktop already on your desk. (The old "least machinery
 * first" order belonged to the free trio this block replaced; a visitor arriving at
 * "Self-host ohmail" from the nav is here for the server.)
 */
const SELF_HOST = [
  { id: "shServer", href: SELF_HOST_GUIDE_URL, icon: <ServerIcon /> },
  { id: "shHome", href: UMBREL_GUIDE_URL, icon: <HomeIcon /> },
  { id: "shDesktop", href: HOST_MODE_README_URL, icon: <DesktopIcon /> },
] as const;

/**
 * Get ohmail — run it yourself first, managed as the convenience. The order is a decision: the ways you run it
 * YOURSELF come first and are presented as complete products, because they are — the code is public under AGPL-3.0
 * and the hosted service is built from the same repository; managed hosting follows, framed as exactly what it is.
 * The free ones are not demos, and saying so plainly IS the pitch.
 */

/**
 * "Self-host ohmail" is its own titled block (owner ask, 2026-08-21) covering exactly the three ways to run ohmail on
 * hardware you own; the desktop app STANDALONE is not self-hosting and keeps its own home above, the managed tier its
 * band below; the block carries `id="selfhost"`. Each card gets one honest sentence: the server card claims a compose
 * file and no account — never prebuilt images, which are not public yet; the Umbrel card says "draft" in so many
 * words; the desktop card names the real pane and keeps "only while the computer is awake".
 */

/**
 * The close is the flagship claim: the portable organizer profile is what makes the choice above safe to make
 * casually — moving between these options is reconnecting a mailbox, not migrating a product. The claim names exactly
 * what travels today (screener verdicts, rules, notification choices, the away reply, tag names), never "all
 * settings"; `test/get-ohmail.test.ts` holds that list in agreement with the public README's own sentence, and under
 * the claim sits its proof — the profile message quoted verbatim (`profile-message.data.ts`).
 */

/**
 * Shape: one wide panel card for the desktop, three lifted cards for self-host, a flat tint band for managed — two
 * registers, so the separation is visible before a word is read; each card carries ONE link (the desktop card points
 * at the download section, the self-host cards at the repo's own documentation); the icons sit in the same tint discs
 * the nav's capsule uses, a face without a new material.
 */
export function GetOhmail() {
  const t = useTranslations("get");
  return (
    <section className="l-get" id="get" aria-labelledby="get-title">
      <Reveal className="l-sec-head">
        <h2 id="get-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>

      {/* the free register opens with the app itself — complete, standalone, not a
          hosting decision */}
      <Reveal as="p" className="l-get-way" delay={60}>
        {t("wayFree")}
      </Reveal>
      <Reveal className="l-get-app" delay={90}>
        <h3 className="l-get-name">
          {t("standaloneName")}
          <em className="l-opt">{t("standaloneTag")}</em>
        </h3>
        <p className="l-get-body">{t("standaloneBody")}</p>
        <a className="l-get-link" href="#download">
          {t("standaloneCta")}
        </a>
      </Reveal>

      {/* self-host: its own titled block, exactly the three ways to run ohmail on
          hardware you own — and the nav's "Self-host" landing place */}
      <section className="l-get-sh" id="selfhost" aria-labelledby="selfhost-title">
        <Reveal>
          <h3 id="selfhost-title" className="l-get-sh-title">
            {t("shTitle")}
          </h3>
          <p className="l-get-sh-lede">{t("shLede")}</p>
        </Reveal>
        <ul className="l-get-sh-grid">
          {SELF_HOST.map((c, i) => (
            <Reveal as="li" className="l-get-card" key={c.id} delay={90 + i * 70}>
              <span className="l-get-disc">{c.icon}</span>
              <h4 className="l-get-name">{t(`${c.id}Name`)}</h4>
              <p className="l-get-body">{t(`${c.id}Body`)}</p>
              <a className="l-get-link" href={c.href} rel="noreferrer">
                {t(`${c.id}Cta`)}
              </a>
            </Reveal>
          ))}
        </ul>
      </section>

      {/* the managed option: honestly convenient, honestly paid, honestly the same
          product — and one register quieter than the cards above it */}
      <Reveal as="div" className="l-get-managed" delay={120}>
        <span className="l-get-disc">
          <CloudIcon />
        </span>
        <p className="l-get-way is-managed">{t("wayManaged")}</p>
        <p className="l-get-q">{t("managedLead")}</p>
        <p className="l-get-mbody">{t("managedBody")}</p>
        <a className="l-get-link" href="#pricing">
          {t("managedCta")}
        </a>
      </Reveal>

      {/* the reason the choice above is safe: the configuration lives in the mailbox,
          not in the tier — the same sentence the public README leads with */}
      <Reveal as="div" className="l-get-move" delay={80}>
        <h3 className="l-get-move-title">{t("moveTitle")}</h3>
        <p>{t("moveBody")}</p>
        {/* the proof under the claim: the message itself, quoted verbatim. The profile
            IS one small message in the mailbox, and its body opens with a letter to
            whoever finds it in an ordinary mail client — the folder showcase's
            restraint again (a real artifact, typographic, no fake chrome): the folder
            it lives in, its real Subject header, one hairline, the letter's first
            paragraph. profile-message.data.ts is diffed against the writer in
            @trafficflow/core by a guard, so this exhibit can never drift into fiction. */}
        <figure className="l-get-msg">
          {/* `lang="en"`: every string inside this sheet is quoted VERBATIM from the
              message the product writes, and a guard diffs it against that writer — so it
              cannot be translated, and on the German landing it would otherwise be spoken
              with German pronunciation rules. The caption below is ours and stays
              outside, in the document's language. */}
          <div className="l-get-msg-sheet" lang="en">
            <p className="l-get-msg-loc">{PROFILE_MESSAGE_FOLDER}</p>
            <p className="l-get-msg-subj">
              <span className="l-get-msg-h">Subject:</span> {PROFILE_MESSAGE_SUBJECT}
            </p>
            <p className="l-get-msg-body">{PROFILE_MESSAGE_EXCERPT}</p>
          </div>
          <figcaption className="l-get-msg-cap">{t("moveMsgNote")}</figcaption>
        </figure>
        <a className="l-get-link" href={PROFILE_SPEC_URL} rel="noreferrer">
          {t("moveSpec")}
        </a>
      </Reveal>
    </section>
  );
}
