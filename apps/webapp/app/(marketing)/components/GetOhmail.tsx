import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/**
 * The mirror's own paths — a contract with the public repository's layout, like the
 * asset filenames in `../downloads.ts` are a contract with the release pipeline. The
 * self-host guide and the profile specification live at these exact paths in
 * `github.com/trafficflowhq/ohmail`; the host-mode anchor is that README's own
 * heading. All three were fetched and answered 200 when this section shipped, and
 * `test/get-ohmail.test.ts` pins the strings so a mirror reorganization fails a test
 * here instead of quietly 404ing the landing.
 */
export const SELF_HOST_GUIDE_URL =
  "https://github.com/trafficflowhq/ohmail/blob/main/docs/self-host/README.md";
export const HOST_MODE_README_URL =
  "https://github.com/trafficflowhq/ohmail#host-your-own-devices-from-your-desktop";
export const PROFILE_SPEC_URL =
  "https://github.com/trafficflowhq/ohmail/blob/main/docs/organizer-profile.md";

/** The three self-run ways, in the order of least machinery: card → where its one link goes. */
const FREE = [
  { id: "standalone", href: "#download", external: false },
  { id: "host", href: HOST_MODE_README_URL, external: true },
  { id: "selfhost", href: SELF_HOST_GUIDE_URL, external: true },
] as const;

/**
 * Get ohmail — the four ways to run it, free ones first.
 *
 * This is the section the nav's "Get ohmail." button lands on, and its order is a
 * decision, not a layout accident: the three ways you run it YOURSELF come first and
 * are presented as complete products, because they are — the code is public under
 * AGPL-3.0 and the hosted service is built from the same repository. Managed hosting
 * follows, clearly separated and framed as exactly what it is: we run the same thing
 * for you, for a monthly price. The page never calls the paid tier "the real version"
 * because the free ones are not demos; saying so plainly IS the pitch.
 *
 * ── THE CLOSE IS THE FLAGSHIP CLAIM ─────────────────────────────────────────────────
 *
 * The section ends on the portable organizer profile, because it is what makes a
 * four-way choice safe to make casually: your settings are stored in the mailbox
 * itself, so moving between these options is reconnecting a mailbox, not migrating a
 * product. The claim names exactly what travels today — screener verdicts, rules,
 * notification choices, the away reply, tag names — never "all settings", and
 * `test/get-ohmail.test.ts` holds that list in agreement with the public README's own
 * "exactly what travels" sentence, which is the claim's source.
 *
 * ── SHAPE ──────────────────────────────────────────────────────────────────────────
 *
 *  · Three lifted panel cards for the self-run ways; a flat tint band for managed —
 *    two registers, so the separation is visible before a word is read. The one
 *    full-bleed accent band on this page stays the trial's (its comment calls it the
 *    page's only change of surface); this band is the same quiet tint as the
 *    comparison table's goodwill close.
 *  · Each card carries ONE link. Standalone points down at the download section that
 *    owns the platform buttons; host mode and self-host point at the public repo's
 *    own documentation — the landing does not restate an operations guide.
 *  · No icons. The base layer's `svg.ic` reset makes every new landing icon a
 *    specificity decision (see landing-story.test.ts's checkmark guards); this
 *    section is type-led and never has to make it.
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

      <Reveal as="p" className="l-get-way" delay={60}>
        {t("wayFree")}
      </Reveal>
      <ul className="l-get-free">
        {FREE.map((c, i) => (
          <Reveal as="li" className="l-get-card" key={c.id} delay={90 + i * 70}>
            <h3 className="l-get-name">
              {t(`${c.id}Name`)}
              {c.id === "standalone" ? <em className="l-opt">{t("standaloneTag")}</em> : null}
            </h3>
            <p className="l-get-body">{t(`${c.id}Body`)}</p>
            <a className="l-get-link" href={c.href} rel={c.external ? "noreferrer" : undefined}>
              {t(`${c.id}Cta`)}
            </a>
          </Reveal>
        ))}
      </ul>

      {/* the managed option: honestly convenient, honestly paid, honestly the same
          product — and one register quieter than the cards above it */}
      <Reveal as="div" className="l-get-managed" delay={120}>
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
        <a className="l-get-link" href={PROFILE_SPEC_URL} rel="noreferrer">
          {t("moveSpec")}
        </a>
      </Reveal>
    </section>
  );
}
