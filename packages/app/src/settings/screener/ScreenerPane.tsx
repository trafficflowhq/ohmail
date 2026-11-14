import { Button } from "@ohmail/ui/base";
import { SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import type { ScreenerModel } from "./model.js";
import { FiledSheet } from "./FiledSheet.js";
import { OhboxSheet } from "./OhboxSheet.js";
import { SuggestSheet } from "./SuggestSheet.js";
import { WindowSheet } from "./WindowSheet.js";

/**
 * Settings › Screener, in the shipped order: what reaches the Ohbox, what the Screener shows (the window), what may
 * spend and act, what leaves the building, what was filed automatically, and the door back to the review. Each part
 * is drawn only where the model holds it.
 */
export function ScreenerPane({ model }: { readonly model: ScreenerModel }) {
  const { ohbox, window: dial, filed, review } = model;
  return (
    <>
      {ohbox ? <OhboxSheet ohbox={ohbox} /> : null}
      {dial ? <WindowSheet window={dial} /> : null}
      <SuggestSheet model={model} />
      {filed ? <FiledSheet filed={filed} /> : null}
      {review ? (
        <SettingsSheet title={review.said.label}>
          <SettingNote>{review.said.body}</SettingNote>
          <Button kind="two" size="s" onPress={() => review.open()}>
            {review.said.action}
          </Button>
        </SettingsSheet>
      ) : null}
    </>
  );
}
