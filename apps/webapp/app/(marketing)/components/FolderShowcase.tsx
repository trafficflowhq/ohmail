import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { SHOWCASE_FOLDERS, OHMAIL_PARENT_LABEL } from "./folders.data";

/**
 * What a person's IMAP actually looks like once ohmail is organizing it: their
 * Inbox, their provider's own Junk and their Sent folder left untouched, and a
 * small `ohmail/` tree holding the folders ohmail files into. Every name here is
 * a real folder on the real server, visible in any other mail app — which is the
 * whole point of the "organize in place" promise, made concrete.
 *
 * The tree is data (`folders.data.ts`), diffed against the frozen `WATCHED_FOLDERS`
 * set by `test/folder-showcase.test.ts` so a wrong or invented folder name goes red.
 * Typographic, no fake chrome — the same restraint as the Providers strip.
 */
export function FolderShowcase() {
  const t = useTranslations("folders");
  const top = SHOWCASE_FOLDERS.filter((f) => f.group === "top");
  const nested = SHOWCASE_FOLDERS.filter((f) => f.group === "ohmail");

  const tag = (role: string) =>
    role === "untouched" ? t("untouched") : role === "meta" ? t("metaTag") : null;

  return (
    <section className="l-folders" aria-labelledby="folders-title">
      <Reveal className="l-sec-head">
        <h2 id="folders-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>

      <Reveal as="div" className="l-folders-panel" delay={90}>
        <ul className="l-folder-tree" role="list">
          {top.map((f) => (
            <li className="l-folder-row" data-role={f.role} key={f.path}>
              <span className="l-folder-head">
                <span className="l-folder-name">{f.label}</span>
                {tag(f.role) ? <em className="l-folder-tag">{tag(f.role)}</em> : null}
              </span>
              <span className="l-folder-note">{t(f.noteKey)}</span>
            </li>
          ))}

          <li className="l-folder-row l-folder-parent" aria-hidden="false">
            <span className="l-folder-name">
              {OHMAIL_PARENT_LABEL}
              <span className="l-folder-slash">/</span>
            </span>
          </li>

          <li className="l-folder-branch">
            <ul className="l-folder-children" role="list">
              {nested.map((f) => (
                <li className="l-folder-row" data-role={f.role} key={f.path}>
                  <span className="l-folder-head">
                    <span className="l-folder-name">{f.label}</span>
                    {tag(f.role) ? <em className="l-folder-tag l-folder-tag-meta">{tag(f.role)}</em> : null}
                  </span>
                  <span className="l-folder-note">{t(f.noteKey)}</span>
                </li>
              ))}
            </ul>
          </li>
        </ul>
      </Reveal>

      <Reveal as="p" className="l-folders-foot" delay={140}>
        {t("note")}
      </Reveal>
    </section>
  );
}
