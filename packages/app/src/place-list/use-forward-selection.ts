import { useState } from "react";
import type { EngineMessage } from "@ohmail/wire";
import type { PanelVerb } from "@ohmail/ui/mail";
import { useFrame } from "../frame/commands.js";
import { useText } from "../text/index.js";
import { useWritingIfMounted } from "../write/above.js";

export function useForwardSelection(
  ids: readonly string[],
  clear: () => void,
  conversations?: () => readonly string[],
): PanelVerb | undefined {
  const { host } = useFrame();
  const label = useText("ohbox")("row.forward");
  const forward = useWritingIfMounted()?.forwardSelection;
  const [pending, setPending] = useState(false);
  if (!forward || ids.length < 2) return undefined;

  const press = async () => {
    const read = host.engine.verbRead();
    const picked = new Map<string, EngineMessage>();
    for (const id of ids) {
      const message = read.get<EngineMessage>("message", id);
      if (!message) return;
      picked.set(id, message);
    }
    setPending(true);
    try {
      if (await forward([...picked.values()], conversations?.())) clear();
    } finally {
      setPending(false);
    }
  };
  return { id: "forward", label, icon: "forward", rank: 0, disabled: pending, onPress: () => void press() };
}
