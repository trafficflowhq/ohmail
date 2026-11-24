/** @vitest-environment jsdom */
/**
 * DRAFT FROM YOUR TEXT ON THE HOSTS THAT HAVE NO DOOR FOR IT: the desktop window and the paired page answer the draft
 * wire through `draftReplyVia`, whose `fromText` is `none`. Mounted under the reply's view with typed words, the
 * word "Draft from your text" is not drawn, the plain control stands, and nothing is asked of the engine. Here, at
 * the root, because an app's own tests may not import another app.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import en from "../apps/webapp/messages/en.json";
import { act, message, stubDom } from "../apps/webapp/test/_draft-shell.js";
/* The composition under Write as the mail ground stands it (`write/writing-world.tsx` is today's words and keys, which leave). */
import { mountWriting, rounds, unmountWritings } from "../apps/webapp/test/_write-1-writing.js";
import { typeInto } from "../apps/webapp/test/fixtures/rich-editor-driver.js";
import { draftReplyVia } from "../apps/desktop/src/draft-reply-wire.js";

const W = en.write;

beforeEach(() => {
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => {
  await unmountWritings();
  resetComposerForTest();
});

describe("draft from your text where the host answers none", () => {
  it("the desktop's and the paired page's wire draws no Draft from your text, and nothing is asked", async () => {
    const asked: string[] = [];
    const wire = draftReplyVia(
      async (path) => {
        asked.push(path);
        return new Response("{}", { status: 500 });
      },
      () => true,
    );
    const w = await mountWriting({ messages: [message("m1")], hash: "#/ohbox", sheet: ["m1"], draftWire: wire });
    await act(async () => w.now().openReply("m1"));
    const body = await screen.findByRole("textbox", { name: W.reply.text });
    await act(async () => typeInto(body, "noon ok, bring the glaze"));
    expect(body.textContent).toContain("noon ok, bring the glaze");
    await rounds(2);
    expect(screen.queryByRole("button", { name: W.draft.fromText })).toBeNull();
    expect(screen.getByRole("button", { name: W.draft.verb })).toBeTruthy();
    expect(asked).toEqual([]);
  });
});
