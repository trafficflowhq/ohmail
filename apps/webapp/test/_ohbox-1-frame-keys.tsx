/**
 * THE NEW SHELL's FRAME, with nothing over it, whose one place draws what a case gives it (share ohbox-1's helper:
 * the join folds it). The frame mounts its own key registry (`Frame.tsx`'s `OwnKeys`: the table every seated place
 * declares its keys in, its zone cursor and its focus rule), so a binding a case declares here is heard exactly as a
 * seated place's is. No over is handed: the key sheet and the palette are Search's mount's.
 */
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import { TextProvider } from "../../../packages/app/src/text/index.js";
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";

export function mountFrameKeys(body: () => ReactNode) {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: {
      ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <>{body()}</> } },
    },
  });
  return render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
}
