"use client";

/**
 * "ANSWERED BY THE AWAY RESPONDER · <when>" — one quiet line on the message that was answered.
 *
 * ── WHY THE MARK IS HERE AND NOT ON THE REPLY ───────────────────────────────────────────────
 *
 * The responder's reply lands in Sent, and a reader has no reason to be looking there. So the
 * fact belongs on the ORIGINAL: you come back, open the mail, and the message itself says that a
 * machine has already answered it on your behalf, and when. The server decides that
 * (`MessageDTO.awayRepliedAt` — the `away_replies` ledger is not mirrored, so nothing here could
 * compute it), and the reply's own row carries `autoReplyByUs` instead. Both facts exist, and
 * they are on different messages on purpose; nothing marks the Sent copy.
 *
 * ── A FACT, NOT AN ALERT ────────────────────────────────────────────────────────────────────
 *
 * Text only — no icon (the message header has no icon idiom on its meta lines), one ink
 * (`--ink3`), no hover, no focus, not in the tab order, no motion, and never a badge. Automatic
 * mail is not engagement and must not read as any: the responder's reply is deliberately kept out
 * of the Ohbox's "Earlier", and a mark that shouted here would put back on screen exactly what
 * that keeps off it.
 *
 * `role="note"` with the LONG label, because the short line's " · 2h" is a relative stamp a
 * screen reader cannot resolve against anything; the accessible name names the absolute instant
 * instead. Below 640 px the `· when` span is hidden by CSS and the label alone remains — the aria
 * text is unchanged there, so the narrow rendering loses no information for a reader using one.
 *
 * ── RENDERED IFF NON-NULL, AND ABSENT MEANS THE SAME AS NULL ────────────────────────────────
 *
 * `undefined` arrives from a mirror row written by a build older than the field and from a SERVER
 * older than it; `null` means the server asked its ledger and the responder never answered this
 * message. All three of those render nothing, which is the behaviour every mirror had before the
 * field existed. There is deliberately no fourth state: a mark nobody can substantiate would be a
 * sentence on screen that no data supports.
 *
 * An instant that does not parse renders nothing too — `displayTime` and `fullDateTime` both
 * answer "" for one — rather than "Invalid Date" beside a claim about a correspondent.
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
        ── ONE CATALOGUE STRING, AND THE STAMP IS A TAG INSIDE IT ────────────────────────────
        `awayAnsweredAt` is `{label}<stamp> · {when}</stamp>`, read through `t.rich` so the
        separator stays TRANSLATABLE — it is punctuation a language may want to set differently
        — while the part CSS hides below 640 px is still its own element. Composing " · " here
        instead would have put copy in the markup, which is the exact shape the copy census
        exists to refuse; interpolating the whole line as flat text would have left nothing for
        the media rule to hide. The dot therefore travels WITH the stamp and disappears with it,
        so the narrow rendering never shows a separator introducing nothing.

        No stamp (a message whose instant does not parse — `displayTime` answers "") ⇒ the bare
        label, not a template with an empty hole in it.
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
