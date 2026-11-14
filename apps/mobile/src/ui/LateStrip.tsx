/**
 * NEW MAIL IS LATE, OVER THE OHBOX — the web's strip on the phone. The server this phone is paired
 * with answers and says it is not fetching: one calm panel where a person looks for new mail, with
 * no press and no dismissal, because nothing here is theirs to do. It leaves when the next read of
 * the mailboxes says fetching runs again. `late-lines.ts` decides the words; the top bar's line
 * wins while the phone has no network or its server does not answer, the nearer fact.
 */
import { useConnection } from "../net/connection";
import { useNetworkNow } from "../net/network-door";
import { activeLocale } from "../i18n/locale";
import { readerZone, topLineSaid } from "../state/live";
import { useWorld } from "../state/world";
import { Panel, Txt } from "./base";
import { lateStripSaid, lateWho } from "./late-lines";

export function LateStrip() {
  const w = useWorld();
  const conn = useConnection();
  const network = useNetworkNow();
  const top = topLineSaid({
    network, connection: w.boot.connection, stale: w.boot.staleAsOf, draining: w.boot.draining, continuing: null,
  });
  if (top?.alert === true) return null;
  const session = conn.state.k === "live" ? conn.state.session : null;
  const said = lateStripSaid(w.mailboxes.rows, Date.now(), readerZone(), activeLocale(), lateWho(session));
  if (said === null) return null;
  return (
    <Panel style={{ marginHorizontal: 6, marginBottom: 12, padding: 14, gap: 6 }}>
      <Txt variant="body" accessibilityRole="summary">{said.title}</Txt>
      <Txt variant="note" tone="ink2">{said.line}</Txt>
    </Panel>
  );
}
