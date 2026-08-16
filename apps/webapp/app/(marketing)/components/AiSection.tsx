"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Switch } from "@ohmail/ui";
import { Reveal } from "./Reveal";

/**
 * AI, positively — and provably optional.
 *
 * The section makes one argument: rules do the bulk deterministically, AI
 * only ever proposes, and the product is complete either way. The last part
 * is the hard part to say in prose, so the section does not only say it: the
 * lab below is the same four mails rendered twice, and the switch is real.
 * Flip it and two rows change their offer while two do not move at all —
 * the verification code (whose code is stripped before anything reaches a
 * model, and which automatic routing never sends at all) and the newsletter
 * (filed by rule). Nothing is missing in the off state; that IS the claim.
 *
 * Both faces of a swapping row are always in the layout — one grid cell,
 * two children — so the panel never changes height and the crossfade has
 * nothing to jump against. The hidden face is `visibility: hidden`, which
 * takes it out of the accessibility tree while keeping its box.
 */
export function AiSection() {
  const t = useTranslations("ai");
  const [on, setOn] = useState(true);

  return (
    <section className="l-ai" aria-labelledby="feat-ai">
      <div className="l-ai-top">
        <Reveal className="l-ai-copy">
          <h2 id="feat-ai" className="l-h2">
            {t("title")}
          </h2>
          <p className="l-feat-body">{t("body")}</p>

          {/* the 80/20 claim, as a measure rather than an adjective */}
          <p className="l-split">
            <span className="l-split-bar" aria-hidden="true">
              <i className="is-rules" />
              <i className="is-ai" />
            </span>
            <span className="l-split-key">
              <b>{t("illusRules")}</b>
              <b>{t("illusAi")}</b>
            </span>
          </p>

          {/* the bridge into the lab: it belongs to the argument, not to the
              instrument, and it is what balances this column against it */}
          <p className="l-ai-bridge">{t("toggleBody")}</p>

          {/* Claim-accuracy guard, from an external review: the ports, the credit
              ledger and the spend gates are real and tested, but no model is
              constructed in either production composition root. Delete this line the
              day a classifier/drafter is injected in apps/api-vercel/src/deps.ts and
              apps/worker/src/index.ts — not before. */}
          <p className="l-ai-status">{t("status")}</p>
        </Reveal>

        <Reveal className="l-lab-wrap" delay={110}>
          <div className="l-lab" data-on={on ? "" : undefined}>
            <header className="l-lab-head">
              <b className="l-lab-title">{t("toggleLead")}</b>
              <div className="l-lab-switch">
                <span className="l-lab-name">{t("toggleLabel")}</span>
                <span className="l-lab-state">{on ? t("stateOn") : t("stateOff")}</span>
                <Switch checked={on} onChange={setOn} ariaLabel={t("toggleAria")} />
              </div>
            </header>

            <ul className="l-lab-rows">
              {/* 1 · a first-time sender: a suggestion, or the plain question */}
              <Row who={t("rowNewWho")} meta={t("rowNewMeta")} i={0}>
                <Face active={on}>
                  <span className="l-lab-line">
                    <span className="l-lab-chip is-lit">{t("rowNewOnChip")}</span>
                    <span className="l-lab-conf num">{t("rowNewOnConf")}</span>
                  </span>
                  <small>{t("rowNewOnLine")}</small>
                </Face>
                <Face active={!on}>
                  <span className="l-lab-line">
                    <span className="l-lab-chip">{t("rowNewDestA")}</span>
                    <span className="l-lab-chip">{t("rowNewDestB")}</span>
                    <span className="l-lab-chip">{t("rowNewDestC")}</span>
                    <span className="l-lab-chip is-never">{t("rowNewDestD")}</span>
                  </span>
                  <small>{t("rowNewOffLine")}</small>
                </Face>
              </Row>

              {/* 2 · a reply: a draft in your voice, or a blank composer */}
              <Row who={t("rowReplyWho")} meta={t("rowReplyMeta")} i={1}>
                <Face active={on}>
                  <span className="l-lab-draft">
                    <small>{t("rowReplyDraftLabel")}</small>
                    {t("rowReplyDraft")}
                  </span>
                  <small>{t("rowReplyOnLine")}</small>
                </Face>
                <Face active={!on}>
                  {/* the same box, empty: what "off" actually looks like */}
                  <span className="l-lab-blank">
                    <small>{t("rowReplyComposer")}</small>
                    <em>{t("rowReplyPlaceholder")}</em>
                  </span>
                  <small>{t("rowReplyOffLine")}</small>
                </Face>
              </Row>

              {/* 3 · a verification code: the one thing that cannot change */}
              <Row who={t("rowCodeWho")} meta={t("rowCodeMeta")} i={2} unchanged={t("unchanged")}>
                <div className="l-lab-face">
                  <span className="l-lab-line">
                    <span className="l-lab-code num">{t("rowCodeBody")}</span>
                  </span>
                  <small>{t("rowCodeLine")}</small>
                </div>
              </Row>

              {/* 4 · a newsletter: filed by rule, with or without AI */}
              <Row who={t("rowRuleWho")} meta={t("rowRuleMeta")} i={3} unchanged={t("unchanged")}>
                <div className="l-lab-face">
                  <span className="l-lab-line">
                    <span className="l-lab-chip is-rule">{t("rowRuleChip")}</span>
                  </span>
                  <small>{t("rowRuleLine")}</small>
                </div>
              </Row>
            </ul>

            <p className="l-lab-caption" role="status">
              {on ? t("captionOn") : t("captionOff")}
            </p>
          </div>
        </Reveal>
      </div>

      <Reveal as="div" className="l-ai-points-wrap" delay={80}>
        <dl className="l-ai-points">
          <div>
            <dt>{t("pointGradTitle")}</dt>
            <dd>{t("pointGrad")}</dd>
          </div>
          <div>
            <dt>{t("pointOtpTitle")}</dt>
            <dd>{t("pointOtp")}</dd>
          </div>
          <div>
            <dt>{t("pointByoTitle")}</dt>
            <dd>{t("pointByo")}</dd>
          </div>
        </dl>
      </Reveal>
    </section>
  );
}

function Row({
  who,
  meta,
  i,
  unchanged,
  children,
}: {
  who: string;
  meta: string;
  i: number;
  unchanged?: string;
  children: ReactNode;
}) {
  return (
    <li className="l-lab-row" style={{ "--i": i } as CSSProperties}>
      <span className="l-lab-who">
        <b>{who}</b>
        <small>{meta}</small>
        {unchanged ? <em className="l-lab-tag">{unchanged}</em> : null}
      </span>
      <span className="l-lab-swap">{children}</span>
    </li>
  );
}

/** one state of a row; the inactive one keeps its box and loses its voice */
function Face({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className="l-lab-face" data-active={active ? "" : undefined} aria-hidden={!active}>
      {children}
    </div>
  );
}
