"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { markTags } from "./Mark";
import { useSignup, type SignupTier } from "./Signup";
import { SELF_HOST_GUIDE_URL } from "./GetOhmail";

/**
 * The price list in first-sight order: the two free ways side by side, the managed tiers
 * full-width beneath them — one structured section, all of it meant to be seen in one
 * viewport.
 *
 * ── THE ORDER IS THE OFFER ───────────────────────────────────────────────────────────
 *
 * 1. **ohmail Desktop — free.** And not as a teaser: the card says out loud that a
 *    running desktop app is a complete self-hosted ohmail — the whole organizer on your
 *    machine, the mailbox as the master, no cloud in the loop. `pricing-structure.test.ts`
 *    holds that claim against `PREVIEW_PLATFORMS`: the sentence is licensed exactly while
 *    every shipped build carries the real engine.
 * 2. **Self-hosted Cloud — free.** The same open server on hardware you own, with its
 *    three ways in stated on the card (a box you rent or own, a home-server box, or the
 *    desktop app that is already one). The prebuilt-images claim is new and licensed:
 *    the GHCR packages answer anonymous pulls (verified live 2026-08-30), and the claim
 *    is pinned to the public README's own "images are prebuilt" sentence so the two
 *    surfaces move together.
 * 3. **ohmail Cloud — the paid tiers**, full-width below the free row, so a visitor who
 *    never scrolls still meets the managed offering: defensive selling is the brand, but
 *    nobody should miss that the managed service exists.
 *
 * On narrow screens the grid stacks in exactly that order — the order, not the fold,
 * carries the intent there.
 *
 * ── WHAT DID NOT MOVE ────────────────────────────────────────────────────────────────
 *
 *  · Every tier figure stays the string the anti-drift gate parses
 *    (`test/landing-pricing-matches-plan-card.test.ts` against `PLAN_LIMITS`); the trial
 *    note keeps the granted figure `trial-credits.test.ts` compares.
 *  · **Both CTAs point at real things** — the desktop card at the download section that
 *    owns the per-platform links (`../downloads.ts`), never at an off-origin release URL
 *    (which once went four releases stale); the tier buttons at `/join` when
 *    `TF_PUBLIC_SIGNUP=1`, at the waitlist otherwise. No third state.
 *  · The waitlist door survives (`desktopNotify`): it is the only entry point left to
 *    the dialog once the Cloud tiers link straight to `/join`, and the capacity valve
 *    (`signup_capacity`) sends people back here when Cloud has no room.
 *  · The claim-accuracy rules on the desktop note: it is a real mail client against your
 *    own IMAP server, and what must never come back is the other direction — "no IMAP
 *    client", "no network at all" — because every build makes a signed update check and
 *    every build is a mail client (`public-signup.test.ts`).
 */
