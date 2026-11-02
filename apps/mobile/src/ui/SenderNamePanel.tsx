/**
 * "Your name" on a standalone phone — the name each mailbox's letters carry beside its address,
 * written on this phone's own engine (`writeMailboxName`). A paired phone has no such row: the
 * shared route asks a second factor a paired phone never has. Blank stores none, and the letters
 * then go out with the bare address, as before.
 */
import { useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { useConnection } from "../net/connection";
import { writeMailboxName } from "../net/mailboxes";
import { useWorld } from "../state/world";
import { Button, Panel, Rule, Section, Txt } from "./base";
import { Field } from "./Field";
import { senderNameOf } from "./standalone-form";

type Said = { id: string; k: "saved" | "invalid" | "failed" } | null;

export function SenderNamePanel() {
  const w = useWorld();
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  /** What each field holds where it differs from the row; absent shows the row. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** A written name, shown until the roster read catches up. */
  const [written, setWritten] = useState<Record<string, string | null>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  if (!w.standalone || !w.mailboxes.known || session === null || w.mailboxes.rows.length === 0) return null;

  const save = async (id: string, text: string) => {
    const name = senderNameOf(text);
    if (name === undefined) { setSaid({ id, k: "invalid" }); return; }
    setPending(id);
    setSaid(null);
    const out = await writeMailboxName(session, id, name);
    setPending(null);
    if (out.k !== "written") { setSaid({ id, k: "failed" }); return; }
    setWritten((cur) => ({ ...cur, [id]: out.displayName }));
    setDrafts((cur) => { const { [id]: _gone, ...rest } = cur; return rest; });
    setSaid({ id, k: "saved" });
    // The roster is read again after the drain this asks for.
    void conn.syncNow();
  };

  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <Section>{Copy.senderNameTitle}</Section>
      <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
        <Txt variant="note" tone="ink2">{Copy.senderNameNote}</Txt>
      </View>
      {w.mailboxes.rows.map((row, i) => {
        const stored = (row.id in written ? written[row.id] : row.displayName) ?? "";
        const shown = drafts[row.id] ?? stored;
        const dirty = drafts[row.id] !== undefined && drafts[row.id] !== stored;
        const mine = said?.id === row.id ? said.k : null;
        return (
          <View key={row.id}>
            {i > 0 ? <Rule inset={20} /> : null}
            <Field
              value={shown}
              onChange={(v) => { setDrafts((cur) => ({ ...cur, [row.id]: v })); if (mine !== null) setSaid(null); }}
              label={row.address}
              {...(mine === "invalid" ? { error: Copy.standaloneNameRefused } : {})}
              input={{ autoComplete: "name", textContentType: "name", autoCapitalize: "words", returnKeyType: "done" }}
            />
            <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 6 }}>
              {dirty ? (
                <Button
                  label={Copy.senderNameSave}
                  variant="solid"
                  disabled={pending !== null}
                  onPress={() => { void save(row.id, shown); }}
                  style={{ alignSelf: "flex-start" }}
                />
              ) : null}
              {mine === "saved" || mine === "failed" ? (
                <Txt variant="caption" tone={mine === "failed" ? "ink2" : "ink3"} accessibilityRole={mine === "failed" ? "alert" : undefined}>
                  {mine === "saved" ? Copy.senderNameSaved : Copy.senderNameFailed}
                </Txt>
              ) : null}
            </View>
          </View>
        );
      })}
    </Panel>
  );
}
