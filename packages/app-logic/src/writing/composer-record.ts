/**
 * THE ONE COMPOSER'S RECORD, for the parts that stand beside it: what `useShellCompose` answers, as the mount that
 * calls it once per frame provides it. The send machine (the restart hold's relay, the notices that say a send's
 * state), the drafts' doors, the door back to a letter that was not sent. A part reads it with `useComposer()` and
 * never calls the composer or a send machine of its own. The screen that writes reads its own port, not this.
 */
import { createContext, useContext, type Context } from "react";
import type { ShellCompose } from "./shell-compose.js";

/** Filled by the composer's one mount, once per mounted frame. Read it with {@link useComposer}. */
export const ComposerContext: Context<ShellCompose | undefined> = createContext<ShellCompose | undefined>(
  undefined,
);

/** The composer's record of this frame. Throws where no composer stands above: nothing is sent over a guess. */
export function useComposer(): ShellCompose {
  const composer = useContext(ComposerContext);
  if (composer === undefined) throw new Error("useComposer: no composer stands above (ComposerContext)");
  return composer;
}
