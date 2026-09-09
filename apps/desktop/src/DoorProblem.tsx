/**
 * A DOOR'S REFUSAL, ON SCREEN — the sentence, and the host it named as a control.
 *
 * ── ONE COMPONENT FOR BOTH DOORS, AND THAT IS THE WHOLE REASON IT IS A COMPONENT ──────────────
 *
 * The standalone door and the self-hosted door are two screens over one product, and the same
 * engine hands both of them the same refusal. They each drew their own `<p className="join-error">`
 * from their own reading of it, and that is how they came to describe one answer in two ways: this
 * door sharpened the sentence and named the host, the other returned the service's generic message
 * and discarded the detail it was holding. One reader (`probeTlsRefusal`) and one renderer is the
 * structural version of "they must agree", and `desktop-door-tls-census.test.tsx` holds it.
 *
 * ── WHY THE HOST IS A CONTROL AND NOT ONLY A WORD IN THE SENTENCE ─────────────────────────────
 *
 * On a certificate hostname mismatch the probe can name the host that WOULD have worked — the
 * vanity shape, where somebody types `mail.<their-domain>` and the server there presents a
 * certificate for `<their-domain>`. The sentence has named it since the door stopped throwing the
 * detail away, and the hosted web app went one step further from the day the detail existed: it
 * offers the correction as a press. The desktop still made the person read a hostname off a
 * paragraph and type it back into a field two lines below, which is the part of this that a
 * standalone customer — the one with no support channel — was worst served by.
 *
 * Pressing it fills the field and nothing else. It sends nothing, dials nothing and skips no check:
 * the next attempt dials that host and verifies strictly against it, exactly as any typed value is.
 *
 * ── AND IT IS ONLY OFFERED WHERE THERE IS A FIELD TO FILL ─────────────────────────────────────
 *
 * `onUse` absent means this screen has nowhere to put it — the self-hosted door asks for one
 * server address rather than a pair of transports, and the standalone door hides its host fields
 * behind the named providers, whose hosts are this app's own facts. The sentence still names the
 * host in both cases, which is what it did before this existed; what is refused is a control that
 * would press into nothing.
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
