/**
 * A NOTICE'S MORE, open: the kit's dialog over the app with the notice's sentence, its line and its rows, a list, and
 * the way out. It follows the notice as it is said now, and a notice that leaves takes it with it. The frame draws it
 * once, beside the slot, whichever column the slot stands in.
 */
import { useSyncExternalStore } from "react";
import { Dialog } from "@ohmail/ui/base";
import type { NoticeStore } from "./notice-store.js";
import { useText } from "../text/index.js";

export function NoticeMore({ store }: { store: NoticeStore }) {
  const t = useText("frame");
  const more = useSyncExternalStore(store.subscribe, store.readMore, store.readMore);
  if (more === null) return null;
  return (
    <Dialog
      open
      onClose={store.closeMore}
      title={more.title}
      line={more.line}
      list
      cancel={{ label: t("notice.moreClose") }}
    >
      {more.rows.map((row) => (
        <p key={row} role="listitem" className="oh-text">
          {row}
        </p>
      ))}
    </Dialog>
  );
}
