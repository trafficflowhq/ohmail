/**
 * THE LETTER'S BODY AS THE READER MOUNTS IT: the body package's renderer, in its sheet look, handed the app's scheme,
 * the session's scope for what it keeps, and its words in the person's language. Nothing of the letter is built or
 * changed here: the text and the markup are the engine's, the pictures' inputs the shell's.
 */
import { MessageBody } from "@ohmail/letter-body";
import { setBodyWords } from "@ohmail/letter-body/words";
import { useLocale, useText } from "../../text/index.js";
import type { LetterProps } from "../ports.js";

export function LetterBody(props: LetterProps) {
  const locale = useLocale();
  const mailBody = useText("mailBody");
  const bodyText = useText("bodyText");
  /* The body reads its sentences from a register at render: handed here, in render, before it draws. */
  setBodyWords({ locale, translatorOf: (namespace) => (namespace === "mailBody" ? mailBody : bodyText) });
  return <MessageBody {...props} look="sheet" />;
}
