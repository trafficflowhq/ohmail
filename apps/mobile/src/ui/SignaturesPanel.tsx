/**
 * Signatures on the phone — one text signature per mailbox, written where the web and the desktop
 * app read it (`writeSignature`). A signature with formatting, or one the organizing install
 * published, is shown and not offered for change (`signature-rows.ts`). An edit not saved holds
 * the screen: Back asks first, as the away screen does.
 */
import { useState } from "react";
import { TextInput, View } from "react-native";
import { usePreventRemove } from "expo-router/react-navigation";
import { useNavigation } from "expo-router";
import { Copy } from "../copy";
import { useWorld } from "../state/world";
import { useTheme } from "../theme";
import { Button, Panel, Rule, Section, Txt } from "./base";
import { signatureRows, type SignatureRow } from "./signature-rows";

/** The sentence for a change sent to the organizing install, or null. */
function changeLine(change: SignatureRow["change"]): string | null {
  if (change === null) return null;
  if (change.state === "asked") return Copy.sigSettingsAsked;
  if (change.state !== "refused") return null;
  const unreadable = change.refusal !== "other";
  return change.holder !== null
    ? (unreadable ? Copy.sigSettingsRefusedUnreadable(change.holder) : Copy.sigSettingsRefusedOther(change.holder))
    : (unreadable ? Copy.sigSettingsRefusedUnreadableUnknown : Copy.sigSettingsRefusedOtherUnknown);
}

export function SignaturesPanel() {
  const w = useWorld();
  const t = useTheme();
  const navigation = useNavigation();
  /** Each editor that differs from the stored text, by mailbox. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<null | { action: Parameters<typeof navigation.dispatch>[0] }>(null);
  const rows = w.signatures === null || !w.mailboxes.known ? [] : signatureRows({
    mailboxes: w.mailboxes.all, signatures: w.signatures, signaturesHtml: w.signing.html,
    sources: w.signing.sources, changes: w.signing.changes,
  });
  const dirtyOf = (row: SignatureRow): boolean => drafts[row.id] !== undefined && drafts[row.id] !== row.text;
  const anyDirty = rows.some((r) => !r.readOnly && dirtyOf(r));
  usePreventRemove(anyDirty && pending === null, ({ data }) => setLeaving({ action: data.action }));
  const write = w.signing.write;
  if (rows.length === 0 || write === null) return null;

  const drop = (id: string) => setDrafts((cur) => { const { [id]: _gone, ...rest } = cur; return rest; });
  const save = async (row: SignatureRow) => {
    setPending(row.id);
    setFailed(null);
    const ok = await write(row.id, drafts[row.id] ?? row.text);
    setPending(null);
    if (ok) drop(row.id);
    else setFailed(row.id);
  };

  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <Section>{Copy.sigSettingsTitle}</Section>
      <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
        <Txt variant="note" tone="ink2">{Copy.sigSettingsNote}</Txt>
      </View>
      {rows.map((row, i) => {
        const shown = drafts[row.id] ?? row.text;
        const dirty = !row.readOnly && dirtyOf(row);
        const travelled = changeLine(row.change);
        return (
          <View key={row.id}>
            {i > 0 ? <Rule inset={20} /> : null}
            <View style={{ paddingHorizontal: 20, paddingTop: 10, gap: 6 }}>
              <Txt variant="settingsLabel">{row.address}</Txt>
              <Txt variant="caption" tone="ink3">
                {row.why === "organizer" ? Copy.sigSettingsRead
                  : row.why === "markup" ? Copy.sigSettingsMarkup
                    : row.text.trim() !== "" ? Copy.sigSettingsOn : Copy.sigSettingsOff}
              </Txt>
              <TextInput
                maxFontSizeMultiplier={t.textCap}
                value={shown}
                onChangeText={(v) => { setDrafts((cur) => ({ ...cur, [row.id]: v })); if (failed === row.id) setFailed(null); }}
                editable={!row.readOnly && pending === null}
                multiline
                placeholder={Copy.sigSettingsPlaceholder}
                placeholderTextColor={t.c.ink3}
                accessibilityLabel={Copy.sigSettingsField(row.address)}
                style={[
                  t.type.body,
                  {
                    color: row.readOnly ? t.c.ink2 : t.c.ink, backgroundColor: t.c.tint2, borderRadius: t.radius.card,
                    paddingHorizontal: 14, paddingVertical: 10, minHeight: 72, maxHeight: 144, textAlignVertical: "top",
                  },
                ]}
              />
              {travelled !== null ? (
                <Txt variant="caption" tone="ink2" accessibilityRole={row.change?.state === "refused" ? "alert" : undefined}>
                  {travelled}
                </Txt>
              ) : null}
              {leaving !== null && dirty ? (
                <View style={{ gap: 6 }} accessibilityRole="alert">
                  <Txt variant="caption" tone="ink2">{Copy.sigSettingsLeaveAsk}</Txt>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    <Button
                      label={Copy.sigSettingsRevert}
                      variant="solid"
                      onPress={() => { const held = leaving; setDrafts({}); setLeaving(null); if (held !== null) navigation.dispatch(held.action); }}
                    />
                    <Button label={Copy.sigSettingsLeaveKeep} variant="quiet" onPress={() => setLeaving(null)} />
                  </View>
                </View>
              ) : dirty ? (
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Button
                    label={pending === row.id ? Copy.sigSettingsSaving : Copy.sigSettingsSave}
                    variant="solid"
                    disabled={pending !== null}
                    onPress={() => { void save(row); }}
                  />
                  {pending === null ? <Button label={Copy.sigSettingsRevert} variant="quiet" onPress={() => drop(row.id)} /> : null}
                </View>
              ) : null}
              {failed === row.id ? (
                <Txt variant="caption" tone="ink2" accessibilityRole="alert">{Copy.sigSettingsFailed}</Txt>
              ) : null}
            </View>
          </View>
        );
      })}
    </Panel>
  );
}
