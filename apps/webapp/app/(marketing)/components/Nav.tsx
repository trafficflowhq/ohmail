"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon, useTheme } from "@ohmail/ui";
import { Wordmark, DotLabel } from "./Wordmark";
import { useSessionPresence } from "./session-presence";
import { GITHUB_REPO_URL, starLabel } from "../github";
import { LangSwitch } from "./LangSwitch";

/* Inlined at build (`env` in next.config.mjs), so the reference must stay the
   full literal — Next's compiler substitutes the exact string, not a lookup. */
const STARS = starLabel(process.env.NEXT_PUBLIC_GITHUB_STARS);

export function Nav() {
  const t = useTranslations("nav");
  const { resolved, toggle } = useTheme();
  const presence = useSessionPresence();
  const [scrolled, setScrolled] = useState(false);
  /* `resolved` reads matchMedia/localStorage, so its first client value can
     differ from the SSR default ("light") on dark-mode systems. Render the
     SSR icon until mounted to keep hydration clean. */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="l-nav" data-scrolled={scrolled || undefined}>
      <a className="l-skip" href="#main">
        {t("skip")}
      </a>
      <div className="l-nav-inner">
        <a className="l-nav-brand" href="#top" aria-label={t("home")}>
          <Wordmark />
        </a>
        <nav className="l-nav-links" aria-label="Site">
          <a href="#product">{t("product")}</a>
          {/* left of Pricing on purpose (owner ask, 2026-08-21): running it yourself
              is presented before paying for it, in the bar as on the page */}
          <a href="#selfhost">{t("selfhost")}</a>
          <a href="#pricing">{t("pricing")}</a>
          {/* The free product is the thing a visitor can act on immediately, and until
              this link existed the only route to it was scrolling past the price. */}
          <a href="#download">{t("download")}</a>
          <a href="#faq">{t("faq")}</a>
        </nav>
        <div className="l-nav-actions">
          {/* The other language, at the head of the action cluster and one weight quieter
              than everything in it: a reader who needs it is looking for their own word for
              their language, and a reader who does not must be able to skip past it. It is
              the only control here that changes the ADDRESS rather than the page, which is
              why it is a link with an hreflang rather than a toggle. Hidden below 480px,
              where the bar is stripped to the ask — the footer's copy carries it there. */}
          <LangSwitch className="l-nav-lang" />
          {/* The source, in the bar — the one outbound link the menu carries. The star
              count is a build-time constant (see ../github.ts); when the build had no
              usable count the number is simply absent, never guessed. */}
          <a className="l-nav-github" href={GITHUB_REPO_URL} aria-label={t("github")} title={t("github")}>
            {/* NOT `ic`. The design system's icon class is `svg.ic` in `@ohmail/ui`'s
                base layer — a TYPE+CLASS selector — and it sets `fill:none;
                stroke:currentColor`, because every other mark on this page is a stroke
                drawing. The octocat is the opposite: one closed silhouette meant to be
                filled. Carrying `ic` here made the reset win on specificity (0,1,1 beats
                the 0,1,0 of `.l-gh-mark`, whatever the import order), so the mark shipped
                as a 1.3px OUTLINE of the silhouette — a hollow tangle, not the GitHub
                logo. The class is dropped rather than out-specified: this svg is not a
                stroke icon and should never have claimed to be one. */}
            <svg className="l-gh-mark" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            <span className="l-nav-github-name">{t("githubName")}</span>
            {STARS !== null ? (
              <span className="l-nav-stars num">
                <svg className="ic l-star-ic" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 1.8l1.6 4.2 4.4.3-3.4 2.8 1.1 4.3L8 11l-3.7 2.4 1.1-4.3L2 6.3l4.4-.3z" />
                </svg>
                {STARS}
              </span>
            ) : null}
          </a>
          <button
            type="button"
            className="l-icon-btn"
            onClick={toggle}
            aria-label={t("themeToggle")}
            title={t("themeToggle")}
          >
            {mounted && resolved === "dark" ? (
              <Icon name="sun" />
            ) : (
              <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M13.4 9.9A5.9 5.9 0 0 1 6.1 2.6a5.9 5.9 0 1 0 7.3 7.3z" />
              </svg>
            )}
          </button>
          {mounted && presence === "present" ? (
            /* A live session on the marketing page (it expired mid-visit and came back,
               or the visitor navigated here on purpose): the bar has nothing to sell
               them, so the acquisition trio collapses into the one honest offer — into
               the app. `/` serves the product to a session; the middleware, not this
               header, is the authority. */
            <a className="btn primary l-nav-cta" href="/">
              {t("open")}
            </a>
          ) : (
            <>
              {/* The demo is the proof, so it keeps a place in the bar — but the
                  bar's job is the ask. Primary is "Get ohmail.", set as the
                  wordmark is set, pointing at the section of the same name: the
                  four ways to run it, free ones first — never straight at the
                  price list, because three of the four ways have no price. Sign
                  in sits directly beside it, same quiet weight as the demo link:
                  the returning customer's door, never competing with the ask. */}
              <a className="l-nav-demo" href="#demo">
                {t("ctaDemo")}
              </a>
              <a className="l-nav-signin" href="/login">
                {t("signIn")}
              </a>
              <a className="btn primary l-nav-cta" href="#get">
                <DotLabel text={t("cta")} />
              </a>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
