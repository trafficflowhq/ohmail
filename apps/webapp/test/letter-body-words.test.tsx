/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTranslator } from "next-intl";
import { MessageBody, COPY as MAIL_BODY_COPY } from "../../../packages/letter-body/src/MessageBody";
import { COPY as BODY_TEXT_COPY } from "../../../packages/letter-body/src/BodyText";
import { setBodyWords, type BodyNamespace } from "../../../packages/letter-body/src/words";
import { fillFrom, setActiveCatalog } from "../app/shell/locale";
import type { Translator } from "@ohmail/app-logic/text/translator";

/**
 * The body's words are handed in: by whoever mounts it through `setBodyWords`, and by both hosts
 * through the locale register they already set. Nothing handed is English.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Catalog = Record<string, Record<string, string>>;
const read = (locale: string): Catalog =>
  JSON.parse(readFileSync(resolve(__dirname, "..", "messages", `${locale}.json`), "utf8")) as Catalog;
const EN = read("en");
const GERMAN = fillFrom(EN as never, read("de") as never) as Catalog;

const german = (namespace: BodyNamespace): Translator =>
  createTranslator({ locale: "de", messages: GERMAN as never, namespace: namespace as never }) as unknown as Translator;

afterEach(() => {
  setBodyWords(null);
  setActiveCatalog("en", null);
});

describe("the body's words", () => {
  it("speaks German through the words handed to it", () => {
    setBodyWords({ locale: "de", translatorOf: german });
    expect(MAIL_BODY_COPY.linkAskTitle).toBe(GERMAN.mailBody!.linkAskTitle);
    expect(MAIL_BODY_COPY.linkAskGoes("a.example")).toBe("Er führt zu a.example.");
    expect(BODY_TEXT_COPY.show).toBe(GERMAN.bodyText!.show);
  });

  it("speaks German through the locale register both hosts set", () => {
    setActiveCatalog("de", GERMAN);
    expect(MAIL_BODY_COPY.linkAskTitle).toBe(GERMAN.mailBody!.linkAskTitle);
    expect(BODY_TEXT_COPY.show).toBe(GERMAN.bodyText!.show);
  });

  it("speaks English again once the words are taken back", () => {
    setBodyWords({ locale: "de", translatorOf: german });
    setBodyWords(null);
    expect(MAIL_BODY_COPY.linkAskTitle).toBe(EN.mailBody!.linkAskTitle);
    setActiveCatalog("de", GERMAN);
    setActiveCatalog("en", null);
    expect(BODY_TEXT_COPY.show).toBe(EN.bodyText!.show);
  });

  it("speaks English for a namespace the handed words lack", () => {
    setBodyWords({ locale: "de", translatorOf: (namespace) => (namespace === "mailBody" ? german(namespace) : null) });
    expect(MAIL_BODY_COPY.linkAskTitle).toBe(GERMAN.mailBody!.linkAskTitle);
    expect(BODY_TEXT_COPY.show).toBe(EN.bodyText!.show);
  });

  it("writes the ask page in the handed locale", async () => {
    setBodyWords({ locale: "de", translatorOf: german });
    const blobs: Blob[] = [];
    const urlStatics = URL as unknown as Record<string, unknown>;
    const had = { create: urlStatics.createObjectURL, revoke: urlStatics.revokeObjectURL };
    urlStatics.createObjectURL = (blob: Blob): string => {
      blobs.push(blob);
      return `blob:https://app.example.test/${blobs.length}`;
    };
    urlStatics.revokeObjectURL = (): void => {};
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    try {
      await act(async () => {
        root.render(React.createElement(MessageBody, {
          text: "fallback",
          html: `<p>Sign in again at <a href="https://example.net/r/a1">https://example.com/login</a>.</p>`,
        }));
      });
      expect(blobs).toHaveLength(1);
      const text = await new Promise<string>((done) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result));
        reader.readAsText(blobs[0]!);
      });
      const page = new DOMParser().parseFromString(text, "text/html");
      expect(page.documentElement.getAttribute("lang")).toBe("de");
      expect(page.querySelector("h1")?.textContent).toBe(GERMAN.mailBody!.linkAskTitle);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      urlStatics.createObjectURL = had.create;
      urlStatics.revokeObjectURL = had.revoke;
    }
  });
});
