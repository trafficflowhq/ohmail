import { useEffect, useRef, useState, type RefObject } from "react";
import { Button, Dialog, Menu, MenuItem, TagDot } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet, TagLine } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import { newTagName, renamed, type TagsModel, type TagsModelTag } from "./model.js";
import { TAGS_NAMESPACE } from "./namespace.js";

export interface TagsPaneProps {
  readonly model: TagsModel;
  /**
   * States page only, never handed by a shell: a moment to open on that a person reaches by pressing (a tag's name
   * being written, or a new name typed).
   */
  readonly at?: { readonly rename?: string; readonly typeNew?: string };
}

type Verbs = NonNullable<TagsModel["verbs"]>;
type Editing = { readonly id: string; readonly draft: string } | null;

/**
 * Tags: each tag with its colour, how many messages carry it, Rename and Delete; then a line that makes a new one.
 * A tag is one engine verb each way; the pane refuses only what it knows the server would refuse.
 */
export function TagsPane({ model, at }: TagsPaneProps) {
  const t = useText("settings");
  const own = useText(TAGS_NAMESPACE);
  const { tags, verbs } = model;
  const [editing, setEditing] = useState<Editing>(() => {
    const tag = tags.find((x) => x.id === at?.rename);
    return tag ? { id: tag.id, draft: tag.name } : null;
  });
  const [colours, setColours] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [asking, setAsking] = useState<TagsModelTag | null>(null);
  const keys = useRenameKeys(editing?.id ?? null);
  const close = () => {
    keys.back.current = editing?.id ?? null;
    setEditing(null);
  };

  return (
    <SettingsSheet>
      {tags.length === 0 ? <SettingNote>{t("tagsEmpty")}</SettingNote> : null}
      {tags.map((tag) => {
        const value = t("tagMessages", { count: tag.count });
        if (!verbs) {
          return (
            <SettingLine
              key={tag.id}
              label={tag.name}
              value={value}
              narrow="under"
              lead={<TagDot hue={tag.hue} />}
            />
          );
        }
        return editing?.id === tag.id ? (
          <RenameLine
            key={tag.id}
            tag={tag}
            draft={editing.draft}
            onDraft={(draft) => setEditing({ id: tag.id, draft })}
            rename={verbs.rename}
            close={close}
            field={keys.field}
            t={t}
          />
        ) : (
          <TagLine
            key={tag.id}
            hue={tag.hue}
            name={tag.name}
            value={value}
            colour={{
              label: t("tagRecolor", { name: tag.name }),
              expanded: colours?.id === tag.id,
              onPress: (anchor) => setColours({ id: tag.id, anchor }),
            }}
            acts={
              <>
                <Button
                  kind="quiet"
                  size="s"
                  ref={(el) => {
                    keys.buttons.current.set(tag.id, el);
                  }}
                  onPress={() => setEditing({ id: tag.id, draft: tag.name })}
                >
                  {t("tagRename")}
                </Button>
                <Button kind="quiet" size="s" opens="dialog" onPress={() => setAsking(tag)}>
                  {t("tagDelete")}
                </Button>
              </>
            }
          />
        );
      })}
      {verbs ? <NewTag model={model} create={verbs.create} typed={at?.typeNew} t={t} /> : null}
      {model.notOnServer ? <p className="oh-vh">{model.notOnServer}</p> : null}
      {verbs && colours ? (
        <ColourMenu
          tag={tags.find((x) => x.id === colours.id) ?? null}
          model={model}
          anchor={colours.anchor}
          title={own("colours")}
          onClose={() => setColours(null)}
          recolour={verbs.recolour}
          t={t}
        />
      ) : null}
      {verbs ? <DeleteAsk tag={asking} remove={verbs.remove} close={() => setAsking(null)} t={t} /> : null}
    </SettingsSheet>
  );
}

