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

import { DOOR_COPY } from "./door-copy.js";
import type { HostSuggestion } from "./doors.js";

export function DoorProblem({
  problem,
  suggestion,
  onUse,
}: {
  problem: string | null;
  /** The host the probe named, or null when the refusal named none. */
  suggestion?: HostSuggestion | null;
  /** Fill the field this suggestion belongs in. Absent where the screen has no such field. */
  onUse?: (suggestion: HostSuggestion) => void;
}): JSX.Element | null {
  if (!problem) return null;
  const offer = suggestion && onUse ? suggestion : null;
  return (
    <div className="join-error-note">
      <p className="join-error">{problem}</p>
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
      ) : null}
    </div>
  );
}
