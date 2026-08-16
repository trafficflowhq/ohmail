import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { SearchDemo } from "./SearchDemo";

/**
 * The feat-shaped proof sections: copy beside a "vignette" — a Blanc-material
 * sketch of the actual feature (panels, lift shadows, token palette; no stock
 * art), or, for dark mode, two captures of a real message. Sides alternate
 * for rhythm across the whole page, so each section carries its own flip and
 * `page.tsx` owns the order — the story lives there, not here.
 *
 * Exported individually since the reorder interleaved them with the wide
 * sections (Views, Providers, Compare, …); `.l-features` blocks in page.tsx
 * carry the shared grid rhythm the old single wrapper used to.
 */

function Check() {
  return (
    <svg className="ic l-pt-ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.4 8.4l3 3 6.2-7" />
    </svg>
  );
}

/* ── The Screener ritual ─────────────────────────────────────────── */

export function Screener() {
  const t = useTranslations("siteScreener");
  return (
    // flipped: the run opens right after the (centered) Views section, and the
    // AI section that follows carries its copy on the left — this one takes
    // the right so the two mechanisms alternate.
    <section className="l-feat l-feat-flip" aria-labelledby="feat-screener">
      <Reveal className="l-feat-copy">
        <h2 id="feat-screener" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-feat-body">{t("body")}</p>
        <ul className="l-points">
          <li>
            <Check />
            {t("pointA")}
          </li>
          <li>
            <Check />
            {t("pointB")}
          </li>
          <li>
            <Check />
            {t("pointC")}
          </li>
        </ul>
      </Reveal>
      <Reveal className="l-feat-vig" delay={120}>
        <div className="l-vig" aria-hidden="true">
          <div className="l-vig-screener">
            <div className="l-vig-from">
              <i className="l-vig-av">LN</i>
              <span className="l-vig-who">
                <small>{t("illusFrom")}</small>
                <b>{t("illusSender")}</b>
              </span>
            </div>
            <div className="l-vig-lines">
              <i style={{ width: "86%" }} />
              <i style={{ width: "64%" }} />
              <i style={{ width: "74%" }} />
            </div>
            {/* every door the real Screener offers — Receipts included; the
                suggested one is pre-lit and one key accepts it */}
            <div className="l-vig-decide">
              <span className="l-vig-dest is-suggested">
                <svg className="ic" viewBox="0 0 16 16">
                  <path d="M8 1.8l1.6 4.2 4.4.3-3.4 2.8 1.1 4.3L8 11l-3.7 2.4 1.1-4.3L2 6.3l4.4-.3z" />
                </svg>
                {t("illusYes")}
              </span>
              <span className="l-vig-dest">{t("illusReads")}</span>
              <span className="l-vig-dest">{t("illusReceipts")}</span>
              <span className="l-vig-dest is-never">{t("illusNo")}</span>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ── Organized in place — the no-lock-in differentiator ──────────── */

export function InPlace() {
  const t = useTranslations("inplace");
  return (
    <section className="l-feat l-feat-flip" aria-labelledby="feat-inplace">
      <Reveal className="l-feat-copy">
        <h2 id="feat-inplace" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-feat-body">{t("body")}</p>
        <p className="l-compare">{t("compare")}</p>
        <p className="l-promise">{t("promise")}</p>
      </Reveal>
      <Reveal className="l-feat-vig" delay={120}>
        <div className="l-vig" aria-hidden="true">
          <div className="l-vig-server">
            <div className="l-vig-srv-head">
              <svg className="ic" viewBox="0 0 16 16">
                <rect x="2" y="2.5" width="12" height="4.6" rx="1.4" />
                <rect x="2" y="8.9" width="12" height="4.6" rx="1.4" />
                <circle cx="4.6" cy="4.8" r="0.4" fill="currentColor" />
                <circle cx="4.6" cy="11.2" r="0.4" fill="currentColor" />
              </svg>
              {t("illusServer")}
            </div>
            <ul className="l-vig-folders">
              {(["illusFolderA", "illusFolderB", "illusFolderC", "illusFolderD"] as const).map(
                (k) => (
                  <li key={k}>
                    <svg className="ic" viewBox="0 0 16 16">
                      <path d="M1.8 4.4a1.4 1.4 0 0 1 1.4-1.4h3l1.5 1.7h5.1a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z" />
                    </svg>
                    {t(k)}
                    <i className="l-vig-live" />
                  </li>
                ),
              )}
            </ul>
          </div>
          <svg className="l-vig-link" viewBox="0 0 40 84" aria-hidden="true">
            <path d="M20 2 v56" />
            <path d="M14 52l6 7 6-7" />
          </svg>
          <div className="l-vig-client">
            <span className="l-vig-client-dot" />
            {t("illusClient")}
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ── Fast everywhere ─────────────────────────────────────────────── */

export function Fast() {
  const t = useTranslations("fast");
  return (
    <section className="l-feat l-feat-flip" aria-labelledby="feat-fast">
      <Reveal className="l-feat-copy">
        <h2 id="feat-fast" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-feat-body">{t("body")}</p>
        <ul className="l-points">
          <li>
            <Check />
            {t("pointA")}
          </li>
          <li>
            <Check />
            {t("pointB")}
          </li>
          <li>
            <Check />
            {t("pointC")}
          </li>
        </ul>
      </Reveal>
      <Reveal className="l-feat-vig" delay={120}>
        <div className="l-vig">
          <SearchDemo />
        </div>
      </Reveal>
    </section>
  );
}

/* ── Dark mode, including the mail itself ────────────────────────── */

/**
 * The one section whose imagery is allowed to be dark — that is its subject.
 * Not a sketch: two captures of the SAME real message from the demo mailbox,
 * the sender's light original behind, the dark adaptation in front. The pair
 * is the claim ("the message itself, adapted, not inverted") made visible;
 * the page around it stays in whichever theme the visitor chose, so on the
 * light page the dark card is the contrast and on the dark page the light
 * card is.
 */
export function DarkMode() {
  const t = useTranslations("dark");
  return (
    <section className="l-feat" aria-labelledby="feat-dark">
      <Reveal className="l-feat-copy">
        <h2 id="feat-dark" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-feat-body">{t("body")}</p>
        <ul className="l-points">
          <li>
            <Check />
            {t("pointA")}
          </li>
          <li>
            <Check />
            {t("pointB")}
          </li>
          <li>
            <Check />
            {t("pointC")}
          </li>
        </ul>
      </Reveal>
      <Reveal className="l-feat-vig" delay={120}>
        <div className="l-duo">
          <img
            className="l-duo-img is-light"
            src="/landing/mail-light.webp"
            width={572}
            height={466}
            alt={t("imgLightAlt")}
            loading="lazy"
            decoding="async"
          />
          <img
            className="l-duo-img is-dark"
            src="/landing/mail-dark.webp"
            width={688}
            height={560}
            alt={t("imgDarkAlt")}
            loading="lazy"
            decoding="async"
          />
        </div>
      </Reveal>
    </section>
  );
}
