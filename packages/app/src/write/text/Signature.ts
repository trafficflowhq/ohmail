/**
 * THE SIGNATURE under the letter's text, as its send will seal it: written over in place (the letter keeps the new
 * words), and taken off this letter alone. None is drawn until the account's signatures are known, or when the
 * sender has none. A formatted one that follows the sender is drawn as it is sent, by the shell's editor read-only,
 * and takes no keys; its own press makes it plain words to write over, and says that its formatting goes. A field
 * written down to nothing stays, empty, so the caret is never taken from under the person: the letter then goes
 * with no signature (the engine's rule, decided at the send), and Remove takes the field away.
 */
import { createElement } from "react";
import type { ComposerProps } from "@ohmail/ui/mail";
import type { SignatureState } from "@ohmail/client-engine";
import { useText } from "../../text/index.js";
import { useWriteBeside, useWriting } from "../above.js";
import { useWriteParts } from "../parts.js";

/** The signature follows the sender until the person writes over it or takes it off. */
const FOLLOWING: SignatureState = { kind: "following" };

const NOTHING = (): void => undefined;

/** What the letter does once a signature edit still in its field is handed over. */
export type Going = "send" | "leave";

export function useSignature(
  letter: {
    /** The letter's signature state; undefined: it follows the sender. */
    readonly state: SignatureState | undefined;
    readonly mailboxId: string | null;
    readonly set: (next: SignatureState) => void;
  },
  go: Readonly<Record<Going, () => void>>,
): { signature: ComposerProps["signature"]; then: (going: Going) => void } {
  const t = useText("write");
  const w = useWriting();
  const beside = useWriteBeside();
  const { editor: Editor } = useWriteParts();
  const signed =
    w.signatures === "unknown"
      ? null
      : beside.signature(letter.state ?? FOLLOWING, letter.mailboxId, w.signatures);
  const label = t("signature.label");
  const sig = letter.state;
  /* The kit hands the field's words over while they are typed: a send or a leave pressed from inside it goes with
     what is on the screen. */
  const then = (going: Going): void => go[going]();
  const remove = { label: t("signature.remove"), onPress: () => letter.set({ kind: "removed" }) };
  const onChange = (text: string): void => {
    if (text !== (signed?.text ?? "")) letter.set({ kind: "edited", text });
  };
  const written = sig?.kind === "edited" ? sig.text : null;
  /* Written down to nothing: the signer answers none, and the field stays, empty. */
  if (signed === null) {
    if (written === null || written.trim() !== "") return { signature: undefined, then };
    return { signature: { label, text: written, onChange, remove }, then };
  }
  if (signed.html !== null && (sig === undefined || sig.kind === "following")) {
    const words = signed.text;
    return {
      signature: {
        label,
        text: words,
        formatted: createElement(Editor, {
          value: { text: words, html: signed.html },
          onChange: NOTHING,
          label: t("signature.formatted"),
          placeholder: "",
          editable: false,
          focusAtMount: false,
          onSendKey: NOTHING,
          onLeaveKey: NOTHING,
          onHandle: NOTHING,
        }),
        asText: {
          word: t("signature.editAsText"),
          label: t("signature.editAsTextHint"),
          onPress: () => letter.set({ kind: "edited", text: words }),
        },
        remove,
      },
      then,
    };
  }
  return { signature: { label, text: signed.text, onChange, remove }, then };
}
