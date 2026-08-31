import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";

/**
 * The three-view model — the page's second beat, straight after the live demo.
 *
 * The hero promises "only mail you said yes to"; this section says where everything
 * goes instead: Ohbox for people, Reads for the reading pile, Receipts for the
 * paperwork. The proof is the app itself: one still per pile, captured from the same
 * demo mailbox the visitor can click in the section above — the caption says so,
 * because imagery beside a live demo must not pretend to be the live demo.
 *
 * A triptych, not a half-column vignette: at half width a full app window turns to
 * mush, and the model is three-parted anyway. Each column is the pile's own list
 * pane over its name and its one-sentence job — the Everyday list's typographic
 * register (terms over hairlines, no tiles) with a picture on top.
 */
/* Each pile has a light and a dark capture of the same pane, and the page shows the one
   that matches its theme. The swap is CSS on the page's own theme mechanics (`data-theme`
   first, `prefers-color-scheme` while no explicit choice is stamped — the same three-state
   rule the wash tokens follow), so a `<picture>` media query, which cannot see the
   attribute, was not an option. The hidden capture is `loading="lazy"` and `display:
   none`, so a browser never fetches the theme it is not showing. */
/* …and the same rule again for the FACE axis: each pile carries four captures — paper and
   ohmarchy, light and dark — and `landing-face.css` hides the face that is not worn (the
   `.l-fimg` mechanism), while the scheme rule keeps deciding within the worn face. The
   ohmarchy captures come from the automated pipeline (apps/webapp/scripts/landing-shots.mjs),
   the paper ones are the original set, untouched. */
const PILES = [
  {
    id: "ohbox",
    img: "/landing/pile-ohbox.webp",
    dark: "/landing/pile-ohbox-dark.webp",
    oh: "/landing/pile-ohbox-oh.webp",
    ohDark: "/landing/pile-ohbox-oh-dark.webp",
  },
  {
    id: "reads",
    img: "/landing/pile-reads.webp",
    dark: "/landing/pile-reads-dark.webp",
    oh: "/landing/pile-reads-oh.webp",
    ohDark: "/landing/pile-reads-oh-dark.webp",
  },
  {
    id: "receipts",
    img: "/landing/pile-receipts.webp",
    dark: "/landing/pile-receipts-dark.webp",
    oh: "/landing/pile-receipts-oh.webp",
    ohDark: "/landing/pile-receipts-oh-dark.webp",
  },
] as const;

/* The captures' intrinsic size: list-pane crops at 2× device pixels (760×1120),
   displayed at roughly a third of the 1010px row — ~2.3× density, so the pane
   text stays crisp on retina. All three share one geometry; a guard fails if any
   of the capture files is missing. */
const PILE_STILL = { width: 760, height: 1120 } as const;

export function Views() {
  const t = useTranslations("views");
  return (
    <section className="l-views" aria-labelledby="views-title">
      <Reveal className="l-sec-head">
        <h2 id="views-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>

      <Reveal as="div" className="l-views-keys" delay={90}>
        <dl className="l-views-list">
          {PILES.map((p) => (
            <div className="l-views-item" key={p.id}>
              <img
                className="l-views-still l-fimg is-paper is-light"
                src={p.img}
                width={PILE_STILL.width}
                height={PILE_STILL.height}
                alt={t(`${p.id}Alt`)}
                loading="lazy"
                decoding="async"
              />
              <img
                className="l-views-still l-fimg is-paper is-dark"
                src={p.dark}
                width={PILE_STILL.width}
                height={PILE_STILL.height}
                alt={t(`${p.id}Alt`)}
                loading="lazy"
                decoding="async"
              />
              <img
                className="l-views-still l-fimg is-oh is-light"
                src={p.oh}
                width={PILE_STILL.width}
                height={PILE_STILL.height}
                alt={t(`${p.id}Alt`)}
                loading="lazy"
                decoding="async"
              />
              <img
                className="l-views-still l-fimg is-oh is-dark"
                src={p.ohDark}
                width={PILE_STILL.width}
                height={PILE_STILL.height}
                alt={t(`${p.id}Alt`)}
                loading="lazy"
                decoding="async"
              />
              <dt>{t(`${p.id}Term`)}</dt>
              <dd>{t(`${p.id}Body`)}</dd>
            </div>
          ))}
        </dl>
        <p className="l-views-cap">{t("caption")}</p>
      </Reveal>
    </section>
  );
}
