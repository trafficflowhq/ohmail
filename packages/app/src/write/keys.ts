/**
 * THE LETTER'S KEYS while its column has them, from any of its fields: Mod+Enter sends, Escape leaves. A key the
 * editor took (it prevents it) reaches no binding; an open card closes first (the overlay's own Escape).
 */
import { useContext, useEffect } from "react";
import { KeymapContext, useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { useText } from "../text/index.js";

type Press = () => void;

export function useLetterKeys(keysHere: boolean, mayGo: boolean, send: Press, leave: Press): void {
  const t = useText("write");
  useOptionalKeyBindings(
    keysHere
      ? [
          {
            chord: "mod+Enter",
            group: "message",
            label: t("keys.send"),
            run: () => send(),
            disabled: !mayGo,
            inInput: true,
            inWriting: true,
          },
          {
            chord: "Escape",
            group: "message",
            label: t("keys.leave"),
            run: () => leave(),
            inInput: true,
            inWriting: true,
          },
        ]
      : [],
  );
}

/**
 * THE REPLY'S KEYS while it stands and the reading column has the keys, from any of its fields (its people, its
 * subject, its text): Mod+Enter presses its send, Escape leaves it, as today's shell bound them while a reply stood.
 * Its send's press decides what a refused send says (the composition's own `sendReply` where nobody is named). Escape
 * stands with the overlays, so the reply is closed before the letter it answers; Mod+Enter with the views, so a
 * dialog over the reply keeps it. The reader's letter keys stand outside text and give way inside the reply.
 */
export function useReplyKeys(keysHere: boolean, then: (going: "send" | "leave") => void): void {
  const t = useText("write");
  const writing = { group: "message", inInput: true, inWriting: true } as const;
  useOptionalKeyBindings(
    keysHere ? [{ chord: "mod+Enter", label: t("keys.send"), run: () => then("send"), ...writing }] : [],
  );
  useOptionalKeyBindings(
    keysHere ? [{ chord: "Escape", label: t("keys.leave"), run: () => then("leave"), ...writing }] : [],
    "overlay",
  );
}

/**
 * THE LETTER IS A WRITING SURFACE while its column has the keys: focus is one blur away from nowhere (a press on
 * dead space), and a key typed then is prose, never a verb of the mail behind the letter or a walk away from it
 * (`/`, `g o`, a digit). The registry's claim (`claimWriting`, today's compose held it for as long as it stood):
 * Escape, Tab, Enter and Mod chords still pass, and a binding of the letter's own opts back in (`inWriting`).
 * Taken from the registry when one stands, as the letter's keys are (`useOptionalKeyBindings`); a kept letter whose
 * column lost the keys holds no claim, so the place shown beside it keeps its keys.
 */
export function useLetterWriting(keysHere: boolean): void {
  const keys = useContext(KeymapContext);
  useEffect(() => (keysHere && keys ? keys.claimWriting() : undefined), [keysHere, keys]);
}
