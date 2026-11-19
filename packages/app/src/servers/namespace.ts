/**
 * THE WORDS THE LIST READS: its own (`servers`), and the phone's refusals (`phoneRefusal`), said by their code through
 * the one reader of a refusal. A refusal is never drawn by its code.
 */
import { useCallback } from "react";
import { sayRefusal } from "@ohmail/app-logic/phone/said";
import { useText, type Text } from "../text/index.js";
import type { SaidRefusal } from "./contract.js";

export const SERVERS_NAMESPACES = ["servers", "phoneRefusal"] as const;

export interface ServersWords {
  /** `servers`' sentences. */
  readonly t: Text;
  /** A refusal in words. */
  say(said: SaidRefusal): string;
}

export function useServersWords(): ServersWords {
  const t = useText("servers");
  const r = useText("phoneRefusal");
  const say = useCallback((said: SaidRefusal) => sayRefusal(r, said), [r]);
  return { t, say };
}
