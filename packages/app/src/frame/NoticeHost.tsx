/**
 * THE ONE NOTICE SLOT, drawn with the kit's `NoticeSlot`: the first in full, the others behind one line.
 * The frame holds which one a press brought to the front and whether the others are listed; once the
 * one in front is gone, the order stands again.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { NoticeSlot } from "@ohmail/ui/base";
import type { NoticeStore } from "./notice-store.js";
import { useText, useTextPending } from "../text/index.js";

function staysFolded(known: readonly string[] | undefined, failures: readonly string[] = []): boolean {
  return known !== undefined && failures.every((id) => known.includes(id));
}

export function NoticeHost({
  store,
  place,
  feed,
}: {
  store: NoticeStore;
  place: "rail" | "bar";
  feed?: string;
}) {
  const t = useText("frame");
  const stored = useSyncExternalStore(store.subscribe, store.read, store.read);
  /* While the catalogue is on its way a notice may have no title yet: it waits, and is drawn with its words. */
  const pending = useTextPending();
  const notices = stored.filter(
    (n) => (feed === undefined || n.feed === feed) && (!pending || n.title !== ""),
  );
  const [folded, setFolded] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  useEffect(() => {
    setFolded((was) => {
      const standing = new Map(was);
      for (const [id, known] of was) {
        const notice = stored.find((n) => n.id === id);
        if (!notice || !staysFolded(known, notice.failedSendIds)) standing.delete(id);
      }
      return standing.size === was.size ? was : standing;
    });
  }, [stored]);

  const [front, setFront] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const standing = front !== undefined && notices.some((n) => n.id === front);

  useEffect(() => {
    if (front !== undefined && !standing) setFront(undefined);
  }, [front, standing]);
  useEffect(() => {
    if (open && notices.length < 2) setOpen(false);
  }, [open, notices.length]);

  const count = Math.max(0, notices.length - 1);
  /* The kit's notice is a status. Signed out is said at once, as today's stopped strip was: an alert. */
  const alert = notices.find((n) => n.id === "signedOut");
  return (
    <>
      <NoticeSlot
        place={place}
        notices={notices.map((notice) => {
          if (!notice.collapsible) return notice;
          const collapsed = staysFolded(folded.get(notice.id), notice.failedSendIds);
          return {
            ...notice,
            title:
              collapsed && notice.id === "notSent" && notice.line ? t("notice.sendFailed") : notice.title,
            disclosure: {
              collapsed,
              label: t(collapsed ? "notice.show" : "notice.collapse"),
              onPress: () =>
                setFolded((was) => {
                  const next = new Map(was);
                  if (collapsed) next.delete(notice.id);
                  else next.set(notice.id, notice.failedSendIds ?? []);
                  return next;
                }),
            },
          };
        })}
        front={standing ? front : undefined}
        onFront={setFront}
        more={{
          label: t("notice.more", { count }),
          name: t("notice.moreName", { count }),
          collapse: t("notice.showFewer"),
        }}
        open={open}
        onOpen={setOpen}
      />
      {alert ? (
        <p className="fr-hidden" role="alert">
          {alert.line ? `${alert.title}. ${alert.line}` : alert.title}
        </p>
      ) : null}
    </>
  );
}
