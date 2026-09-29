"use client";

/**
 * "Filed automatically" — what the Screener's auto-apply filed that is still where it put it, under
 * the switch that turned it on (row 140). Review opens the list; Put back returns a message to the
 * Screener through the move door and the pass never files it again. It writes desired state only,
 * so the sentence after a press says where the mail goes, never that it has moved. Absent while
 * the read has not answered, failed, or found nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsRow } from "@ohmail/ui";
import { placeLabel } from "./format";
import { screenerAutoFiled, type AutoFiledWire } from "../api-client";

export function AutoFiledReview() {
  const t = useTranslations("settings");
  const [page, setPage] = useState<AutoFiledWire | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const alive = useRef(true);

  const read = useCallback(async () => {
    try {
      const next = await screenerAutoFiled.get();
      if (alive.current) setPage(next);
    } catch {
      if (alive.current) setPage(null);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void read();
    return () => { alive.current = false; };
  }, [read]);

  if (page === null || page.items.length === 0) {
    return said ? <span className="scn-sg-note">{said}</span> : null;
  }

  const putBack = (ids: readonly string[]) => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    void (async () => {
      try {
        const r = await screenerAutoFiled.undo(ids);
        if (!alive.current) return;
        setSaid(r.putBack.length > 0 ? t("screening.autoFiledPutBackDone", { count: r.putBack.length })
          : r.requested.length > 0 ? t("screening.autoFiledRequested") : t("screening.autoFiledNone"));
        await read();
      } catch {
        if (alive.current) setSaid(t("screening.autoFiledFailed"));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  };

  const count = page.items.length;
  return (
    <>
      <SettingsRow
        label={t("screening.autoFiledTitle")}
        description={t(page.more ? "screening.autoFiledSummaryMore" : "screening.autoFiledSummary", { count })}
        control={
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {t("screening.autoFiledReview")}
          </Button>
        }
      />
      {open ? (
        <div className="scn-autofiled">
          <ul>
            {page.items.map((i) => (
              <li key={i.messageId} className="scn-autofiled-row">
                <span className="scn-autofiled-what">
                  {t("screening.autoFiledRow", { from: i.from ?? "", subject: i.subject ?? "", place: placeLabel(i.to) })}
                </span>
                <Button variant="ghost" disabled={busy} onClick={() => putBack([i.messageId])}>
                  {t("screening.autoFiledPutBack")}
                </Button>
              </li>
            ))}
          </ul>
          <Button disabled={busy} aria-busy={busy || undefined} onClick={() => putBack(page.items.map((i) => i.messageId))}>
            {t("screening.autoFiledPutBackAll", { count })}
          </Button>
        </div>
      ) : null}
      {said ? <span className="scn-sg-note">{said}</span> : null}
    </>
  );
}
