"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import {
  ALL_RELEASES_URL,
  ANDROID_RELEASE_URL,
  DOWNLOADS,
  HAS_PREVIEW_BUILDS,
  LATEST_RELEASE_URL,
  guessPlatform,
  isPreview,
  type MobileId,
  type PlatformId,
} from "../downloads";

/**
 * The download section — three real downloads, not a list of platform names.
 *
 * What stood here was a row of six words (macOS · Windows · Linux · iOS · Android · Web)
 * under the heading "Everywhere you read mail." It named two platforms that have no app
 * and offered no way to get the ones that do: the page promised a free product and the
 * only route to it was a link inside the pricing card, pointing at a release page the
 * visitor then had to read. This section is the route.
 *
 * ── THREE DECISIONS WORTH KEEPING ──────────────────────────────────────────────────────
 *
 *  · **The links are direct.** Each button is the asset itself (see `../downloads.ts`), so
 *    a click starts the download rather than opening a releases index to choose from. The
 *    filenames are a contract with the release pipeline, which is why they live in a
 *    manifest with the rule written next to them rather than inline here.
 *  · **The guess emphasizes, never hides.** We read the user-agent once, after mount, to
 *    mark one column as probably-yours. All three stay identical in size, order and
 *    reachability — a wrong guess costs a glance, not a download. The read happens in an
 *    effect so the server-rendered markup is the same for everyone and the page can stay a
 *    static, CDN-cacheable route.
 *  · **Linux gets two affordances, one button.** AppImage is the primary (it runs anywhere
 *    without a package manager); the .deb sits beside it as a text link for people who
 *    want their system to own the install. Two equal buttons would have made Linux look
 *    like two products.
 *
 * ── THE MOBILE ROW ────────────────────────────────────────────────────────────────────
 *
 * A second row under the desktop three, in the same idiom: Android links the newest
 * `android-v*` release page (a pre-release with the APK attached — the link is a page
 * rather than the file because a sideloaded pre-release deserves its notes; how the tag
 * follows the newest release is `../downloads.ts`), and iOS is named with "coming soon"
 * and nothing more — the app is built, the App Store step is not done, and that is the
 * whole of what can be said truthfully. Two columns, same glyph size, same button size,
 * the iOS column carrying a tag where the Android column carries a button.
 *
 * ── THE STAGE CAPTION ─────────────────────────────────────────────────────────────────
 *
 * All three buttons deliver a real installer, and they do not all deliver the same
 * program: macOS carries the mail engine, Windows and Linux are the interface running on a
 * sample mailbox. The caption under each button says which one you are about to download.
 *
 * It is NOT a warning and it does not demote a column — every platform keeps an identical
 * button in an identical column, because the download works and the person asking for it
 * should get it. What changes is that they know what opens. Which platforms are a preview
 * is `PREVIEW_PLATFORMS` in `../downloads.ts`, never a list here; when that array empties
 * the whole distinction disappears from the page in one edit.
 */
