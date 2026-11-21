import { useDraftLeave } from "../../host/use-draft-leave.js";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Tag } from "@ohmail/ui/base";
import { SettingLine, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import {
  isDirty,
  isRichEmpty,
  signatureWrite,
  signatureConfirmed,
  type RichValue,
  type SignaturesMailbox,
  type SignaturesModel,
} from "./model.js";
import { SIGNATURES_NAMESPACE } from "./namespace.js";
import "./signature-field.css";

export interface SignaturesPaneProps {
  readonly model: SignaturesModel;
  /** States page only, never handed by a shell: a draft to open on that a person reaches by typing. */
  readonly typed?: { readonly mailbox: string; readonly text: string };
}

/**
 * Signatures: one editor per live mailbox over the signature the server confirmed, its preview, Save and Discard.
 * One save at a time; a draft that is not saved holds the way out of the pane until it is kept or discarded.
 */
export function SignaturesPane({ model, typed }: SignaturesPaneProps) {
  const t = useText("settings");
  const [drafts, setDrafts] = useState<Readonly<Record<string, RichValue>>>(() =>
    typed ? { [typed.mailbox]: { text: typed.text, html: "" } } : {},
  );
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; line: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { mailboxes } = model;
  useEffect(() => {
    // A queued change can arrive in a later read. Release just the drafts the effective mailbox rows now confirm.
    setDrafts((held) => {
      const confirmed = mailboxes.filter((mb) => held[mb.id] && !isDirty(held[mb.id], mb.stored));
      if (!confirmed.length) return held;
      const remaining = { ...held };
      for (const mb of confirmed) delete remaining[mb.id];
      return remaining;
    });
  }, [mailboxes]);
  const guard = useDraftLeave(
    mailboxes.some((mb) => isDirty(drafts[mb.id], mb.stored)),
    model.holdLeave,
    drafts,
  );

  const drop = (id: string, confirmed?: RichValue) =>
    setDrafts((now) => {
      if (confirmed && isDirty(now[id], confirmed)) return now;
      const { [id]: _gone, ...rest } = now;
      return rest;
    });
  const save = (id: string, value: RichValue, takeoverAsked: boolean) => {
    if (pending !== null) return;
    setPending(id);
    setFailed(null);
    model
      .write(id, ...signatureWrite(value))
      .then((echo) => {
        if (alive.current && signatureConfirmed(id, value, echo)) drop(id, value);
      })
      .catch((error: unknown) => {
        if (alive.current)
          setFailed({ id, line: model.refusal(error, takeoverAsked) ?? t("signatures.failed") });
      })
      .finally(() => {
        if (alive.current) setPending(null);
      });
  };

  return (
    <>
      {mailboxes.map((mb) => (
        <MailboxSignature
          key={mb.id}
          mb={mb}
          model={model}
          draft={drafts[mb.id]}
          pending={pending}
          editing={editing === mb.id}
          onFocus={() => setEditing(mb.id)}
          failed={failed?.id === mb.id ? failed.line : null}
          onDraft={(value) => setDrafts((now) => ({ ...now, [mb.id]: value }))}
          drop={() => drop(mb.id)}
          save={(value) => save(mb.id, value, mb.takeoverAsked)}
        />
      ))}
      <Dialog
        open={guard.leaving}
        onClose={guard.keep}
        title={t("signatures.leaveAsk")}
        hot
        confirm={{
          label: t("signatures.revert"),
          onPress: () => guard.discard(() => setDrafts({})),
        }}
        cancel={{ label: t("signatures.leaveKeep") }}
      />
    </>
  );
}

/** One mailbox's sheet: its editor over the stored signature, the preview, and Save and Discard. */
function MailboxSignature(props: {
  mb: SignaturesMailbox;
  model: SignaturesModel;
  draft: RichValue | undefined;
  pending: string | null;
  editing: boolean;
  onFocus: () => void;
  failed: string | null;
  onDraft: (value: RichValue) => void;
  drop: () => void;
  save: (value: RichValue) => void;
}) {
  const { mb, model, draft, pending, editing, onFocus, failed, onDraft, drop, save } = props;
  const t = useText("settings");
  const own = useText(SIGNATURES_NAMESPACE);
  const shown = draft ?? mb.stored;
  const dirty = isDirty(draft, mb.stored);
  const empty = mb.stored.text.trim().length === 0;
  const status = mb.reading
    ? t("signatures.mailboxRead")
    : empty
      ? t("signatures.mailboxOff")
      : t("signatures.mailboxOn");
  return (
    <SettingsSheet
      title={mb.address}
      person={{ name: mb.address, address: mb.address }}
      aside={mb.reading ? <Tag>{own("read")}</Tag> : empty ? <Tag>{own("none")}</Tag> : undefined}
      wants={failed !== null ? { word: t("notSaved"), line: failed } : undefined}
    >
      <div className="signature-field" onFocus={mb.reading ? undefined : onFocus}>
        {model.editor({
          label: `${t("signatures.title")}: ${mb.address}`,
          value: shown,
          placeholder: t("signatures.placeholder"),
          editable: !mb.reading && pending === null,
          preview: false,
          tools: editing,
          onChange: onDraft,
        })}
      </div>
      {!editing || isRichEmpty(shown)
        ? null
        : model.editor({
            label: t("signatures.preview"),
            value: shown,
            placeholder: "",
            editable: false,
            preview: true,
            onChange: () => undefined,
          })}
      {model.changeNote(mb.id)}
      <p className="oh-vh">{status}</p>
      {mb.reading || (!editing && !dirty && pending !== mb.id) ? null : (
        <SettingLine label={t("signatures.title")}>
          <>
            {dirty && pending === null ? (
              <Button kind="quiet" size="s" onPress={drop}>
                {t("signatures.revert")}
              </Button>
            ) : null}
            <Button kind="two" size="s" disabled={!dirty || pending !== null} onPress={() => save(shown)}>
              {pending === mb.id ? t("signatures.saving") : t("signatures.save")}
            </Button>
          </>
        </SettingLine>
      )}
    </SettingsSheet>
  );
}
