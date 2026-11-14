/**
 * THE ONE NOTICE SLOT, drawn with the kit's `NoticeSlot`: the first in full, the others behind one line.
 * The frame holds which one a press brought to the front and whether the others are listed; once the
 * one in front is gone, the order stands again.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { NoticeSlot } from "@ohmail/ui/base";
import type { NoticeStore } from "./notice-store.js";
import { useText, useTextPending } from "../text/index.js";

export function NoticeHost({ store, place }: { store: NoticeStore; place: "rail" | "bar" }) {
  const t = useText("frame");
  const stored = useSyncExternalStore(store.subscribe, store.read, store.read);
  /* While the catalogue is on its way a notice may have no title yet: it waits, and is drawn with its words. */
  const pending = useTextPending();
  const notices = pending ? stored.filter((n) => n.title !== "") : stored;
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
        notices={notices}
        front={standing ? front : undefined}
        onFront={setFront}
        more={{ label: t("notice.more", { count }), name: t("notice.moreName", { count }) }}
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