export function Pricing({ publicSignup = false }: { publicSignup?: boolean }) {
  const t = useTranslations("pricing");
  const { open } = useSignup();
  // MONTHLY PRESELECTED — the ratified default. The toggle changes the price a card SHOWS and
  // the interval the CTA carries into `/join`; the server prices the actual Checkout either
  // way, so this state is presentation plus a hint, never the authority on money.
  const [interval, setInterval] = useState<"month" | "year">("month");

  return (
    <section className="l-pricing" id="pricing" aria-labelledby="pricing-title">
      <Reveal className="l-sec-head">
        <h2 id="pricing-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>

      <div className="l-price-grid">
        {/* the free row: two cards, side by side — the app, then the server */}
        <div className="l-price-free">
        <Reveal className="l-price-desktop">
          <h3 className="l-price-name">
            {t("desktopName")}
            <em className="l-opt">{t("desktopStatus")}</em>
          </h3>
          <p className="l-price-fig">
            <b className="num">{t("desktopPrice")}</b>
            <span>{t("desktopTerm")}</span>
          </p>
          {/* The card's one emphasized sentence: free does not mean a demo here. Stated
              once on the page, at the exact spot where "Free" invites the suspicion. */}
          <p className="l-price-claim">{t("desktopClaim")}</p>
          <p className="l-price-status">{t("desktopStatusNote")}</p>
          <ul className="l-price-feats">
            <li>{t("desktopB")}</li>
            <li>{t("desktopE")}</li>
            {/* the host fact, with its honesty qualifier — the machine serves while it
                is AWAKE (sleep stales the host lease), never an unqualified "always-on" */}
            <li>{t("desktopHostFeat")}</li>
          </ul>
          {/* Down to the section that owns the per-platform links, not out to GitHub. */}
          <a className="btn primary l-btn-lg l-price-cta" href="#download">
            {t("desktopCta")}
          </a>
          <p className="l-price-ctanote">{t("desktopCtaNote")}</p>
          <button type="button" className="l-price-notify" onClick={() => open("desktop")}>
            {t("desktopNotify")}
          </button>
        </Reveal>

        <Reveal className="l-price-desktop l-price-self" delay={60}>
          <h3 className="l-price-name">
            {t("selfName")}
            <em className="l-opt">{t("selfStatus")}</em>
          </h3>
          <p className="l-price-fig">
            <b className="num">{t("selfPrice")}</b>
            <span>{t("selfTerm")}</span>
          </p>
          {/* THE PATH LINE (owner review 2026-08-31): what picking this card GETS you, where
              "Free" invites the comparison to the desktop card beside it — ohmail from
              everywhere as a web app, and the always-on organizer a desktop doesn't have to
              stay awake to be. Marked with the page's one emphasis device so it lands at a
              glance; `pricing-structure.test.ts` names it and holds the always-on/awake
              contrast to the card that carries the awake qualifier. */}
          <p className="l-price-why">{t.rich("selfWhy", markTags())}</p>
          <p className="l-price-claim">{t("selfClaim")}</p>
          {/* the terms first, then the three ways in — the last of which is the desktop
              card beside this one, so the two free cards read as one fact */}
          <p className="l-price-status">{t("selfStatusNote")}</p>
          <ul className="l-price-feats">
            <li>{t("selfWayServer")}</li>
            <li>{t("selfWayHome")}</li>
            <li>{t("selfWayDesktop")}</li>
          </ul>
          <a className="btn l-btn-lg l-price-cta" href={SELF_HOST_GUIDE_URL} rel="noreferrer">
            {t("selfCta")}
          </a>
          <p className="l-price-ctanote">
            <a className="l-price-ctalink" href="#selfhost">
              {t("selfCtaNote")}
            </a>
          </p>
        </Reveal>
        </div>

        <Reveal className="l-price-cloud" delay={110}>
          {/* The head is a row: name and lede left, the interval toggle right with the
              annual fact directly under the control it qualifies — the panel spends its
              height on the tiers, which is what has to be visible without scrolling. */}
          <header className="l-cloud-head">
            <div className="l-cloud-lead">
              <h3 className="l-price-name">
                {t("cloudName")}
                <em className="l-opt">{t("cloudOptional")}</em>
              </h3>
              <p>{t("cloudShared")}</p>
            </div>
            <div className="l-cloud-controls">
              {/* Monthly first and preselected; annual is the same plans with two months
                  free. Buttons rather than a switch: two visible prices with a pressed
                  state read faster than an abstract toggle, and `aria-pressed` says which
                  one is live. */}
              <div className="l-interval-toggle" role="group" aria-label={t("intervalLabel")}>
                <button
                  type="button" className="l-interval-btn" aria-pressed={interval === "month"}
                  onClick={() => setInterval("month")}
                >
                  {t("intervalMonthly")}
                </button>
                <button
                  type="button" className="l-interval-btn" aria-pressed={interval === "year"}
                  onClick={() => setInterval("year")}
                >
                  {t("intervalAnnual")}
                </button>
              </div>
              <p className="l-annual">{t("annualNote")}</p>
            </div>
          </header>
          <div className="l-tiers">
            <CloudTier id="solo" featured={false} onPick={open} publicSignup={publicSignup} interval={interval} />
            <CloudTier id="plus" featured onPick={open} publicSignup={publicSignup} interval={interval} />
            <CloudTier id="pro" featured={false} onPick={open} publicSignup={publicSignup} interval={interval} />
          </div>
          <div className="l-cloud-notes">
            {/* the trial, stated with its one real limit rather than as a
                badge that hides it — a standing decision, not a styling choice */}
            <p className="l-trial-note">{t("trialNote")}</p>
            {/* The email counts on each tier are an ESTIMATE and must read as one, so the basis
                travels with them rather than living in a footnote nobody scrolls to: ~25 KB of
                stored message text per email (measured, `BYTES_PER_STORED_EMAIL_ESTIMATE`), the GB
                figure once for anyone who wants it, and the attachment fact — attachment bytes are
                never stored server-side, so they never count. Said ONCE under the three tiers
                rather than three times inside them. */}
            <p className="l-storage-note">{t("storageNote")}</p>
          </div>
        </Reveal>
      </div>

      <Reveal as="div" className="l-price-footer" delay={80}>
        <p>{t("footerLine")}</p>
      </Reveal>
    </section>
  );
}

function CloudTier({
  id,
  featured,
  onPick,
  publicSignup,
  interval,
}: {
  id: "solo" | "plus" | "pro";
  featured: boolean;
  onPick: (tier: SignupTier) => void;
  publicSignup: boolean;
  interval: "month" | "year";
}) {
  const t = useTranslations("pricing");
  const name = t(`${id}Name`);
  const cls = featured ? "btn primary l-tier-cta" : "btn l-tier-cta";
  const annual = interval === "year";
  return (
    <div className="l-tier" data-featured={featured || undefined}>
      <h4 className="l-tier-name">{name}</h4>
      <p className="l-tier-fig">
        <b className="num">{annual ? t(`${id}PriceAnnual`) : t(`${id}Price`)}</b>
        <span>{annual ? t("perYear") : t("perMonth")}</span>
      </p>
      <p className="l-tier-line num">{t(`${id}Mailboxes`)}</p>
      <p className="l-tier-line num">{t(`${id}Actions`)}</p>
      <p className="l-tier-line num">{t(`${id}Storage`)}</p>
      <p className="l-tier-trial">{t("trialBadge")}</p>
      {publicSignup ? (
        // `?plan=` is a HINT the wizard may use to preselect; it is never the authority on
        // what gets bought. `billing.checkout(plan)` is called from the plan step with the
        // plan the person clicked there, and Stripe prices it from `PLAN_LIMITS` server-side.
        <a className={cls} href={`/join?plan=${id}${annual ? "&interval=year" : ""}`}>
          {t("cloudCta", { tier: name })}
        </a>
      ) : (
        <button type="button" className={cls} onClick={() => onPick(id)}>
          {t("cloudCta", { tier: name })}
        </button>
      )}
    </div>
  );
}