export function Downloads() {
  const t = useTranslations("downloads");
  /* null until mounted AND confidently matched: the SSR pass and the first client render
     must agree, and "we could not tell" is a real answer that leaves all three equal. */
  const [yours, setYours] = useState<PlatformId | null>(null);

  useEffect(() => {
    setYours(guessPlatform(navigator.userAgent));
  }, []);

  return (
    <section className="l-dl" id="download" aria-labelledby="dl-title">
      <Reveal className="l-sec-head">
        <h2 id="dl-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>

      <Reveal as="div" className="l-dl-panel" delay={90}>
        <ul className="l-dl-row">
          {DOWNLOADS.map((p) => (
            <li className="l-dl-col" key={p.id} data-yours={p.id === yours || undefined}>
              <PlatformGlyph id={p.id} />
              <a
                className={p.id === yours ? "btn primary l-dl-btn" : "btn l-dl-btn"}
                href={p.primary.url}
                rel="noreferrer"
                /* The asset is a binary on another host, so `download` cannot rename it —
                   it is here to say "this is a file", which is what stops a browser from
                   trying to navigate to it. */
                download
              >
                {t("get", { platform: t(p.nameKey) })}
              </a>
              <p className="l-dl-fmt">
                {t(p.primary.labelKey)}
                {p.secondary ? (
                  <>
                    {" · "}
                    <a href={p.secondary.url} rel="noreferrer" download>
                      {t(p.secondary.labelKey)}
                    </a>
                  </>
                ) : null}
              </p>
              {/* Rendered only for the guessed platform, and only after mount. It is a
                  label on a column that is otherwise identical to its neighbours — the
                  emphasis, not a gate. */}
              {p.id === yours ? <p className="l-dl-yours">{t("yours")}</p> : null}
              {/* What you are about to download. Server-rendered like everything else in
                  the column — this is a fact about the release, not about the visitor, so
                  it must be in the prerendered markup and in the page a crawler reads. */}
              {HAS_PREVIEW_BUILDS ? (
                <p className="l-dl-stage" data-stage={isPreview(p.id) ? "preview" : "complete"}>
                  {t(isPreview(p.id) ? "stagePreview" : "stageComplete")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        {/* the phone row: one real release page, one honest "coming soon" */}
        <p className="l-dl-lead">{t("mobileLead")}</p>
        <ul className="l-dl-row l-dl-mobile">
          <li className="l-dl-col">
            <PlatformGlyph id="android" />
            <a className="btn l-dl-btn" href={ANDROID_RELEASE_URL} rel="noreferrer">
              {t("androidCta")}
            </a>
            <p className="l-dl-fmt">{t("androidFormat")}</p>
          </li>
          <li className="l-dl-col" data-soon="">
            <PlatformGlyph id="ios" />
            <p className="l-dl-soon">
              <b>{t("ios")}</b>
              <em className="l-opt">{t("iosSoon")}</em>
            </p>
          </li>
        </ul>

        <p className="l-dl-firstrun">{t("firstRun")}</p>
      </Reveal>

      <Reveal as="div" className="l-dl-foot" delay={140}>
        <p className="l-dl-cloud">{t("cloudLine")}</p>
        {/* Two destinations, not one repeated: the build these buttons just handed you,
            and the history behind it. Both go through `latest`/the index rather than a
            pinned tag, so neither can fall behind a release. The foot is already a
            wrapping flex row, so they need no wrapper of their own. */}
        <a className="l-dl-all" href={LATEST_RELEASE_URL} rel="noreferrer">
          {t("latestNotes")}
        </a>
        <a className="l-dl-all" href={ALL_RELEASES_URL} rel="noreferrer">
          {t("all")}
        </a>
      </Reveal>
    </section>
  );
}

/**
 * The platform marks, drawn in the design system's own icon idiom — 1.4px strokes on a
 * 24-unit grid, `currentColor`, no fill — rather than dropped in as vendor logos in
 * different weights. They inherit the column's ink, so the emphasized column's mark
 * turns with its button instead of staying a foreign object on the accent fill. The
 * iOS column reuses the apple; Android gets the robot's head in the same line weight.
 */
function PlatformGlyph({ id }: { id: PlatformId | MobileId }) {
  const glyph = id === "ios" ? "apple" : id;
  return (
    /* `data-glyph` carries a per-mark optical correction, not a style hook: marks drawn
       to the same 24-unit box do not read at the same size, because the Windows flag is
       four thin outlines around a lot of empty space while the apple is one closed shape.
       The scales are eyeballed against each other at 30px, which is the only place they
       can be judged. */
    <svg className="l-dl-glyph" data-glyph={glyph} viewBox="0 0 24 24" aria-hidden="true">
      {glyph === "apple" ? (
        <>
          {/* the body, then the leaf-stem above it */}
          <path d="M16.6 12.6c0-2.4 2-3.5 2.1-3.6-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.9-1.6 0-3.1.9-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.4 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-1-2.5-3.9z" />
          <path d="M14.2 5.6c.7-.8 1.1-2 1-3.2-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3.1 1.1.1 2.2-.6 2.9-1.4z" />
        </>
      ) : null}
      {glyph === "linux" ? (
        <>
          {/* a penguin: head and body in one outline, then belly, eyes, beak and feet */}
          <path d="M12 2.4c-2.3 0-3.8 1.8-3.8 4 0 .8.1 1.4.1 2 0 1.8-2.2 3.7-2.2 6.2 0 2.7 2.5 4.4 5.9 4.4s5.9-1.7 5.9-4.4c0-2.5-2.2-4.4-2.2-6.2 0-.6.1-1.2.1-2 0-2.2-1.5-4-3.8-4z" />
          <path d="M9.2 12.2c-.6 1-.9 2-.9 2.9 0 1.8 1.7 2.9 3.7 2.9s3.7-1.1 3.7-2.9c0-.9-.3-1.9-.9-2.9" />
          <path d="M10.4 6.9v.6M13.6 6.9v.6" />
          <path d="M11 8.9h2l-1 1.5z" />
          <path d="M9.6 18.9l-1.7 1.9M14.4 18.9l1.7 1.9" />
        </>
      ) : null}
      {glyph === "windows" ? (
        /* the four panes, with the flag's slight perspective kept */
        <>
          <path d="M3.4 5.7l7.2-1v6.7H3.4z" />
          <path d="M12.2 4.4l8.4-1.2v7.2h-8.4z" />
          <path d="M3.4 12.6h7.2v6.7l-7.2-1z" />
          <path d="M12.2 12.6h8.4v7.2l-8.4-1.2z" />
        </>
      ) : null}
      {glyph === "android" ? (
        /* the robot's head: the dome, two antennae, two eyes */
        <>
          <path d="M4.6 15.2a7.4 7.4 0 0 1 14.8 0z" />
          <path d="M7.4 8.6 5.9 6.2M16.6 8.6l1.5-2.4" />
          <path d="M9.4 12.4v.6M14.6 12.4v.6" />
          <path d="M4.6 15.2h14.8v2.6a1.2 1.2 0 0 1-1.2 1.2H5.8a1.2 1.2 0 0 1-1.2-1.2z" />
        </>
      ) : null}
    </svg>
  );
}
