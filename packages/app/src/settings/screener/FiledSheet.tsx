import { useEffect, useRef, useState } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { ScreenerFiled } from "./model.js";

/**
 * What the Screener filed on its own, still where it put it, each with Put back. Put back returns a letter to the
 * Screener and it is not filed automatically again; where another install organizes, the request is sent there.
 */
export function FiledSheet({ filed }: { readonly filed: ScreenerFiled }) {
  const t = useText("settings");
  const place = useText("place");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ readonly words: string; readonly warn: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const putBack = (ids: readonly string[]) => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    void (async () => {
      try {
        const r = await filed.putBack(ids);
        if (!alive.current) return;
        setSaid({
          warn: false,
          words:
            r.back > 0
              ? t("screening.autoFiledPutBackDone", { count: r.back })
              : r.requested > 0
                ? t("screening.autoFiledRequested")
                : t("screening.autoFiledNone"),
        });
      } catch {
        if (alive.current) setSaid({ words: t("screening.autoFiledFailed"), warn: true });
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  };

  const note = said ? <SettingNote warn={said.warn}>{said.words}</SettingNote> : null;
  const count = filed.letters.length;
  if (count === 0) return note ? <SettingsSheet>{note}</SettingsSheet> : null;
  return (
    <SettingsSheet title={t("screening.autoFiledTitle")} aside={String(count)}>
      <SettingLine
        label={t(filed.more ? "screening.autoFiledSummaryMore" : "screening.autoFiledSummary", { count })}
      >
        <Button kind="quiet" size="s" expanded={open} onPress={() => setOpen((o) => !o)}>
          {t("screening.autoFiledReview")}
        </Button>
      </SettingLine>
      {open ? (
        <>
          {filed.letters.map((letter) => (
            <SettingLine
              key={letter.id}
              label={t("screening.autoFiledRow", {
                from: letter.from ?? "",
                subject: letter.subject ?? "",
                place: place.has(letter.to) ? place(letter.to) : letter.to,
              })}
              narrow="detail"
            >
              <Button kind="quiet" size="s" disabled={busy} onPress={() => putBack([letter.id])}>
                {t("screening.autoFiledPutBack")}
              </Button>
            </SettingLine>
          ))}
          <Button kind="two" size="s" disabled={busy} onPress={() => putBack(filed.letters.map((l) => l.id))}>
            {t("screening.autoFiledPutBackAll", { count })}
          </Button>
        </>
      ) : null}
      {note}
    </SettingsSheet>
  );
}
