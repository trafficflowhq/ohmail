"use client";

/**
 * EVERY MESSAGE FROM THIS SENDER, AND WHAT ACCOUNTS FOR WHERE IT SITS.
 *
 * The requirement: click through to a detailed view showing every message from one address or
 * domain, and how each of them was classified.
 *
 * The vocabulary — and the three things it refuses to claim — is decided in `sender-audit.ts`
 * and nothing is invented here. This file is the rendering, plus two pieces of honesty that
 * belong to the surface rather than to the data:
 *
 *  1. **The count says "ohmail has synced".** This reads the client mirror, so it holds the
 *     mail that has arrived through `/sync` and no more. "Every message from this sender"
 *     would be a claim about the IMAP mailbox, which is the master and which this has never
 *     seen — the mailbox on the real server is the master, not this mirror. A partial answer
 *     labelled partial is useful; a partial answer labelled
 *     complete is the kind of thing this panel exists to stop.
 *  2. **No rule hit-counts.** `RuleDTO.stats.hits` is declared, reported, and never written by
 *     anything in the repository — every value is the insert default — so a rule that has
 *     filed three thousand messages renders `0`. `RulesView` refuses to show it for exactly
 *     this reason and so does this.
 */
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { AttributedMessage } from "./sender-audit";
import { placeLabel } from "./format";
import { displayAddress, displayRuleMatch } from "./idn";
// The panel is opened from the sheet but can outlive it on screen, so it imports the
// stylesheet itself rather than relying on `SenderMenu` having been mounted first.
import "./sender-sheet.css";

export interface SenderAuditState {
  /** What the panel is about — an address, or a domain when the scope switch says so. */
  title: string;
  domain: boolean;
  rows: AttributedMessage[];
}

export function SenderAuditPanel({ state, onClose }: { state: SenderAuditState; onClose: () => void }) {
  const t = useTranslations("screening");
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus moves INTO the panel on open. Without it the dialog is announced and the keyboard
  // is still on the row behind it, which for a screen-reader user is a panel that does not
  // exist. Escape is owned by `AppShell`'s one ordered layer list, not by a listener here.
  useEffect(() => { closeRef.current?.focus(); }, []);

  return (
    <>
      <div className="sa-bg" onClick={onClose} />
      <div className="sa" role="dialog" aria-modal="true" aria-label={t("auditAria", { subject: state.title })}>
        <div className="sa-head">
          <h3>{state.domain ? t("auditTitleDomain", { domain: state.title }) : state.title}</h3>
          <button ref={closeRef} type="button" className="x" onClick={onClose} aria-label={t("auditClose")}>
            ✕
          </button>
        </div>
        {/* Synced, not "all" — see the file header. */}
        <p className="sa-count">{t("auditCount", { count: state.rows.length })}</p>

        {state.rows.length === 0 ? (
          <p className="sa-empty">{t("auditEmpty")}</p>
        ) : (
          <ul className="sa-list">
            {state.rows.map(({ message, attribution }) => (
              <li key={message.id}>
                <div className="sa-line">
                  <b>{message.subject || t("auditNoSubject")}</b>
                  <span className="sa-place">{placeLabel(message.folder)}</span>
                </div>
                <div className="sa-meta">
                  <span className="sa-from">{displayAddress(message.from.address)}</span>
                  {message.date ? <span className="sa-when">{message.date.slice(0, 10)}</span> : null}
                </div>
                <div className="sa-why">
                  {attribution.kind === "rule"
                    // PRESENT TENSE, deliberately: "a rule sends mail from here to this place",
                    // not "this rule filed this message" — which would be false for every
                    // message older than its rule.
                    ? t(`auditWhyRule.${attribution.rule.kind}`, {
                        match: displayRuleMatch(attribution.rule.match),
                        place: placeLabel(attribution.rule.destination),
                      })
                    : attribution.kind === "gate"
                      ? t("auditWhyGate")
                      : t("auditWhyArrival")}
                </div>
                {attribution.kind === "gate" && attribution.suggestion ? (
                  <div className="sa-why sa-sugg">
                    {t("auditSuggestion", { rationale: attribution.suggestion.rationale })}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
