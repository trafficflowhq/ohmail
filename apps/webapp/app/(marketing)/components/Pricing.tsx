"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { useSignup, type SignupTier } from "./Signup";
import { SELF_HOST_GUIDE_URL } from "./GetOhmail";

/**
 * The free ways on the left, the managed tiers on the right — deliberately NOT five
 * identical cards.
 *
 * ── SELF-HOSTING IS ON THE PRICE LIST, AS A PRICE ────────────────────────────────────
 *
 * The left column holds BOTH things a person can run for nothing: the desktop app, and the
 * same open server on a box they own. The self-host card states the fact the whole section
 * turns on — the hosted tiers to its right are that server run by us, and the money buys
 * the running — so a visitor reading the price grid cannot miss that "free" has two shapes
 * and neither is a demo. Its one link goes to the public repository's self-host guide (the
 * same URL the Get-ohmail block's server card uses, held there by `get-ohmail.test.ts`),
 * and its bullets claim exactly what `deploy/selfhost` ships: one compose file, unmetered
 * mailboxes, your own AI key or none. Never a prebuilt-image or `docker pull` claim while
 * that guard stands.
 *
 * ── BOTH CTAs POINT AT REAL THINGS ────────────────────────────────────────────────────
 *
 *  · **Cloud** — `TF_PUBLIC_SIGNUP=1` means a stranger can open an account and start the
 *    14-day trial, so the tier buttons go to `/join` with the tier carried along. With the
 *    flag OFF they open the waitlist exactly as before; there is no third state and no
 *    button that leads somewhere the deployment cannot honour.
 *  · **Desktop** — an in-page anchor to the download section, which owns the three
 *    per-platform links and the manifest behind them (`../downloads.ts`). This card used
 *    to carry the off-origin release URL itself, pinned to a version tag that then went
 *    four releases stale without anything noticing. One owner for the download, and it is
 *    the section whose whole subject is the download.
 *
 * The desktop copy is no longer per-platform. It was, while the macOS build was the only
 * one carrying the mail engine; the single cross-platform app makes that split obsolete,
 * and the sentences that drew it are gone rather than reworded. What must never come back
 * is the other direction — "no IMAP client", "no network at all" — because every build
 * makes a signed update check and every build is a mail client.
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
        {/* the free column: two cards, one register — the app, then the server */}
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
          {/* The claim-accuracy invariant is unchanged even though the per-platform
              scoping is gone: this note and the shipped app move together, and it
              neither over- nor under-claims. The uppercase label that used to sit
              between it and the bullets carried the macOS/Windows/Linux split; with
              nothing left to scope it was a section eyebrow and nothing else. */}
          <p className="l-price-status">{t("desktopStatusNote")}</p>
          <ul className="l-price-feats">
            <li>{t("desktopA")}</li>
            <li>{t("desktopB")}</li>
            <li>{t("desktopC")}</li>
            <li>{t("desktopD")}</li>
            <li>{t("desktopE")}</li>
          </ul>
          {/* Down to the section that owns the per-platform links, not out to GitHub. */}
          <a className="btn primary l-btn-lg l-price-cta" href="#download">
            {t("desktopCta")}
          </a>
          <p className="l-price-ctanote">{t("desktopCtaNote")}</p>
          {/* THE WAITLIST'S REMAINING JOB, and the reason it is not deleted: it is the only
              entry point left to the dialog once the Cloud tiers link straight to `/join`,
              and the capacity valve (`signup_capacity`) sends people back here when Cloud
              has no room. The label is no longer about an engine landing — there is nothing
              left to wait for on the desktop — but the door still has to exist. */}
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
          <p className="l-price-status">{t("selfStatusNote")}</p>
          <ul className="l-price-feats">
            <li>{t("selfA")}</li>
            <li>{t("selfB")}</li>
            <li>{t("selfC")}</li>
            <li>{t("selfD")}</li>
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
          <header className="l-cloud-head">
            <h3 className="l-price-name">
              {t("cloudName")}
              <em className="l-opt">{t("cloudOptional")}</em>
            </h3>
            <p>{t("cloudShared")}</p>
          </header>
          {/* Monthly first and preselected; annual is the same plans with two months free.
              Buttons rather than a switch: two visible prices with a pressed state read
              faster than an abstract toggle, and `aria-pressed` says which one is live. */}
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
          <div className="l-tiers">
            <CloudTier id="solo" featured={false} onPick={open} publicSignup={publicSignup} interval={interval} />
            <CloudTier id="plus" featured onPick={open} publicSignup={publicSignup} interval={interval} />
            <CloudTier id="pro" featured={false} onPick={open} publicSignup={publicSignup} interval={interval} />
          </div>
          {/* the trial, stated with its one real limit rather than as a
              badge that hides it — a standing decision, not a styling choice */}
          <p className="l-trial-note">{t("trialNote")}</p>
          {/* The email counts on each tier are an ESTIMATE and must read as one, so the basis
              travels with them rather than living in a footnote nobody scrolls to: ~25 KB of
              stored message text per email (measured, `BYTES_PER_STORED_EMAIL_ESTIMATE`), the GB
              figure once for anyone who wants it, and the attachment fact — attachment bytes are
              never stored server-side, so they never count. Said ONCE under the three tiers
              rather than three times inside them: it is the same sentence for every tier, and
              repeating it in each card would push the price off the first screen. */}
          <p className="l-storage-note">{t("storageNote")}</p>
          <p className="l-annual">{t("annualNote")}</p>
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
