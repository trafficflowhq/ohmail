import { Menu, MenuItem } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

export function ShowAsMenu({
  anchor,
  busy,
  choose,
  close,
}: {
  anchor: HTMLElement;
  busy: boolean;
  choose: (busy: boolean) => void;
  close: () => void;
}) {
  const t = useText("calendar");
  return (
    <Menu open anchor={anchor} label={t("create.showAs")} onClose={close}>
      {[true, false].map((choice) => (
        <MenuItem
          key={String(choice)}
          checked={choice === busy}
          onPress={() => {
            choose(choice);
            close();
          }}
        >
          {t(choice ? "create.busy" : "create.free")}
        </MenuItem>
      ))}
    </Menu>
  );
}
