"use client";

/**
 * THE TWO DOORS OF A LETTER, MOUNTED ABOVE THE PANES: the one file door and the one picture door of a mounted frame,
 * provided to every place (`useDoors()`). Each hook is called here once, over the inputs the ground reads off its
 * host and the consent row above (`door-inputs.ts`, where nothing defaults): the picture door stands only over a
 * host that names a picture wire, and no letter loads a picture by itself before the row's live answer.
 */
import { useMemo, type ReactNode } from "react";
import { useEngine } from "@ohmail/app-logic/engine";
import { useMessageAttachments } from "@ohmail/app-logic/reader/attachments";
import { DoorsContext, type Doors } from "@ohmail/app-logic/reader/doors";
import { useRemoteImages } from "@ohmail/app-logic/reader/remote-images";
import { useDoorInputs } from "./door-inputs.js";

export function DoorsMount({ children }: { readonly children: ReactNode }): ReactNode {
  const inputs = useDoorInputs();
  const files = useMessageAttachments(useEngine(), inputs.files.messageId, inputs.files.options);
  const pictures = useRemoteImages(inputs.pictures);
  /* One record while neither door moved: a reader renders when a door does. */
  const doors = useMemo((): Doors => ({ files, pictures }), [files, pictures]);
  return <DoorsContext.Provider value={doors}>{children}</DoorsContext.Provider>;
}
