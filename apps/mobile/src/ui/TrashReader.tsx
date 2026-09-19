/**
 * The Trash reading card — one deleted message, off-mirror. `MessageReader` cannot serve here:
 * it reads the mirror, and a delete TOMBSTONED this row in every mirror, so the card renders
 * from the page's own row (`state/trash-hold.ts`) — sender, subject, when it was deleted,
 * where a restore puts it, the stored preview — and STATES the preview boundary rather than
 * pretending a body it does not have. One verb, Restore: the delete's inverse move, dispatched
 * through the world; `true` is the row leaving (the toast is the action's own sentence).
 */
import { useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { heldTrashRow, dropTrashRow } from "../state/trash-hold";
import { useWorld } from "../state/world";
import { Button, Panel, Screen, Scroller, Txt } from "./base";
import { DetailBar } from "./chrome";

export function TrashReader({
  id,
  onRestored,
  onClose,
}: {
  id: string;
  /** The row left Trash — the list drops it; the pushed route goes back. */
  onRestored: (id: string) => void;
  onClose?: () => void;
}) {
  const w = useWorld();
  const row = heldTrashRow(id);
  const [busy, setBusy] = useState(false);

  if (!row) {
    // A restored or re-fetched-away id — the folder screen's honest gone sentence, one place over.
    return (
      <Screen>
        <DetailBar title={Copy.trashTitle} />
        <Scroller>
          <Txt variant="note" tone="ink3" style={{ padding: 20 }}>
            {Copy.trashRowGone}
          </Txt>
        </Scroller>
      </Screen>
    );
  }

  const m = row.mail;
  const restore = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await w.actions.trashRestore(m.id);
    if (ok) {
      dropTrashRow(m.id);
      onRestored(m.id);
      onClose?.();
      return;
    }
    // Refused — the action spoke the sentence; the row stays and the button re-arms.
    setBusy(false);
  };

  return (
    <Screen>
      <DetailBar title={Copy.trashTitle} />
      <Scroller>
        <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 4 }}>
          <Txt variant="h1">{m.subject}</Txt>
          <Txt variant="meta" tone="ink2" numberOfLines={1}>
            {m.from.name === m.from.address ? m.from.address : Copy.trashFromLine(m.from.name, m.from.address)}
          </Txt>
          {row.deletedWhen ? (
            <Txt variant="caption" tone="ink3">
              {Copy.trashDeletedAt(row.deletedWhen)}
            </Txt>
          ) : null}
        </View>

        <Panel style={{ marginTop: 14, paddingHorizontal: 16, paddingVertical: 14, gap: 10 }}>
          {m.snippet ? <Txt variant="body">{m.snippet}</Txt> : null}
          {/* The boundary, stated: this build reads no deleted body from the server. */}
          <Txt variant="caption" tone="ink3">
            {Copy.trashPreviewNote}
          </Txt>
        </Panel>

        <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 10 }}>
          <Txt variant="note" tone="ink2">
            {Copy.trashRestoresTo(row.restoreLabel)}
          </Txt>
          <Button
            label={busy ? Copy.trashRestoring : Copy.trashRestore}
            variant="solid"
            onPress={() => void restore()}
            accessibilityLabel={Copy.trashRestore}
          />
          <Txt variant="caption" tone="ink3">
            {Copy.trashNoErase}
          </Txt>
        </View>
      </Scroller>
    </Screen>
  );
}
