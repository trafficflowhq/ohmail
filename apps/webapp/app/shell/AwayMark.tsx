"use client";

/**
 * "Answered by the away responder · <when>" — one quiet line on the message that was answered.
 * The mark is on the ORIGINAL, not the reply: the reply lands in Sent, where nobody is looking;
 * the server decides (`MessageDTO.awayRepliedAt` — the `away_replies` ledger is not mirrored) and
 * the reply's own row carries `autoReplyByUs` instead. A fact, not an alert: text only, one ink,
 * no badge — automatic mail is not engagement. `role="note"` with the LONG label: " · 2h" is a
 * relative stamp a screen reader cannot resolve, so the accessible name carries the absolute
 * instant. Rendered iff non-null; `undefined` (older build or server), `null` (the ledger says
 * never) and an unparseable instant all render nothing — never "Invalid Date" beside a claim.
 */
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { displayTime, fullDateTime } from "./format";

export function AwayMark({
  message,
  now,
}: {
  /** Only the stamp is read. A `Pick` so a caller need not own a whole message to draw one. */
  message: Pick<EngineMessage, "awayRepliedAt">;
  /** The shell's frozen render clock — the same reference every stamp in the panel is read at. */
  now: Date;
}) {
  const tm = useTranslations("message");
  const at = message.awayRepliedAt;
  if (!at) return null;

  const label = tm("awayAnswered");
  /* The list's own relative-time formatter, applied to the responder's instant rather than to
     the message's — `messageStamp` takes `{ date }`, so this is the same three bands (clock /
     weekday+clock / dated) every other stamp in the product is read in, in the reader's zone and
     locale. A stamp it cannot format is "", and then the label stands alone. */
  const when = displayTime({ date: at }, now);
  const whenLong = fullDateTime({ date: at });

  return (
    <span
      className="away-mark"
      role="note"
      /* The absolute instant where there is one; the bare label otherwise, so the accessible
         name is never the string "Answered by the away responder " with a dangling space. */
      aria-label={whenLong ? tm("awayAnsweredAria", { whenLong }) : label}
    >
      {/*
        One catalogue string, and the stamp is a tag inside it: `awayAnsweredAt` is
        `{label}<stamp> · {when}</stamp>`, read through `t.rich` so the separator stays
        translatable — punctuation a language may set differently — while the part CSS hides below
        640 px is still its own element. Composing " · " here would put copy in the markup (the
        copy census refuses that shape); flat interpolation would leave nothing for the media rule
        to hide — the dot travels WITH the stamp and disappears with it. No stamp (an instant that
        does not parse — `displayTime` answers "") ⇒ the bare label, not a template with a hole.
      */}
      {when
        ? tm.rich("awayAnsweredAt", {
            label,
            when,
            stamp: (chunks) => <span className="when">{chunks}</span>,
          })
        : label}
    </span>
  );
}
