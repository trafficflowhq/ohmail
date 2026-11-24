/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import en from "../messages/en.json";

/**
 * THE WORDS A LIST ROW TAKES ARE ONE OBJECT, NOT A FRESH ONE PER RENDER: a row memo compares on it, so a fresh object
 * at every render would redraw every row of a list on every publish.
 *
 * MOVED word for word (share ohbox-2) from `row-a11y-shell.test.tsx`, whose other cases walk the Ohbox's rows over the
 * new shell. This case reads `useRowBadgeCopy` of `app/shell/row-copy.ts`, which the list places that are not mounted
 * yet (History, Folder, Tags, Trash, Receipts, Reads) draw their rows' words with: it waits for their mount.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the words the row takes are one object, not a fresh one per render", () => {
  it("hands back the SAME spoken object across renders, which is what a row memo compares on", async () => {
    const { useRowBadgeCopy } = await import("@ohmail/app-logic/text/row-copy");
    const seen: unknown[] = [];
    function Probe({ tick }: { tick: number }) {
      const copy = useRowBadgeCopy(useTranslations("message"));
      seen.push(copy.spoken);
      return h("i", null, String(tick));
    }
    const box = document.createElement("div");
    document.body.appendChild(box);
    const r = createRoot(box);
    const render = async (tick: number): Promise<void> => {
      await act(async () => {
        r.render(h(NextIntlClientProvider, {
          locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(Probe, { tick }),
        }));
      });
    };
    await render(1);
    await render(2);
    await render(3);
    expect(seen).toHaveLength(3);
    // One object across every render: a `spoken={{…}}` literal at a call site would be three.
    expect(new Set(seen).size).toBe(1);
    await act(async () => { r.unmount(); });
    box.remove();
  });
});
