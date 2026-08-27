import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { GITHUB_REPO_URL } from "../github";
import { PROFILE_SPEC_URL } from "./GetOhmail";

/**
 * The rows, in reading order. `open` leads: whether the code can be read at all is the
 * first fact about whose product it is, and every row under it is checkable BECAUSE of
 * it. `settings` sits between "where the organization lives" and "if you leave" because
 * it is the bridge between them: the rules and screening decisions live in the mailbox
 * itself (the portable organizer profile, plain JSON in a published format), which is
 * what makes the leave row true of the configuration and not only of the folders.
 * `desktop` replaced the old `offline` row: "offline & local" was only ever true of the
 * desktop app, so the row now names the thing it is about — a real mail client with the
 * engine inside, against a window around somebody's web app.
 *
 * Two rows carry a link, and each link is a contract with the public repository's
 * layout: the code itself, and the specification of the format the settings are stored
 * in (`docs/organizer-profile.md`, the same path the Get-ohmail close points at).
 */
const ROWS: ReadonlyArray<{ id: string; link?: { href: string; key: string } }> = [
  { id: "open", link: { href: GITHUB_REPO_URL, key: "openLink" } },
  { id: "addresses" },
  { id: "folders" },
  { id: "settings", link: { href: PROFILE_SPEC_URL, key: "settingsLink" } },
  { id: "leave" },
  { id: "desktop" },
  { id: "ai" },
];

/**
 * The restrained us-vs-them table. Axis: ohmail works on the mailbox you
 * already own; the others add a layer you live inside. Hairline rows
 * (Blanc's deliberate hairlines, like the FAQ), zero bashing — every
 * cell is a checkable fact.
 *
 * ONE competitor column, deliberately generic ("Other similar products").
 * The table used to name products in two columns; the names were removed
 * from the whole landing deliberately — the argument is about the MODEL
 * (your mailbox vs. living inside theirs), and a name adds heat without
 * adding a fact. Each generic cell is phrased to be true of both shapes
 * that model takes: services your mail moves into, and overlays that only
 * work on a provider or two. `compare.note` still dates the comparison,
 * per each product class's own published documentation.
 *
 * Markup is column-label-per-cell (visually hidden on wide viewports,
 * shown on small ones) so the rows read correctly stacked at 390px and
 * in screen readers, without faking table semantics across breakpoints.
 */
export function Compare() {
  const t = useTranslations("compare");
  return (
    <section className="l-compare" aria-labelledby="compare-title">
      <Reveal className="l-sec-head">
        <h2 id="compare-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>

      <Reveal as="div" className="l-cmp" delay={90}>
        {/* visual column headers for the wide layout only; each cell
            below carries its own (usually hidden) label for a11y+mobile */}
        <div className="l-cmp-head" aria-hidden="true">
          <span />
          <span className="l-cmp-col is-us">{t("colUs")}</span>
          <span className="l-cmp-col">{t("colOthers")}</span>
        </div>
        <ul className="l-cmp-rows">
          {ROWS.map((r) => (
            <li className="l-cmp-row" key={r.id}>
              <h3 className="l-cmp-crit">{t(`${r.id}Crit`)}</h3>
              <p className="l-cmp-cell is-us">
                <b className="l-cmp-who">{t("colUs")}</b>
                <svg className="ic l-cmp-ic" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.4 8.4l3 3 6.2-7" />
                </svg>
                {t(`${r.id}Us`)}
                {r.link ? (
                  <a className="l-cmp-link" href={r.link.href} rel="noreferrer">
                    {t(r.link.key)}
                  </a>
                ) : null}
              </p>
              <p className="l-cmp-cell">
                <b className="l-cmp-who">{t("colOthers")}</b>
                {t(`${r.id}Others`)}
              </p>
            </li>
          ))}
        </ul>
        {/* the as-of note is a fact about the table; the goodwill line is
            the frame around it — said once at the top, once here, because
            a comparison table with no warmth in it reads as an attack */}
        <p className="l-cmp-note">{t("note")}</p>
        {/* the positive close: the table says what the others do, this says
            what we do — the one paragraph in the section that is only about
            ohmail, sitting between the facts and the goodwill frame */}
        <p className="l-cmp-us">{t("usLine")}</p>
        <div className="l-cmp-goodwill">
          <b>{t("goodwillTitle")}</b>
          <p>{t("goodwill")}</p>
        </div>
      </Reveal>
    </section>
  );
}
