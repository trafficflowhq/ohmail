import type { ReactNode } from "react";
import { SendStatus } from "@ohmail/ui/mail";
import { FilesNote } from "../files/Files.js";
import { ForwardRefusal } from "../files/Forwarded.js";
import type { WentElsewhere } from "./elsewhere.js";
import type { saveLines } from "./save-note.js";

/**
 * The lines over the foot: that the letter's row went elsewhere (first, as today's said it above the rest), why a
 * letter whose send waits keeps the place that writes (the composition's sentence, before the send line), what
 * happened to the send, whether the letter is kept (the close refusal, the draft ceiling's line, why a press of Send
 * over a letter that went sent nothing with its offer, the account's refusal, the resumed note: `save-note.ts`), the
 * drafter's sentence, a forward's refusal, the files'.
 */
export function letterNote(
  { wait, send }: { readonly wait: string | null; readonly send: ReactNode | null },
  saving: ReturnType<typeof saveLines>,
  long: string | null,
  notice: string | null,
  refusal: string | null,
  files: string | null,
  went: WentElsewhere,
): ReactNode {
  const kept = [...saving.before, ...saving.after];
  if (
    went.note === null &&
    wait === null &&
    send === null &&
    kept.length === 0 &&
    long === null &&
    notice === null &&
    refusal === null &&
    files === null
  )
    return undefined;
  return (
    <>
      {went.note !== null ? <SendStatus place="start">{went.note}</SendStatus> : null}
      {wait !== null ? <SendStatus place="start">{wait}</SendStatus> : null}
      {send}
      {saving.before.map((line) => (
        <SendStatus key={line} place="start">
          {line}
        </SendStatus>
      ))}
      {long !== null ? <SendStatus place="start">{long}</SendStatus> : null}
      {went.told && went.refusal !== null ? (
        <SendStatus
          place="foot"
          acts={went.offers ? [{ label: went.offerLabel, onPress: went.sendAsNew }] : undefined}
        >
          {went.refusal}
        </SendStatus>
      ) : null}
      {saving.after.map((line) => (
        <SendStatus key={line} place="start">
          {line}
        </SendStatus>
      ))}
      {notice !== null ? (
        <SendStatus place="end" sign="spark">
          {notice}
        </SendStatus>
      ) : null}
      {refusal !== null ? <ForwardRefusal sentence={refusal} /> : null}
      {files !== null ? <FilesNote sentence={files} /> : null}
    </>
  );
}
