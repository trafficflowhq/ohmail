/**
 * WHAT STANDS ABOVE THE SCREEN, and the only place it is stood: the composition as the screen reads it, and the
 * shell's helpers beside it. Nothing standing above is a mistake, said at once: a default would send nothing, keep
 * nothing, or keep it under nobody's scope.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type { PanelVerb } from "@ohmail/ui/mail";
import type { WriteBeside, Writing } from "./ports.js";

const WritingContext = createContext<Writing | null>(null);
const BesideContext = createContext<WriteBeside | null>(null);

/** The open reply's verbs, handed from its sheet to the reading sheet's one panel (`ReaderReply.useVerbs`). */
interface ReplyVerbs {
  readonly verbs: readonly PanelVerb[] | null;
  readonly publish: (verbs: readonly PanelVerb[] | null) => void;
}
const VerbsContext = createContext<ReplyVerbs | null>(null);

export function WriteAbove({
  writing,
  beside,
  children,
}: {
  writing: Writing;
  beside: WriteBeside;
  children: ReactNode;
}) {
  const [verbs, publish] = useState<readonly PanelVerb[] | null>(null);
  const said = useMemo(() => ({ verbs, publish }), [verbs]);
  return (
    <WritingContext.Provider value={writing}>
      <BesideContext.Provider value={beside}>
        <VerbsContext.Provider value={said}>{children}</VerbsContext.Provider>
      </BesideContext.Provider>
    </WritingContext.Provider>
  );
}

function useVerbsChannel(): ReplyVerbs {
  const said = useContext(VerbsContext);
  if (said === null) throw new Error("a part of write was drawn with no composition above it (WriteAbove)");
  return said;
}

/** The open reply's verbs, for the panel of the column it stands in; null while no reply's sheet stands. */
export function useReplyVerbs(): readonly PanelVerb[] | null {
  return useVerbsChannel().verbs;
}

/** The reply's sheet hands its verbs to the panel while it stands, and takes them back when it goes. */
export function usePublishVerbs(verbs: readonly PanelVerb[]): void {
  const { publish } = useVerbsChannel();
  useLayoutEffect(() => {
    publish(verbs);
    return () => publish(null);
  }, [publish, verbs]);
}

export function useWriting(): Writing {
  const writing = useWritingIfMounted();
  if (writing === null)
    throw new Error("a part of write was drawn with no composition above it (WriteAbove)");
  return writing;
}

export function useWritingIfMounted(): Writing | null {
  return useContext(WritingContext);
}

export function useWriteBeside(): WriteBeside {
  const beside = useContext(BesideContext);
  if (beside === null) throw new Error("a part of write was drawn with nothing beside it (WriteAbove)");
  return beside;
}
