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
 * The self-host icons — original stroke drawings on the landing's own 16-grid, in the
 * base layer's line weight (`svg.ic`: 1.3px, round caps and joins), like the feature
 * and comparison checkmarks. Each names the MACHINE its card is about, because the
 * block's lede says "pick by the machine you have": a closed box for a server you
 * rent or own, a house with rack slots for a box at home, a laptop broadcasting for
 * the desktop that is already here. They keep `ic` (they ARE stroke drawings) and
 * take their size from the scoped `.l-get-disc .l-sh-ic` rule — never a bare class,
 * which loses to the reset on specificity (see landing-story.test.ts's checkmark
 * guards for the incident this discipline comes from).
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
 * Get ohmail — run it yourself first, managed as the convenience.
 *
 * This is the section the nav's "Get ohmail." button lands on, and its order is a
 * decision, not a layout accident: the ways you run it YOURSELF come first and are
 * presented as complete products, because they are — the code is public under
 * AGPL-3.0 and the hosted service is built from the same repository. Managed hosting
 * follows, clearly separated and framed as exactly what it is: we run the same thing
 * for you, for a monthly price. The page never calls the paid tier "the real version"
 * because the free ones are not demos; saying so plainly IS the pitch.
 *
 * ── SELF-HOST IS ITS OWN TITLED BLOCK (owner ask, 2026-08-21) ───────────────────────
 *
 * "Self-host ohmail" covers exactly the three ways to run ohmail on hardware you own
 * — a server you rent or own, a home-server box (Umbrel), and the desktop serving
 * your other devices — and nothing else. The desktop app STANDALONE is not
 * self-hosting (nothing is hosted; it is an app), so it keeps its own home above the
 * block; the managed tier is the opposite of self-hosting and keeps its band below.
 * The block carries `id="selfhost"`, which is where the nav's "Self-host" item lands.
 *
 * Honesty in the three sentences, because each card gets exactly one:
 *  · The server card claims a compose file and no account — never prebuilt images or
 *    a pullable registry, which are not public yet (the guide stages that honestly).
 *  · The Umbrel card says "draft" in so many words; the guide separates what works
 *    from what is arriving.
 *  · The desktop card names the real pane (Settings → Devices, held in agreement
 *    with the settings catalogue by a guard) and keeps the honest constraint: only
 *    while the computer is awake.
 *
 * ── THE CLOSE IS THE FLAGSHIP CLAIM ─────────────────────────────────────────────────
 *
 * The section ends on the portable organizer profile, because it is what makes the
 * choice above safe to make casually: your settings are stored in the mailbox
 * itself, so moving between these options is reconnecting a mailbox, not migrating a
 * product. The claim names exactly what travels today — screener verdicts, rules,
 * notification choices, the away reply, tag names — never "all settings", and
 * `test/get-ohmail.test.ts` holds that list in agreement with the public README's own
 * "exactly what travels" sentence, which is the claim's source. Under the claim sits
 * its proof: the profile message itself, quoted verbatim (see the exhibit's comment
 * below and `profile-message.data.ts`).
 *
 * ── SHAPE ──────────────────────────────────────────────────────────────────────────
 *
 *  · One wide panel card for the desktop app; three lifted panel cards for the
 *    self-host ways; a flat tint band for managed — two registers, so the
 *    free/managed separation is visible before a word is read. The one full-bleed
 *    accent band on this page stays the trial's (its comment calls it the page's
 *    only change of surface); the managed band is the same quiet tint as the
 *    comparison table's goodwill close.
 *  · Each card carries ONE link. The desktop card points down at the download
 *    section that owns the platform buttons; the self-host cards point at the public
 *    repo's own documentation — the landing does not restate an operations guide.
 *  · The self-host icons sit in small tint discs — the same tint the nav's star
 *    capsule and the managed band already use, so the cards gain a face without the
 *    page gaining a material.
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
