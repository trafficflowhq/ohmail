/**
 * THE LETTER'S KEYS while its column has them, from any of its fields: Mod+Enter sends, Escape leaves. A key the
 * editor took (it prevents it) reaches no binding; an open card closes first (the overlay's own Escape).
 */
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
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
