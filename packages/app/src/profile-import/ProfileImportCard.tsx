"use client";

import { Button } from "@ohmail/ui/base";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { PHONE_HOLDER_WHY_KEY, holderSentence, phoneHolder } from "@ohmail/app-logic/reading/reader-holder";
import { countOf, detailsOf, type ProfileImportOffer, type ProfileImportPhase } from "./model.js";
import type { ProfileImportAppliedWire } from "./wire.js";

type ProfileText = (key: string, values?: Record<string, string | number | Date>) => string;

export interface ProfileImportCardProps {
  offer: ProfileImportOffer;
  phase: ProfileImportPhase;
  onImport: () => void;
  onNotNow: () => void;
  onAcknowledge: () => void;
  words: {
    profile: ProfileText;
    mailbox: ProfileText;
    locale: string;
    longDate: (date: Date) => string;
  };
}

/** The named region lets readers reach the offer and leave it with normal navigation. */
export function ProfileImportCard({
  offer,
  phase,
  onImport,
  onNotNow,
  onAcknowledge,
  words,
}: ProfileImportCardProps) {
  const { profile: t, mailbox: tm, locale, longDate } = words;
  const busy = phase.kind === "applying" || phase.kind === "importing";
  const failure = phase.kind === "failed" ? phase.message : undefined;

  /* THE SERVER'S SENTENCE IS SAID ONCE: it carries its own advice, so "Try again." follows only
     the generic line this card composes itself. */
  const errorLine =
    failure !== undefined ? (
      <p className="pfi-error" role="alert">
        <strong>{t("errorTitle")}</strong>{" "}
        {failure === null ? `${t("errorGeneric")} ${t("errorRetry")}` : failure}
      </p>
    ) : null;

  if (phase.kind === "done")
    return <AppliedProfile applied={phase.applied} onAcknowledge={onAcknowledge} words={words} />;

  if (offer.candidate.state === "newer") {
    return (
      <section className="stage-card pfi-card" role="region" aria-label={t("newerTitle")}>
        <h2>{t("newerTitle")}</h2>
        {/* No import button, deliberately: this build cannot read all of a newer document, and a
            lossy import offered anyway would be a restore that quietly drops settings. */}
        <p className="pfi-lede">{t("newerBody", { address: displayAddress(offer.address) })}</p>
        {errorLine}
        <div className="pfi-actions">
          <Button kind="quiet" onPress={onNotNow} disabled={busy}>
            {t("newerDismiss")}
          </Button>
        </div>
      </section>
    );
  }

  const { counts, updatedAt, producer } = offer.candidate;
  /* WAS IT A PHONE THAT SAVED THIS. The card branched on `cloud` and `local` and let a phone fall
     into the bare "Saved {when}.", which names nobody, one line under a sentence that would have
     called it "another computer". A saved profile is a SNAPSHOT and not a live claim, so this is
     the one surface that cannot know whether that phone still holds anything — `stopped` is
     `false` here because the wire carries no claim state, not because the phone is running. */
  const phone = phoneHolder(producer, false);
  const details = detailsOf(t, locale, counts);
  const savedDate = new Date(updatedAt);
  const when = Number.isNaN(savedDate.getTime()) ? null : longDate(savedDate);

  return (
    <section className="stage-card pfi-card" role="region" aria-label={t("title")}>
      <h2>{t("title")}</h2>
      <p className="pfi-lede">{t("lede", { address: displayAddress(offer.address) })}</p>
      {details ? <p className="pfi-holds">{t("holds", { details })}</p> : null}
      {when !== null ? (
        <p className="pfi-meta">
          {producer.kind === "cloud"
            ? t("savedByCloud", { when })
            : producer.kind === "local"
              ? t("savedByLocal", { when })
              : t("savedBy", { when })}
        </p>
      ) : null}
      {/* ITS OWN PARAGRAPH, so the phone is named whether or not the stamp parsed — the dated
          line above renders only for a readable `updatedAt`. THE SHORT VOICE: this line has no
          room for the clause, so the clause is its title, which is the bargain
          `PHONE_HOLDER_WHY_KEY` exists for. */}
      {phone ? (
        <p className="pfi-meta" title={tm(PHONE_HOLDER_WHY_KEY)}>
          {/* THE TABLE'S ONE DOOR, and the verb is `none` — deliberately. This card reads a
                SAVED PROFILE, not a live claim: there is no mailbox to take over from here, and a
                sentence offering a press this surface does not have is the issue-#5 defect
                pointing the other way. The short voice drops the clause into the title, which is
                the bargain `PHONE_HOLDER_WHY_KEY` exists for. */}
          {tm(
            holderSentence({
              who: { kind: producer.kind, name: null },
              verb: "none",
              voice: "short",
            }).key,
          )}
        </p>
      ) : null}
      {errorLine}
      {/* Handed to the organizer: said plainly, and the result replaces this line when it lands. */}
      {phase.kind === "importing" ? (
        <p className="pfi-note" role="status">
          {phase.reason === "unreachable" ? t("importingUnreachable") : t("importingSlow")}
        </p>
      ) : null}
      {/* What the button will do, before it is pressed — including what it will not do. */}
      <p className="pfi-note">{t("willDo")}</p>
      {/* What routing does meanwhile: only mail the document admits is held (`PlanDeps.importHold`). */}
      <p className="pfi-note">{t("routingWhileOpen")}</p>
      <div className="pfi-actions">
        <Button onPress={onImport} disabled={busy}>
          {busy ? t("importing") : t("import")}
        </Button>
        <Button kind="quiet" onPress={onNotNow} disabled={busy}>
          {t("later")}
        </Button>
      </div>
    </section>
  );
}

function AppliedProfile({
  applied,
  onAcknowledge,
  words,
}: {
  applied: ProfileImportAppliedWire;
  onAcknowledge: () => void;
  words: ProfileImportCardProps["words"];
}) {
  const { profile: t, locale } = words;
  const details = detailsOf(t, locale, applied.imported);
  return (
    <section className="stage-card pfi-card" role="region" aria-label={t("doneTitle")}>
      <h2>{t("doneTitle")}</h2>
      {details ? <p className="pfi-lede">{t("doneDetails", { details })}</p> : null}
      {/* Disclosed, not hidden: a rule this build's own validation refuses is left out, and
          the count of what did NOT arrive is part of an honest confirmation. */}
      {applied.skippedRules > 0 ? (
        <p className="pfi-note">{t("doneSkipped", { count: applied.skippedRules })}</p>
      ) : null}
      {countOf(applied.retiredRules) > 0 ? (
        <p className="pfi-note">{t("doneRetired", { count: countOf(applied.retiredRules) })}</p>
      ) : null}
      {/* The copy's signature was not taken over the one typed on this mailbox: said, never silent. */}
      {applied.imported.signatureKept === true ? <p className="pfi-note">{t("doneSignatureKept")}</p> : null}
      <div className="pfi-actions">
        <Button onPress={onAcknowledge}>{t("doneAction")}</Button>
      </div>
    </section>
  );
}
