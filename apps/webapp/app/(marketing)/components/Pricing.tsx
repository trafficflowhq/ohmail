"use client";

import { useTranslations } from "next-intl";
import { Reveal } from "./Reveal";
import { useSignup, type SignupTier } from "./Signup";

/**
 * Two honest tiers: Desktop free and complete, Cloud as one panel with three columns —
 * deliberately NOT four identical cards.
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

  return (
    <section className="l-pricing" id="pricing" aria-labelledby="pricing-title">
      <Reveal className="l-sec-head">
        <h2 id="pricing-title" className="l-h2">
          {t("title")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>

      <div className="l-price-grid">
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

        <Reveal className="l-price-cloud" delay={110}>
          <header className="l-cloud-head">
            <h3 className="l-price-name">
              {t("cloudName")}
              <em className="l-opt">{t("cloudOptional")}</em>
            </h3>
            <p>{t("cloudShared")}</p>
          </header>
          <div className="l-tiers">
            <CloudTier id="solo" featured={false} onPick={open} publicSignup={publicSignup} />
            <CloudTier id="plus" featured onPick={open} publicSignup={publicSignup} />
            <CloudTier id="pro" featured={false} onPick={open} publicSignup={publicSignup} />
          </div>
          {/* the trial, stated with its one real limit rather than as a
              badge that hides it — a standing decision, not a styling choice */}
          <p className="l-trial-note">{t("trialNote")}</p>
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
}: {
  id: "solo" | "plus" | "pro";
  featured: boolean;
  onPick: (tier: SignupTier) => void;
  publicSignup: boolean;
}) {
  const t = useTranslations("pricing");
  const name = t(`${id}Name`);
  const cls = featured ? "btn primary l-tier-cta" : "btn l-tier-cta";
  return (
    <div className="l-tier" data-featured={featured || undefined}>
      <h4 className="l-tier-name">{name}</h4>
      <p className="l-tier-fig">
        <b className="num">{t(`${id}Price`)}</b>
        <span>{t("perMonth")}</span>
      </p>
      <p className="l-tier-line num">{t(`${id}Mailboxes`)}</p>
      <p className="l-tier-line num">{t(`${id}Actions`)}</p>
      <p className="l-tier-trial">{t("trialBadge")}</p>
      {publicSignup ? (
        // `?plan=` is a HINT the wizard may use to preselect; it is never the authority on
        // what gets bought. `billing.checkout(plan)` is called from the plan step with the
        // plan the person clicked there, and Stripe prices it from `PLAN_LIMITS` server-side.
        <a className={cls} href={`/join?plan=${id}`}>
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
