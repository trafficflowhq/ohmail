"use client";

/**
 * WHAT SAYS THE FIRST RUN IS OWED, for the frame's life. The stage `firstRun` is drawn while the address names it or
 * while something that lives as long as the frame says it is owed; this is that something. Two duties the old shell
 * did for the whole app, each as it stood there:
 *
 * 1. THE REVIEW OF WHO THE PERSON WRITES TO. Its offer is worked out once per frame (`useSeedOffer`), handed to the
 *    stage and to every other reader as `SeedOfferContext`. ITS READ IS MADE HERE, NOT ON THE STAGE (`useSeedReview`,
 *    provided as `SeedReviewContext`): the stage holds the whole app inert, and a browser drops the focus of a box
 *    made inert, so the person's next words went nowhere when every cold load stood the stage for a read that then
 *    found nobody. Offered, the review takes the stage at whatever address (`useStageOwed`) once its read has people
 *    to decide about or a refusal to say; opened again from Settings it stands while it reads, as the person asked
 *    for it. The stage's own body draws the review where no run is named.
 * 2. THE ORGANIZE QUESTION, ONCE PER LAUNCH, about a mailbox nobody decided about: the address is led to the run
 *    for that mailbox, a re-run where setup was left before. A person who closes it is not asked again until the
 *    app is opened again (`decision-asked`: the stage marks the launch when it draws a step).
 *
 * Neither on the demo, and neither over a host that has no first run: the review needs the host's wire for it, the
 * question a host that hands the stage with its verbs and its door.
 */
import { useMemo } from "react";
import { useConsent } from "@ohmail/app-logic/consent";
import { useDemoMode } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { useDecisionReopensOncePerLaunch } from "@ohmail/app-logic/mailboxes/first-run/decision-reopen";
import {
  hasLiveMailbox,
  useSeedOffer,
  type SeedOffer,
} from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import { useSeedReview, type SeedReview } from "@ohmail/app-logic/mailboxes/first-run/use-seed-review";
import { useFrame, useStageOwed } from "../../frame/index.js";
import { NONE } from "../../host/index.js";

/**
 * Whether the review takes the stage now: owed, and, offered, with its read answered with someone to decide about or
 * a refusal; opened again from Settings, at once.
 */
function seedStands(
  offer: Pick<SeedOffer, "owed" | "reopened">,
  review: Pick<SeedReview, "phase" | "nothing">,
): boolean {
  return offer.owed && (offer.reopened || (review.phase.at !== "loading" && !review.nothing));
}

/**
 * The frame's one offer of the review and its one read, with the stage stood while the review has something to show
 * and the question asked once.
 */
export function useFirstRunOwed(): { readonly offer: SeedOffer; readonly review: SeedReview } {
  const { host, route, commands } = useFrame();
  const demo = useDemoMode();
  const consent = useConsent();
  const { mailboxes: facts } = useMailState();
  const offer = useSeedOffer({
    demo,
    known: consent.known,
    supported: host.wires.seedReview !== NONE,
    seedConfirmedAt: consent.seedConfirmedAt,
    hasMailbox: hasLiveMailbox(facts),
    scope: host.session.scope,
  });
  const seedWire = host.wires.seedReview;
  const review = useSeedReview({
    wire: offer.owed && seedWire !== NONE ? seedWire : null,
    onDone: offer.done,
    ...(offer.reopened ? {} : { onNothingToDecide: offer.nothingToDecide }),
  });
  useStageOwed("firstRun", seedStands(offer, review));
  const stage =
    !demo &&
    host.features.stages.firstRun !== NONE &&
    host.wires.firstRun !== NONE &&
    host.capabilities.firstRunDoor !== NONE;
  const scope = host.session.scope;
  useDecisionReopensOncePerLaunch(route.stage?.id === "firstRun", { facts, consent, stage, scope }, (run) =>
    commands.go({
      place: route.place,
      stage: { id: "firstRun", words: { ...(run.rerun ? { how: "again" } : {}), mailbox: run.mailboxId } },
    }),
  );
  /* One object while nothing of the offer moved: its readers draw when it does, not at every draw of this mount. */
  const { owed, reopened, reopen, later, nothingToDecide, done } = offer;
  const kept = useMemo(
    () => ({ owed, reopened, reopen, later, nothingToDecide, done }),
    [owed, reopened, reopen, later, nothingToDecide, done],
  );
  return { offer: kept, review };
}
