import type { SearchHit } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useStableCallback } from "../press/stable-callback.js";
import { readerMessageFor } from "./open-target.js";

/** Open the selected result in Search. A preview walk updates the same browser history entry. */
export function useSearchOpen(
  args: PlaceLiveArgs,
  fromMirror: (id: string) => EngineMessage | undefined,
  isGone: (id: string) => boolean,
  carry: (message: EngineMessage) => void,
): (hit: SearchHit, words: Readonly<Record<string, string>>, entered?: boolean) => void {
  return useStableCallback((hit, words, entered = true) => {
    const message = readerMessageFor(hit.message.id, fromMirror, hit.message, isGone);
    if (message === null || message === "gone") return;
    carry(message);
    args.commands.go(
      { ...args.route, open: message.id, words },
      {
        entered: entered ? true : undefined,
        replace: args.route.open === null ? undefined : true,
        history: "preview",
      },
    );
  });
}
