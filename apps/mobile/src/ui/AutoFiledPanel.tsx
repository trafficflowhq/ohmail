/**
 * "Filed automatically" on the phone — the web Settings row's words and route pair (row 140). What
 * the Screener's auto-apply filed that is still where it put it; Review lists it and Put back
 * returns a message to the Screener, which the pass never files again. Desired state only, so the
 * sentence after a press says where the mail goes. Absent while the read has not answered, could
 * not be made, or found nothing.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import type { ConnectedSession } from "../net/pairing.js";
import { putBackAutoFiled, readAutoFiled, type AutoFiledPage } from "../net/auto-filed";
import { folderName } from "../state/live";
import { Button, Panel, Txt } from "./base";
import { autoFiledSaid, type AutoFiledSaid } from "./auto-filed-said";

/** What the last press answered, as a KIND; the sentence is chosen at render. */
type Said = AutoFiledSaid;

export function AutoFiledPanel({ session }: { session: ConnectedSession }) {
  const [page, setPage] = useState<AutoFiledPage | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);

  const read = useCallback(async () => { setPage(await readAutoFiled(session)); }, [session]);
  useEffect(() => { void read(); }, [read]);

  const line = autoFiledSaid(said);
  if (page === null || page.items.length === 0) {
    return line === null ? null : <Txt variant="caption" tone="ink3" style={{ marginBottom: 14 }}>{line}</Txt>;
  }
  const putBack = async (ids: readonly string[]) => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    const r = await putBackAutoFiled(session, ids);
    setSaid(r === null ? { k: "failed" } : r.putBack.length > 0 ? { k: "done", n: r.putBack.length }
      : r.requested.length > 0 ? { k: "requested" } : { k: "none" });
    await read();
    setBusy(false);
  };
  const n = page.items.length;
  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <View style={{ paddingHorizontal: 20, gap: 6 }}>
        <Txt variant="settingsLabel">{Copy.autoFiledTitle}</Txt>
        <Txt variant="note" tone="ink2">{page.more ? Copy.autoFiledSummaryMore(n) : Copy.autoFiledSummary(n)}</Txt>
      </View>
      <View style={{ paddingHorizontal: 16, marginTop: 12, gap: 10 }}>
        <Button label={open ? Copy.autoFiledHide : Copy.autoFiledReview} onPress={() => setOpen((o) => !o)} />
        {open ? page.items.map((i) => (
          <View key={i.messageId} style={{ gap: 4 }}>
            <Txt variant="body" tone="ink2" numberOfLines={1}>
              {Copy.autoFiledRow(i.from ?? "", i.subject ?? "", folderName(i.to))}
            </Txt>
            <Button label={Copy.autoFiledPutBack} disabled={busy} onPress={() => { void putBack([i.messageId]); }} />
          </View>
        )) : null}
        {open ? (
          <Button label={Copy.autoFiledPutBackAll(n)} disabled={busy} onPress={() => { void putBack(page.items.map((i) => i.messageId)); }} />
        ) : null}
        {line !== null ? <Txt variant="caption" tone="ink3">{line}</Txt> : null}
      </View>
    </Panel>
  );
}
