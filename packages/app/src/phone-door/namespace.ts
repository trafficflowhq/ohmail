/**
 * THE WORDS THE WAYS IN READ: their own (`phoneDoor`), and the phone's refusals (`phoneRefusal`), said by their code
 * through the one reader of a refusal. A refusal is never drawn by its code, and a request the bridge refused (a
 * deadline, a page that ended, a native throw) says the unknown sentence: the bridge's own word is no sentence.
 */
import { useCallback } from "react";
import { sayRefusal } from "@ohmail/app-logic/phone/said";
import { useText, type Text } from "../text/index.js";
import type { SaidRefusal } from "./contract.js";

export const PHONE_DOOR_NAMESPACES = ["phoneDoor", "phoneRefusal"] as const;

/** The sentence this build says where it cannot say why. */
const UNKNOWN: SaidRefusal = Object.freeze({ code: "unknown", args: Object.freeze([]) });

export interface DoorWords {
  /** `phoneDoor`'s sentences. */
  readonly t: Text;
  /** A refusal in words; null (a rejected request, an unreadable answer) is the unknown sentence. */
  say(said: SaidRefusal | null): string;
}

export function useDoorWords(): DoorWords {
  const t = useText("phoneDoor");
  const r = useText("phoneRefusal");
  const say = useCallback((said: SaidRefusal | null) => sayRefusal(r, said ?? UNKNOWN), [r]);
  return { t, say };
}
