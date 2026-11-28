import { useRef, useState, type KeyboardEvent } from "react";
import { Button, Icon, Overlay, SuggestionCredit, SuggestionList } from "@ohmail/ui/base";
import type { EventFormItem, EventFormRow } from "@ohmail/ui/calendar";
import { useFrame } from "../frame/commands.js";
import { useText } from "../text/index.js";
import { PLACE_CREDIT, useMaps, usePlaceSuggestions } from "./use-place-suggestions.js";
import "./draft-place.css";

export function useDraftPlace(
  value: string | null,
  onText: (value: string) => void,
  exclude?: string,
  zone?: string | null,
) {
  const t = useText("calendar");
  const phone = useFrame().plan.device === "phone";
  const [sheet, setSheet] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const places = usePlaceSuggestions(value, onText, { phone, exclude, zone, onTake: () => setSheet(false) });
  const maps = useMaps(value);
  const label = t("create.place");
  const placeholder = t("location.placeholder");
  const unavailable = t("location.unavailable");
  const close = () => {
    places.close();
    setSheet(false);
  };
  const open = () => {
    setSheet(true);
    if (!value?.trim()) places.open();
  };
  const field = {
    ...places.field,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (places.keys(event) || event.key !== "Enter" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      close();
    },
  };
  if (value === null) return { rows: [], overlay: null, open: phone ? open : undefined };

  const input: EventFormItem = phone
    ? { kind: "openText", label, placeholder, value, ref: opener, onPress: open }
    : { kind: "text", label, placeholder, value, ref: places.anchor, suggests: field };
  const items: EventFormItem[] = [input];
  if (maps) items.push({ kind: "link", text: maps.label, title: maps.title, onPress: maps.onPress });
  if (!phone && places.unavailable) items.push({ kind: "status", text: unavailable });

  const list = (
    <SuggestionList
      {...places.list}
      label={t("location.suggestions")}
      className={phone ? "cal-place-results" : undefined}
      placement={phone ? "inline" : "anchored"}
      foot={
        places.credit ? <SuggestionCredit href={PLACE_CREDIT}>{t("location.credit")}</SuggestionCredit> : null
      }
    />
  );
  return {
    rows: [{ id: "place", icon: "place", items }] satisfies EventFormRow[],
    open: phone ? open : undefined,
    overlay: phone
      ? sheet && (
          <Overlay
            open
            portal
            inertBackground
            className="cal-place-sheet"
            label={label}
            onClose={close}
            first={() => places.anchor.current}
            returnFocus={() => opener.current}
          >
            <header className="cal-place-head">
              <Button kind="quiet" icon="back" label={t("location.back")} onPress={close} />
              <label className="cal-place-field">
                <Icon name="place" size={18} />
                <input
                  {...field}
                  ref={places.anchor}
                  aria-label={label}
                  className="cal-place-input"
                  placeholder={placeholder}
                  spellCheck={false}
                  enterKeyHint="done"
                />
                {value && (
                  <Button
                    kind="quiet"
                    size="s"
                    icon="x"
                    label={t("location.clear")}
                    onPress={() => {
                      onText("");
                      places.anchor.current?.focus();
                    }}
                  />
                )}
              </label>
            </header>
            {places.unavailable && (
              <p className="cal-place-status" role="status">
                {unavailable}
              </p>
            )}
            {list}
          </Overlay>
        )
      : list,
  };
}
