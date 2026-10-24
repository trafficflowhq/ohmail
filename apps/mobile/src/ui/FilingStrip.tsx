/**
 * THE FILINGS THAT WAIT, OVER THE OHBOX AND IN SETTINGS — the web's strip on the phone, which had
 * none: a Move into a folder the server refused said done and nothing anywhere said otherwise.
 * `filing-lines.ts` decides the words from the mailbox facts the world already reads; the Ohbox's
 * copy links to Settings, where the block per mailbox carries Try again and Leave.
 */
import { router } from "expo-router";
import { useWorld } from "../state/world";
import { readerZone } from "../state/live";
import { Copy } from "../copy";
import { Button, Panel, Txt } from "./base";
import { filingStripSaid } from "./filing-lines";

export function FilingStrip({ link = false }: { link?: boolean }) {
  const w = useWorld();
  const said = filingStripSaid(w.mailboxes.rows, Date.now(), readerZone());
  if (said === null) return null;
  return (
    <Panel style={{ marginHorizontal: 6, marginBottom: 12, padding: 14, gap: 6 }}>
      <Txt variant="body" accessibilityRole={said.warn ? "alert" : "summary"}>{said.title}</Txt>
      <Txt variant="note" tone="ink2">{said.detail}</Txt>
      {link ? (
        <Button label={Copy.filingStripOpen} variant="quiet" style={{ alignSelf: "flex-start" }} onPress={() => router.push("/settings")} />
      ) : null}
    </Panel>
  );
}
