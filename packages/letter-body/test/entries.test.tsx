/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { OhmailEngine } from "@ohmail/client-engine";
import { LETTER_SANDBOX } from "@ohmail/ui/mail";
import { MessageBody } from "@ohmail/letter-body";
import { setRenderedLinksSink } from "@ohmail/letter-body/links";
import { forgetMailDocs } from "@ohmail/letter-body/cache";
import { FRAME_SANDBOX } from "../src/MessageBody";
import { mailDocCacheFor } from "../src/mail-doc-cache";

/**
 * The body's entries are its own files, not copies: what a caller arms through a leaf by its name is
 * what the renderer, reached through its door, reports to and keeps in. Two copies would split each
 * guarantee (a sign-out that forgets the documents of one copy only).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

afterEach(() => setRenderedLinksSink(null));

describe("the body's entries", () => {
  it("a sink armed through the links leaf hears the links of a body mounted through the door", async () => {
    const heard: string[][] = [];
    setRenderedLinksSink((_surface, hrefs) => heard.push([...hrefs]));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(MessageBody, {
        owner: null,
        text: "fallback",
        html: `<p>Read <a href="https://example.net/help">our help pages</a>.</p>`,
      }));
    });
    await act(async () => { root.unmount(); });
    host.remove();
    expect(heard[0]).toEqual(["https://example.net/help"]);
  });

  it("the cache leaf forgets what the renderer's own cache module kept", () => {
    const cache = mailDocCacheFor<string>({} as OhmailEngine);
    cache.write({ messageId: "m1", html: "<p>hi</p>" } as Parameters<typeof cache.write>[0], "doc", 3);
    expect(cache.size).toBe(1);
    forgetMailDocs();
    expect(cache.size).toBe(0);
  });

  it("the kit's letter frame is held to the body's sandbox, which allows no script, form, top navigation or modal", () => {
    expect(LETTER_SANDBOX).toBe(FRAME_SANDBOX);
    for (const token of ["allow-scripts", "allow-forms", "allow-top-navigation", "allow-modals"]) {
      expect(FRAME_SANDBOX.split(/\s+/)).not.toContain(token);
    }
  });
});
