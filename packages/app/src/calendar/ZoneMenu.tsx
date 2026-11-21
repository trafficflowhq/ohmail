import { useState } from "react";
import { Field, Menu, MenuItem } from "@ohmail/ui/base";
import { useText } from "../text/index.js";
import { knownZones, zoneName } from "./zone-names.js";

export function ZoneMenu({
  anchor,
  zone,
  close,
  pick,
}: {
  anchor: HTMLElement;
  zone: string;
  close: () => void;
  pick: (zone: string) => void;
}) {
  const t = useText("calendar");
  const [query, setQuery] = useState("");
  const zones = [...new Set([zone, "UTC", ...knownZones()])];
  const matches = zones
    .filter((name) => zoneName(name).toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 8);
  return (
    <Menu open kind="card" anchor={anchor} label={t("create.timeZone")} onClose={close}>
      <Field label={t("create.findZone")} value={query} onChange={setQuery} bare sign="search" />
      {matches.map((name) => (
        <MenuItem
          key={name}
          checked={name === zone}
          onPress={() => {
            if (name !== zone) pick(name);
            close();
          }}
        >
          {zoneName(name)}
        </MenuItem>
      ))}
    </Menu>
  );
}
