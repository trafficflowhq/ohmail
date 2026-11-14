/**
 * A TAG'S TWO QUESTIONS. Rename: a field whose Save stands only for a new name no other tag has. Delete: what it
 * takes off, and that the letters stay where they are, said before it is asked.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { TagDTO } from "@ohmail/client-engine";
import { chordMatches } from "@ohmail/app-logic/keys";
import type { TagsModel } from "@ohmail/app-logic/tags";
import { Button, Dialog, Field, Menu } from "@ohmail/ui/base";
import "./tags.css";
import { useText } from "../text/index.js";

/**
 * Rename is asked where the list's menu stood, as a small form: the field, then Save and Cancel. The field takes the
 * keys as it opens, and Enter in it is Save; Escape is the menu's.
 */
export function TagRename({
  tag,
  model,
  anchor,
  close,
}: {
  tag: TagDTO;
  model: TagsModel;
  anchor: RefObject<HTMLButtonElement | null>;
  close: () => void;
}) {
  const t = useText("tags");
  const [draft, setDraft] = useState(tag.name);
  const answer = model.judge(tag.id, draft);
  const save = () => {
    if (answer.kind !== "save") return;
    model.rename(tag.id, answer.name);
    close();
  };
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const saveNow = useRef(save);
  saveNow.current = save;
  /* After the menu's own focus (a child's layout effect runs first): the keys go to the name. */
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const onKey = (e: Event): void => {
      if (!chordMatches("Enter", e as KeyboardEvent)) return;
      e.preventDefault();
      saveNow.current();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);
  const title = t("rename.title", { name: tag.name });
  return (
    <Menu open onClose={close} anchor={anchor} right kind="ask" label={title} title={title}>
      <Field
        ref={field}
        label={t("rename.field")}
        value={draft}
        onChange={setDraft}
        refusal={answer.kind === "taken" ? t("rename.taken", { name: answer.name }) : undefined}
      />
      <div className="tg-answers">
        <Button kind="ink" size="s" disabled={answer.kind !== "save"} onPress={save}>
          {t("rename.save")}
        </Button>
        <Button kind="quiet" size="s" onPress={close}>
          {t("rename.cancel")}
        </Button>
      </div>
    </Menu>
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
