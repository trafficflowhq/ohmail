import { useState, type ReactNode, type Ref } from "react";
import { ChoiceTiles } from "@ohmail/ui/base";
import { SettingNote } from "@ohmail/ui/mail";
import type { ConnectForm } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";
import type { Text } from "../../text/index.js";

/** The tile of the provider that is no preset: its mail reaches other apps only through its own bridge. */
const BRIDGE = "the-bridge-provider";

/**
 * THE PROVIDERS, one tile each, and among them the one whose mail reaches other apps only through its own bridge:
 * its tile connects nothing and says why. Choosing a tile is the form's first act: nothing is pre-chosen but what
 * the typed address chose, and a tile pressed by the person is never overridden.
 */
export function ProviderTiles({
  form,
  picker,
  bridgeHere,
  onPick,
  onManual,
  query = "",
  ref,
}: {
  form: ConnectForm;
  picker: Text;
  /** This shell's engine dials a server on this computer, where the bridge runs. */
  bridgeHere: boolean;
  onPick?: (manual: boolean) => void;
  onManual?: (() => void) | undefined;
  query?: string;
  ref?: Ref<HTMLDivElement>;
}): ReactNode {
  const [bridge, setBridge] = useState(false);
  const open = bridge || form.bridged;
  const chosen = form.preset?.id ?? null;
  return (
    <div ref={ref} className="mbx-connect-part">
      <ChoiceTiles
        label={picker("label")}
        compact={onPick !== undefined}
        options={[
          ...form.presets.map((preset) => ({
            value: preset.id,
            label:
              onPick && preset.manual
                ? picker("otherShort")
                : onPick && preset.id === "microsoft"
                  ? picker("microsoftShort")
                  : onPick && preset.id === "icloud"
                    ? picker("icloudShort")
                    : preset.manual
                      ? picker("otherLabel")
                      : preset.label,
            dim: query !== "" && !preset.label.toLowerCase().includes(query),
          })),
          {
            value: BRIDGE,
            label: onPick ? picker("protonShort") : form.bridgeLabel,
            dim: !form.bridgeLabel.toLowerCase().includes(query),
          },
        ]}
        /* The bridge provider's tile is held while its note stands and no provider is chosen. */
        value={chosen ?? (open ? BRIDGE : null)}
        onChange={(value) => {
          if (value === BRIDGE) return setBridge((was) => !was);
          setBridge(false);
          form.choose(value);
          const manual = form.presets.find((preset) => preset.id === value)?.manual === true;
          if (manual) onManual?.();
          onPick?.(manual);
        }}
      />
      {open ? (
        <SettingNote>
          {picker(bridgeHere ? "protonNoteDesktop" : "protonNote", { other: picker("otherLabel") })}
        </SettingNote>
      ) : null}
    </div>
  );
}
