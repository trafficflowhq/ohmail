/** A frame with both overs handed, under the keyboard registry, whose one place draws what a case gives it. */
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Frame } from "../../src/frame/Frame.js";
import { KeymapProvider } from "../../src/keys/index.js";
import { keySheetOver } from "../../src/keys/sheet/index.js";
import { paletteOver } from "../../src/palette/index.js";
import { TextProvider } from "../../src/text/index.js";
import searchEn from "../../messages/search.en.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { FRAME_WORDS } from "../support/frame-words.js";

export function mountOvers(body: () => ReactNode) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: {
      ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <>{body()}</> } },
    },
    overs: { palette: paletteOver, keys: keySheetOver },
  });
  return render(
    <TextProvider
      locale="en"
      messages={{ ...FRAME_WORDS.en, palette: searchEn.palette, shortcuts: searchEn.shortcuts }}
      timeZone="Europe/Zurich"
    >
      <KeymapProvider>
        <Frame host={made.host} />
      </KeymapProvider>
    </TextProvider>,
  );
}

/** A key pressed where the person's focus is, as the registry hears it. */
export function press(
  key: string,
  init: KeyboardEventInit = {},
  on: Element = document.activeElement ?? document.body,
) {
  on.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}
