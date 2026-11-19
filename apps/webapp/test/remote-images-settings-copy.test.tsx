/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { RemoteImagesRow } from "../app/shell/RemoteImagesRow";
import { TrackingPixelsRow } from "../app/shell/TrackingPixelsRow";

/**
 * MOVED, AS THEY STOOD (share reader-1, the switch's older tests): the three cases of `remote-images.test.tsx` that
 * read the pictures' two Settings rows. Their place is Settings' General pane, which the new shell does not mount
 * yet (`packages/app/src/mail/panes.ts`: `general: NONE`), and today's rows leave with today's shell; the cases wait
 * here for the pane's mount, which re-points them onto its rows. The rest of that file reads the reader's picture
 * door over the new shell.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}
afterEach(unmount);

/* ── WHO FETCHES THE PICTURE, SAID WHERE THE SWITCH IS ─────────────────────────────────── */

describe("the Settings copy names the machine that fetches the pictures", () => {
  /** Both rows as Settings mounts them, in one language, pictures ON and pixels ON. */
  async function rows(fromComputer: boolean, locale: "en" | "de"): Promise<string> {
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const noop = async () => true;
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale, messages: (locale === "en" ? messages : de) as never,
        children: [
          h(RemoteImagesRow, { key: "i", blocked: false, setBlockRemoteImages: noop, fromComputer }),
          h(TrackingPixelsRow, { key: "p", blocked: false, setBlockTrackingPixels: noop, fromComputer }),
        ],
      }));
    });
    return host.textContent ?? "";
  }

  it("a computer of the reader's own promises no proxy, in either language", async () => {
    for (const locale of ["en", "de"] as const) {
      const text = await rows(true, locale);
      expect(text, `${locale}: the desktop's own door promised a proxy`).not.toMatch(/proxy/i);
      const cat = locale === "en" ? messages.settings : de.settings;
      expect(text).toContain(cat.images.microcopyComputer);
      expect(text).toContain(cat.pixels.offComputer);
    }
  });

  it("CONTROL: the Cloud door keeps the proxy sentence it can keep", async () => {
    const text = await rows(false, "en");
    expect(text).toContain(messages.settings.images.microcopy);
    expect(text).toContain(messages.settings.pixels.off);
  });

  it("pictures ON says mail in the Screener asks first, on either door and in either language", async () => {
    for (const locale of ["en", "de"] as const) {
      for (const fromComputer of [false, true]) {
        expect(await rows(fromComputer, locale), `${locale}, own computer ${fromComputer}`).toMatch(/Screener/);
      }
    }
  });
});
