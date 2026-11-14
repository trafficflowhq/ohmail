/**
 * A DOOR'S REFUSAL, ON SCREEN — the sentence, and the host it named as a control. ONE
 * component for both doors, the whole reason it is a component: the standalone and
 * self-hosted doors are two screens over one product handed the same refusal, and each drew
 * its own `<p className="join-error">` from its own reading — one reader (`probeTlsRefusal`)
 * and one renderer is the structural "they must agree", held by
 * `desktop-door-tls-census.test.tsx`. THE HOST IS A CONTROL, not only a word: on a hostname
 * mismatch the probe can name the host that WOULD have worked (the vanity shape), and the
 * desktop made the person read it off a paragraph and re-type it. Pressing it fills the field
 */

/*
 * and nothing else — it sends nothing, dials nothing, skips no check; the next attempt
 * verifies strictly against it. Offered only where there is a field to fill: `onUse` absent
 * means this screen has nowhere to put it, and the sentence still names the host.
 */
import { Button } from "@ohmail/ui";

import { useRefusalAtThePress } from "../../webapp/app/shell/refusal-at-the-press";
import { updateAnswerSentence, updateVerbLabel } from "../../webapp/app/shell/update-answer";
import { useUpdateOffer } from "../../webapp/app/shell/UpdateLine";
import { DOOR_COPY } from "./door-copy.js";
import type { HostSuggestion } from "./doors.js";

/**
 * THE VERB THAT ASKS THE UPDATER, FOR A DOOR — while a server's "this app is too old" answer stands
 * and this refusal is that sentence. The update line says it in the rail, and a door has no rail: a
 * person signing in or pairing would read the sentence with nothing to press. It is the one offer
 * the line reads (`app-update.ts`), so the verb is the line's own. UNDER ITS OWN SENTENCE ONLY: the
 * offer stands for the whole run, and a later refusal about something else must not carry it.
 */
function useUpdateRemedy(problem: string | null): { label: string; act: () => void } | null {
  const offer = useUpdateOffer();
  if (offer?.kind !== "tooOld" || !offer.act || problem !== updateAnswerSentence("tooOld")) return null;
  return { label: updateVerbLabel(offer.verb === "update" ? "update" : "reload"), act: offer.act };
}

export function DoorProblem({
  problem,
  suggestion,
  onUse,
  atPress = false,
}: {
  problem: string | null;
  /** The host the probe named, or null when the refusal named none. */
  suggestion?: HostSuggestion | null;
  /** Fill the field this suggestion belongs in. Absent where the screen has no such field. */
  onUse?: (suggestion: HostSuggestion) => void;
  /** Drawn between the last field and the button it answers, rather than above the form. */
  atPress?: boolean;
}): React.JSX.Element | null {
  /* Brought into view and focused as it appears, wherever the card draws it. */
  const said = useRefusalAtThePress<HTMLParagraphElement>(problem);
  const remedy = useUpdateRemedy(problem);
  if (!problem) return null;
  const offer = suggestion && onUse ? suggestion : null;
  return (
    <div className={atPress ? "join-error-note at-press" : "join-error-note"}>
      <p ref={said} className="join-error" tabIndex={-1}>{problem}</p>
      {offer ? (
        <Button
          variant="ghost"
          type="button"
          className="join-error-use"
          onClick={() => onUse!(offer)}
        >
          {offer.transport === "smtp"
            ? DOOR_COPY.useSuggestedSmtpHost(offer.host)
            : DOOR_COPY.useSuggestedImapHost(offer.host)}
        </Button>
      ) : remedy ? (
        <Button variant="ghost" type="button" className="join-error-use" onClick={remedy.act}>{remedy.label}</Button>
      ) : null}
    </div>
  );
}

/**
 * A HOSTED DOOR'S REFUSAL — the sentence as the hosted and the paired door have always drawn it, a
 * bare paragraph, and {@link DoorProblem}'s block only where the updater's verb stands under it.
 */
export function HostedDoorProblem({ problem }: { problem: string | null }): React.JSX.Element | null {
  const remedy = useUpdateRemedy(problem);
  if (!problem) return null;
  if (remedy === null) return <p className="join-error">{problem}</p>;
  return (
    <div className="join-error-note">
      <p className="join-error">{problem}</p>
      <Button variant="ghost" type="button" className="join-error-use" onClick={remedy.act}>{remedy.label}</Button>
    </div>
  );
}
