/**
 * A TAG'S TWO QUESTIONS. Rename: a field whose Save stands only for a new name no other tag has. Delete: what it
 * takes off, and that the letters stay where they are, said before it is asked.
 */
import type { TagEntity as TagDTO } from "@ohmail/wire";
import { useLayoutEffect, useRef, useState } from "react";
import { chordMatches } from "@ohmail/app-logic/keys";
import type { TagsModel } from "@ohmail/app-logic/tags";
import { Button, Dialog, Field } from "@ohmail/ui/base";
import "./tags.css";
import { useText } from "../text/index.js";

/**
 * Rename takes the second line of the list head. The field takes focus and Enter saves.
 */
export function TagRename({ tag, model, close }: { tag: TagDTO; model: TagsModel; close: () => void }) {
  const t = useText("tags");
  const [draft, setDraft] = useState(tag.name);
  const answer = model.judge(tag.id, draft);
  const save = () => {
    if (answer.kind !== "save") return;
    model.rename(tag.id, answer.name);
    close();
  };
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true });
    field.current?.select();
  }, []);
  return (
    <div
      className="tg-rename"
      onKeyDown={(e) => {
        if (!chordMatches("Escape", e.nativeEvent)) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <Field
        ref={field}
        label={t("rename.field")}
        value={draft}
        onChange={setDraft}
        onEnter={save}
        refusal={answer.kind === "taken" ? t("rename.taken", { name: answer.name }) : undefined}
      />
      <Button kind="ink" disabled={answer.kind !== "save"} onPress={save}>
        {t("rename.save")}
      </Button>
      <Button kind="quiet" keyHint="Esc" shortcut="Escape" onPress={close}>
        {t("rename.cancel")}
      </Button>
    </div>
  );
}

export function TagDelete({ tag, model, close }: { tag: TagDTO; model: TagsModel; close: () => void }) {
  const t = useText("tags");
  const count = model.countOf(tag.id);
  return (
    <Dialog
      open
      kind="delete"
      onClose={close}
      title={t("delete.title", { name: tag.name })}
      line={count === 0 ? t("delete.nothing") : t("delete.stay", { count })}
      confirm={{
        label: t("delete.confirm"),
        onPress: () => {
          model.remove(tag.id);
          close();
        },
      }}
      cancel={{ label: t("delete.cancel") }}
    />
  );
}