/** The keys go into the name's field when it opens, and back to that tag's Rename when it closes. */
function useRenameKeys(editingId: string | null) {
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const field = useRef<HTMLInputElement>(null);
  const back = useRef<string | null>(null);
  useEffect(() => {
    if (editingId !== null) field.current?.focus();
    else if (back.current !== null) {
      buttons.current.get(back.current)?.focus();
      back.current = null;
    }
  }, [editingId]);
  return { buttons, field, back };
}

function RenameLine(props: {
  tag: TagsModelTag;
  draft: string;
  onDraft: (draft: string) => void;
  rename: Verbs["rename"];
  close: () => void;
  field: RefObject<HTMLInputElement | null>;
  t: Text;
}) {
  const { tag, draft, onDraft, rename, close, field, t } = props;
  const next = renamed(tag, draft);
  const save = () => {
    if (next === null) return;
    rename(tag.id, next);
    close();
  };
  return (
    <TagLine
      hue={tag.hue}
      field={{
        label: t("tagRename"),
        value: draft,
        onChange: onDraft,
        onEnter: save,
        onEscape: close,
        ref: field,
      }}
      acts={
        <>
          <Button kind="two" size="s" disabled={next === null} onPress={save}>
            {t("tagSave")}
          </Button>
          <Button kind="quiet" size="s" onPress={close}>
            {t("tagCancel")}
          </Button>
        </>
      }
    />
  );
}

function NewTag({
  model,
  create,
  typed,
  t,
}: {
  model: TagsModel;
  create: Verbs["create"];
  typed?: string;
  t: Text;
}) {
  const [draft, setDraft] = useState(typed ?? "");
  const asked = newTagName(model.tags, draft);
  const canAdd = asked !== null && !asked.taken;
  const add = () => {
    if (!asked || asked.taken) return;
    create(asked.name);
    setDraft("");
  };
  return (
    <TagLine
      hue={model.newHue}
      field={{
        label: t("tagNew"),
        placeholder: t("tagNewPlaceholder"),
        value: draft,
        onChange: setDraft,
        onEnter: add,
        onEscape: () => setDraft(""),
      }}
      refusal={asked?.taken ? t("tagTaken", { name: asked.name }) : undefined}
      acts={
        <Button kind="two" size="s" disabled={!canAdd} onPress={add}>
          {t("tagAdd")}
        </Button>
      }
    />
  );
}

function DeleteAsk({
  tag,
  remove,
  close,
  t,
}: {
  tag: TagsModelTag | null;
  remove: Verbs["remove"];
  close: () => void;
  t: Text;
}) {
  return (
    <Dialog
      open={tag !== null}
      onClose={close}
      kind="delete"
      title={tag ? t("tagDeleteAsk", { name: tag.name }) : ""}
      line={tag ? t("tagDeleteWhat", { count: tag.count }) : undefined}
      confirm={{
        label: t("tagDelete"),
        onPress: () => {
          if (tag) remove(tag.id);
          close();
        },
      }}
      cancel={{ label: t("tagCancel") }}
    />
  );
}

function ColourMenu(props: {
  tag: TagsModelTag | null;
  model: TagsModel;
  anchor: HTMLElement;
  title: string;
  onClose: () => void;
  recolour: Verbs["recolour"];
  t: Text;
}) {
  const { tag, model, anchor, title, onClose, recolour, t } = props;
  if (!tag) return null;
  return (
    <Menu
      open
      onClose={onClose}
      anchor={anchor}
      label={t("tagRecolorAria", { name: tag.name })}
      title={title}
    >
      {model.colours.map((colour) => (
        <MenuItem
          key={colour.id}
          hue={colour.hue}
          checked={colour.id === tag.colour}
          onPress={() => {
            if (colour.id !== tag.colour) recolour(tag.id, colour.id);
            onClose();
          }}
        >
          {t(`hue_${colour.id}`)}
        </MenuItem>
      ))}
    </Menu>
  );
}
