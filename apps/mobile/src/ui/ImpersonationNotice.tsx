/**
 * THE LETTERS OHMAIL FILED TO SPAM FOR CLAIMING A COMPANY, on the phone's Screener tab — the web
 * header's one line (`impersonation-notice.ts` decides what it counts). Read when the tab mounts and
 * after a Put back; Review lists each with the claim's sentence and Put back, OK records the newest
 * as seen on this phone. Absent while unread, unanswered, or with nothing new. No toast.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import type { ConnectedSession } from "../net/pairing.js";
import { putBackAutoFiled, readAutoFiled, type AutoFiledItem } from "../net/auto-filed";
import { usePrefs } from "../state/store";
import { Button, Panel, Txt } from "./base";
import { autoFiledSaid, type AutoFiledSaid } from "./auto-filed-said";
import { impersonationWhy, newestSeen, unseenImpersonations } from "./impersonation-notice";

export function ImpersonationNotice({ session }: { session: ConnectedSession }) {
  const prefs = usePrefs();
  const seen = prefs.impersonationSeen ?? "";
  const [items, setItems] = useState<AutoFiledItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<AutoFiledSaid>(null);
  const [asked, ask] = useReducer((n: number) => n + 1, 0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    let live = true;
    void readAutoFiled(session).then((page) => { if (live) setItems(page === null ? null : page.items); });
    return () => { live = false; };
  }, [session, asked]);

  if (items === null) return null;
  const unseen = unseenImpersonations(items, seen);
  if (unseen.length === 0) return null;
  const putBack = async (ids: readonly string[]) => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    const r = await putBackAutoFiled(session, ids);
    if (!alive.current) return;
    setSaid(r === null ? { k: "failed" } : r.putBack.length === 0 && r.requested.length > 0 ? { k: "requested" } : null);
    setBusy(false);
    ask();
  };
  const line = autoFiledSaid(said);
  return (
    <Panel style={{ marginHorizontal: 6, marginBottom: 12, padding: 14, gap: 10 }}>
      <Txt variant="note" tone="ink">{Copy.impersonationFiled(unseen.length)}</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label={open ? Copy.autoFiledHide : Copy.autoFiledReview} variant="quiet" onPress={() => setOpen((o) => !o)} />
        <Button label={Copy.impersonationOk} variant="quiet" disabled={busy} onPress={() => {
          prefs.setImpersonationSeen?.(newestSeen(unseen, seen));
          setOpen(false);
        }} />
      </View>
      {open ? unseen.map((i) => (
        <View key={i.messageId} style={{ gap: 4 }}>
          <Txt variant="body" tone="ink2" numberOfLines={1}>{Copy.impersonationRow(i.from ?? "", i.subject ?? "")}</Txt>
          <Txt variant="caption" tone="ink3">{impersonationWhy(i)}</Txt>
          <Button label={Copy.autoFiledPutBack} disabled={busy} onPress={() => { void putBack([i.messageId]); }} />
        </View>
      )) : null}
      {open ? (
        <Button label={Copy.autoFiledPutBackAll(unseen.length)} disabled={busy}
          onPress={() => { void putBack(unseen.map((i) => i.messageId)); }} />
      ) : null}
      {line !== null ? <Txt variant="caption" tone="ink3">{line}</Txt> : null}
    </Panel>
  );
}
