import { useEffect, useRef, useState } from "react";
import { useDraftLeave } from "../use-draft-leave.js";
import { Button, Dialog } from "@ohmail/ui/base";
import { SettingArea, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useLocale, useText } from "../../text/index.js";
import type { ScreenerOhbox } from "./model.js";
import { SCREENER_NAMESPACE } from "./namespace.js";
import { travelledSaid } from "./travelled.js";

/**
 * What reaches the Ohbox: the posture, impersonations, and the words. It re-files future mail and says so; it never
 * implies it moves the past. The switches show the stored value; their refusal and the words' are said in two places.
 */
export function OhboxSheet({ ohbox }: { readonly ohbox: ScreenerOhbox }) {
  const t = useText("settings");
  const own = useText(SCREENER_NAMESPACE);
  const [pending, setPending] = useState(false);
  const [said, setSaid] = useState<"saved" | "failed" | null>(null);
  const alive = useAlive();

  const apply = (next: { relevant?: boolean; impersonation?: boolean }) => {
    if (pending) return;
    setPending(true);
    setSaid(null);
    void (async () => {
      try {
        const travelled = await ohbox.change(next);
        if (alive.current) setSaid(travelled ? null : "saved");
      } catch {
        if (alive.current) setSaid("failed");
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  const note = ohbox.note;
  return (
    <SettingsSheet
      title={t("screening.title")}
      wants={note?.kind === "refused" ? { word: own("notApplied"), line: travelledSaid(note, t) } : undefined}
    >
      <SettingLine
        label={t("screening.postureTitle")}
        toggle={{ on: ohbox.relevant, onChange: (next) => apply({ relevant: next }) }}
        off={pending}
      />
      <SettingNote>{ohbox.relevant ? t("screening.postureOn") : t("screening.postureOff")}</SettingNote>
      {ohbox.impersonation !== null ? (
        <>
          <SettingLine
            label={t("screening.impersonationTitle")}
            toggle={{ on: ohbox.impersonation, onChange: (next) => apply({ impersonation: next }) }}
            off={pending}
          />
          <SettingNote>
            {ohbox.impersonation ? t("screening.impersonationOn") : t("screening.impersonationOff")}
          </SettingNote>
        </>
      ) : null}
      {said === "saved" ? <SettingNote>{t("screening.saved")}</SettingNote> : null}
      {said === "failed" ? <SettingNote warn>{t("screening.failed")}</SettingNote> : null}
      {note && note.kind !== "refused" ? <SettingNote>{travelledSaid(note, t)}</SettingNote> : null}
      <OhboxWords ohbox={ohbox} busy={pending} />
    </SettingsSheet>
  );
}

/** The words, owned here once seeded and re-seeded only from what a write confirmed, as the shipped editor holds them. */
function OhboxWords({ ohbox, busy }: { readonly ohbox: ScreenerOhbox; readonly busy: boolean }) {
  const leaveText = useText("away");
  const t = useText("settings");
  const locale = useLocale();
  const alive = useAlive();
  /* English shows the server's words verbatim; another language shows the catalogue's translation of them. */
  const fromCatalogue = t("screening.defaultBar");
  const shownDefault = locale !== "en" && fromCatalogue.includes(" ") ? fromCatalogue : ohbox.defaultBar;

  const [stored, setStored] = useState<string | null>(ohbox.bar);
  const [draft, setDraft] = useState<string>(ohbox.bar ?? shownDefault);
  const [pending, setPending] = useState(false);
  const [said, setSaid] = useState<"saved" | "failed" | null>(null);

  /* Words a holder applied, read after a change that travelled: taken only while the draft is untouched. */
  const [seenBar, setSeenBar] = useState<string | null>(ohbox.bar);
  if (seenBar !== ohbox.bar) {
    setSeenBar(ohbox.bar);
    if (draft.trim() === (stored ?? shownDefault).trim()) setDraft(ohbox.bar ?? shownDefault);
    setStored(ohbox.bar);
  }
  /* The language can change under the box: an untouched default follows it; typed words stay. */
  const [seededFrom, setSeededFrom] = useState<string>(shownDefault);
  if (seededFrom !== shownDefault) {
    if (stored === null && draft.trim() === seededFrom.trim()) setDraft(shownDefault);
    setSeededFrom(shownDefault);
  }

  const isDefault = (text: string) => {
    const v = text.trim();
    return v === ohbox.defaultBar.trim() || v === shownDefault.trim();
  };
  const changed = stored === null ? !isDefault(draft) : draft.trim() !== stored.trim();
  const guard = useDraftLeave(changed && !!ohbox.holdLeave, (ask) => ohbox.holdLeave!(ask), draft);
  const held = pending || busy;
  const toStore = (text: string): string | null => (isDefault(text) || !text.trim() ? null : text.trim());

  const save = (next: string | null) => {
    if (held) return;
    setPending(true);
    setSaid(null);
    void (async () => {
      try {
        const landed = await ohbox.saveBar(next);
        if (!alive.current) return;
        setStored(landed.bar);
        setDraft(landed.bar ?? shownDefault);
        setSaid(landed.travelled ? null : "saved");
      } catch {
        if (alive.current) setSaid("failed");
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  return (
    <>
      <Dialog
        open={guard.leaving}
        alert
        keysOn="cancel"
        onClose={guard.keep}
        title={leaveText("leaveAsk")}
        hot
        confirm={{
          label: leaveText("leaveDiscard"),
          onPress: () => guard.discard(() => setDraft(stored ?? shownDefault)),
        }}
        cancel={{ label: leaveText("leaveKeep") }}
      />
      <SettingArea
        label={t("screening.barLabel")}
        value={draft}
        placeholder={shownDefault}
        onChange={held ? undefined : setDraft}
        lines={4}
        refusal={said === "failed" ? t("screening.failed") : undefined}
        name="ohbox-bar"
      />
      <Button kind="ink" size="s" disabled={held || !changed} onPress={() => save(toStore(draft))}>
        {t("screening.save")}
      </Button>
      {stored !== null ? (
        <Button kind="quiet" size="s" disabled={held} onPress={() => save(null)}>
          {t("screening.reset")}
        </Button>
      ) : null}
      <SettingNote>{t("screening.microcopy")}</SettingNote>
      {said === "saved" ? <SettingNote>{t("screening.saved")}</SettingNote> : null}
    </>
  );
}

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}
