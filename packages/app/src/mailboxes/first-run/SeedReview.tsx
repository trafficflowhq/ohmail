/**
 * THE SENT-MAIL REVIEW, as a step of the stage: "you have written to these people; shall I let them through?" The
 * list is shown before it acts, the count is of people, every row can be unticked and the button says how many are
 * ticked; whom the robot filter left out is said, folded, with its reason; and the sentence above the button says what
 * pressing does and what it does not: it writes rules and moves nothing. A refused confirm keeps every tick.
 */
import type { ReactNode } from "react";
import { Button, Field, Page, Sentence } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import type { SeedOffer } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import type { SeedReview as SeedReviewModel } from "@ohmail/app-logic/mailboxes/first-run/use-seed-review";
import type { Say } from "./words.js";

/**
 * The people, as the filter shows them, with the two bulk presses: they act on what the filter shows and nothing past
 * it, and whether they are offered is a question about the whole list, so they do not come and go under a filter.
 */
function People({ review, busy, say }: { review: SeedReviewModel; busy: boolean; say: Say }): ReactNode {
  return (
    <>
      <Field
        label={say("seed.filterPlaceholder")}
        type="search"
        bare
        value={review.filter}
        placeholder={say("seed.filterPlaceholder")}
        onChange={review.setFilter}
      />
      {review.bulkOffered ? (
        <div className="mbx-run-row">
          <Button
            kind="quiet"
            disabled={
              busy || review.actionable.length === 0 || review.shownChecked === review.actionable.length
            }
            onPress={() => review.setShown(true)}
          >
            {say("seed.selectShown")}
          </Button>
          <Button
            kind="quiet"
            disabled={busy || review.shownChecked === 0}
            onPress={() => review.setShown(false)}
          >
            {say("seed.deselectShown")}
          </Button>
        </div>
      ) : null}
      <ul className="mbx-run-list">
        {review.shown.map((c) => (
          <li key={c.address}>
            <label className="mbx-run-row">
              <input
                type="checkbox"
                checked={review.checked.has(c.address)}
                disabled={c.alreadyDecided || busy}
                onChange={() => review.toggle(c.address)}
              />
              {/* Labels only: the tick and the decision it writes keep the STORED address. */}
              <span>{c.name ?? displayAddress(c.address)}</span>
              {c.name ? <span>{displayAddress(c.address)}</span> : null}
              <span>{say("seed.wroteN", { count: c.messages })}</span>
              {c.alreadyDecided ? <span>{say("seed.alreadyDecided")}</span> : null}
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The review the frame read (`SeedReviewContext`, read where its offer is worked out), drawn as the stage's step. */
export function SeedReview({
  review,
  offer,
  say,
}: {
  review: SeedReviewModel;
  offer: SeedOffer;
  say: Say;
}): ReactNode {
  const { phase } = review;
  const said = (s: string | null): string => s ?? say("seed.errorGeneric");
  if (phase.at === "loading")
    return (
      <Page acts={null}>
        <Sentence size="xl" level={1} end="hot">
          {say("seed.loading")}
        </Sentence>
      </Page>
    );
  if (phase.at === "unavailable")
    return (
      <Page
        line={said(phase.said)}
        acts={
          <Button kind="two" onPress={offer.later}>
            {say("seed.later")}
          </Button>
        }
      >
        <Sentence size="xl" level={1} end="hot">
          {say("seed.errorTitle")}
        </Sentence>
      </Page>
    );
  if (review.nothing) {
    if (!offer.reopened) return null;
    return (
      <Page
        line={say("seed.nothingToDecide")}
        acts={
          <Button kind="two" onPress={offer.later}>
            {say("seed.close")}
          </Button>
        }
      >
        <Sentence size="xl" level={1} end="hot">
          {say("seed.nothingToDecide")}
        </Sentence>
      </Page>
    );
  }
  const busy = phase.at === "confirming";
  const failure = phase.at === "ready" && phase.error !== undefined ? said(phase.error) : null;
  const { candidates, excluded, truncated, scannedMessages } = phase.review;
  return (
    <Page
      {...(failure === null ? {} : { refusal: [say("seed.errorTitle"), failure] as const })}
      line={truncated ? [{ tag: say("seed.recentSent", { count: scannedMessages }) }] : undefined}
      material={
        <div className="mbx-run-material">
          {/* THE REFUSAL SITS ABOVE THE LIST, NOT INSTEAD OF IT: every tick is still on screen and one press tries again. */}
          {failure === null ? null : <SettingNote>{say("seed.errorRetry")}</SettingNote>}
          <People review={review} busy={busy} say={say} />
          {excluded.length ? (
            <details className="mbx-run-folded">
              <summary>{say("seed.excludedSummary", { count: excluded.length })}</summary>
              <ul className="mbx-run-list">
                {excluded.map((e) => (
                  <li key={e.address} className="mbx-run-row">
                    <span>{displayAddress(e.address)}</span>
                    <span>{say(`seed.excluded.${e.reason}`)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      }
      acts={
        <div className="mbx-run-acts">
          <Button kind="ink" size="l" disabled={busy} onPress={review.confirm}>
            {busy ? say("seed.confirming") : say("seed.confirm", { count: review.checked.size })}
          </Button>
          <Button kind="quiet" disabled={busy} onPress={offer.later}>
            {say("seed.later")}
          </Button>
        </div>
      }
    >
      <Sentence size="xl" level={1} end="hot">
        {say("seed.title", { count: candidates.length })}
      </Sentence>
    </Page>
  );
}
