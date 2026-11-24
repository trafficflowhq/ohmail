import type { KeyboardEvent } from "react";
import { Menu, MenuItem, MenuNote, MenuRule, type MenuProps } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import "./move-picker.css";

export interface MovePickerProps {
  open: boolean;
  onClose: () => void;
  anchor?: MenuProps["anchor"];
  /** Open upwards; end at the anchor's right edge. As the menu takes them. */
  up?: boolean;
  right?: boolean;
  /** The menu's name, and the title over its list. */
  label: string;
  title: string;
  /** The app's own places, first. */
  places: readonly { id: string; label: string }[];
  /** The line that looks for a folder, once there are more folders than the menu lists. */
  find?: {
    label: string;
    placeholder?: string;
    value: string;
    onChange?: (value: string) => void;
    none?: string;
  };
  /** The mailbox whose folders these are, where it has to be said. */
  mailbox?: string;
  /**
   * The folders offered: the name, and the way to it where two could be meant. The best match first. One that is
   * `disabled` cannot take mail now (it is being renamed or moved): it is listed, said so, and takes no press.
   */
  folders: readonly { id: string; name: string; path?: string; disabled?: boolean }[];
  /** A place or a folder was taken. */
  onMove?: (id: string) => void;
}

/** The Move menu once a person has folders: the app's places first, then the folders of the letter's own mailbox. */
export function MovePicker(props: MovePickerProps) {
  const { open, onClose, anchor, label, title, places, find, mailbox, folders, onMove } = props;
  const enter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const first = folders.find((folder) => !folder.disabled);
    if (first) onMove?.(first.id);
  };
  return (
    <Menu
      open={open}
      onClose={onClose}
      anchor={anchor}
      up={props.up}
      right={props.right}
      label={label}
      title={title}
    >
      {places.map((place) => (
        <MenuItem key={place.id} onPress={() => onMove?.(place.id)}>
          {place.label}
        </MenuItem>
      ))}
      {find || folders.length ? <MenuRule /> : null}
      {find ? (
        <label className="oh-movepicker-find">
          <input
            className="oh-control oh-movepicker-line"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={find.label}
            placeholder={find.placeholder}
            value={find.value}
            onChange={(event) => find.onChange?.(event.target.value)}
            onKeyDown={enter}
          />
        </label>
      ) : null}
      {mailbox ? <p className="oh-text oh-movepicker-mailbox">{mailbox}</p> : null}
      <div className="oh-movepicker-folders">
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className="oh-control oh-menu-item oh-movepicker-folder"
            role="menuitem"
            disabled={folder.disabled}
            onClick={() => onMove?.(folder.id)}
          >
            <Icon name="folder" size={18} />
            <span className="oh-movepicker-name">{folder.name}</span>
            {folder.path ? <small className="oh-movepicker-path">{folder.path}</small> : null}
          </button>
        ))}
      </div>
      {find?.none && !folders.length ? <MenuNote>{find.none}</MenuNote> : null}
    </Menu>
  );
}
