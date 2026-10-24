/**
 * SETTINGS → THE FILINGS THAT WAIT, for one mailbox: how many, into which folder, why,
 * where they are, and the web block's two presses. It reads `GET /mailboxes/:id/filings` when the
 * mailbox's facts say something waits, and again after each press. Neither press moves mail.
 */
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useConnection } from "../net/connection";
import { leaveFilings, readFilings, retryFilings, type FilingsPress, type PhoneFilingsGroup, type PhoneMailbox } from "../net/mailboxes";
import { readerZone } from "../state/live";
import { Copy } from "../copy";
import { useWorld } from "../state/world";
import { Button, Panel, Txt } from "./base";
import { filingsGroupSaid, filingsPressSaid, filingsWait, filingsWaiting } from "./filing-lines";

/**
 * One block per mailbox of the LIVE account with filings waiting, from the facts the strip reads (the
 * web's `MailboxFilings` rule) — never from This phone's cards, which an account switch leaves on the
 * phone's own engine. A block pressed in this visit stays to say what the press did.
 */
export function FilingsBlocks() {
  const w = useWorld();
  const [pressed, setPressed] = useState<ReadonlySet<string>>(() => new Set());
  const onPressed = useCallback((id: string) => setPressed((p) => (p.has(id) ? p : new Set(p).add(id))), []);
  const rows = w.mailboxes.rows.filter((m) => filingsWait(m) || (pressed.has(m.id) && m.status !== "disabled"));
  if (rows.length === 0) return null;
  return (
    <Panel style={{ paddingVertical: 14, paddingHorizontal: 20, marginBottom: 14, gap: 10 }}>
      {rows.map((m) => <FilingsBlock key={m.id} mailbox={m} onPressed={onPressed} />)}
    </Panel>
  );
}

export function FilingsBlock({ mailbox, onPressed }: { mailbox: PhoneMailbox | undefined; onPressed?: (id: string) => void }) {
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  const [groups, setGroups] = useState<PhoneFilingsGroup[] | null | "unread">(null);
  const [said, setSaid] = useState<FilingsPress | null>(null);
  const [busy, setBusy] = useState(false);
  const waits = mailbox !== undefined && filingsWait(mailbox);
  const id = mailbox?.id ?? "";
  const load = useCallback(async () => {
    if (session === null || id === "") return;
    const read = await readFilings(session, id);
    setGroups(read === null ? "unread" : read);
  }, [session, id]);
  useEffect(() => { if (waits) void load(); }, [waits, load, mailbox?.filing?.stuck, mailbox?.filing?.deferred]);
  if (mailbox === undefined || (!waits && said === null)) return null;
  const press = (act: () => Promise<FilingsPress>) => {
    setBusy(true);
    onPressed?.(id);
    void act().then(async (answer) => { setSaid(answer); await load(); setBusy(false); });
  };
  const zone = readerZone();
  return (
    <View style={{ gap: 4, marginTop: 4 }}>
      <Txt variant="settingsLabel" accessibilityRole="header">
        {Copy.filingsTitle(mailbox.displayName?.trim() || mailbox.address)}
      </Txt>
      {groups === "unread" ? <Txt variant="note" tone="ink2">{Copy.filingsUnread(filingsWaiting(mailbox))}</Txt> : null}
      {Array.isArray(groups) && session !== null ? groups.map((g) => {
        const s = filingsGroupSaid(g, zone);
        return (
          <View key={g.folder} style={{ gap: 2 }}>
            <Txt variant="note">{s.label}</Txt>
            <Txt variant="note" tone="ink2">{s.lines.join(" ")}</Txt>
            <Button label={Copy.filingsRetry} variant="quiet" disabled={busy} style={{ alignSelf: "flex-start" }}
              onPress={() => press(() => retryFilings(session, id, g.folder))} />
            {s.leave ? (
              <Button label={Copy.filingsLeave} variant="quiet" disabled={busy} style={{ alignSelf: "flex-start" }}
                onPress={() => press(() => leaveFilings(session, id, g.folder, g.through!))} />
            ) : null}
          </View>
        );
      }) : null}
      {said === null ? null : <Txt variant="note" tone="ink2" accessibilityRole="alert">{filingsPressSaid(said)}</Txt>}
    </View>
  );
}
