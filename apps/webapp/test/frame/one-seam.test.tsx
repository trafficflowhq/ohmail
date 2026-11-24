/** @vitest-environment jsdom */
/**
 * A DELETE A CLOSED TAB LEFT IN THE JOURNAL IS REPLAYED ONCE, by the one press seam of the frame, over the new shell
 * as the web's entry mounts it (the frame over the mail ground, `_mail-shell.tsx`): at the mount, at the seated
 * Ohbox with its reading column, and never again on a walk away and back. (The old shell's composition handing the
 * frame's room its own seam left with it; the room's one seam over a walk is held by the ground's own cases,
 * `packages/app/test/mail/ground.test.tsx`.)
 */
import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { armDeleteIntent } from "@ohmail/app-logic/press/delete-intents";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../../messages/en.json";
import { act, engineOver, msg, NOW, setup, storeWith, teardown, waitFor, S } from "../_view-shell";
import { HARNESS_SCOPE } from "../_mail-shell";

let root: Root | null = null;

/** The new shell as the web's entry mounts it (`_mail-shell.tsx`): the frame over the mail ground. */
async function draw(engine: OhmailEngine) {
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { MailShell } = await import("../_mail-shell");
  const tree = h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW } as never,
    h(ThemeProvider as never, null, h(ToastHost as never, null, h(MailShell, { demo: false, engine }))));
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(tree); });
}

/** A visit as the address bar makes one: the fragment changes and the browser announces it. */
async function visit(fragment: string) {
  await act(async () => {
    window.history.replaceState(window.history.state, "", fragment);
    window.dispatchEvent(new Event("hashchange"));
  });
}

/** A place the walk goes to and comes back from. */
const NEWS_ADDRESS = "#/reads";
const readerColumn = () => screen.queryByRole("region", { name: "Reading" });

beforeEach(() => {
  setup();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  window.location.hash = NEWS_ADDRESS;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  await teardown();
});

describe("one press seam per frame, over the new shell as the web's entry mounts it", () => {
  it("a delete a closed tab left in the journal is replayed once, at the mount, on a reader's place too", async () => {
    const engine = engineOver(await storeWith([msg("m1")]));
    S.engine = engine;
    const replayed: string[] = [];
    const replay = engine.replayDelete.bind(engine);
    engine.replayDelete = (messageId, opts) => {
      replayed.push(messageId);
      return replay(messageId, opts);
    };
    armDeleteIntent({ id: "press-of-the-closed-tab", messageIds: ["m1"], at: Date.now() }, HARNESS_SCOPE);
    window.location.hash = "#/ohbox";
    await draw(engine);
    await waitFor(() => readerColumn() !== null, "the seated Ohbox's reading column");
    await waitFor(() => replayed.length > 0, "the journal's replay");
    await visit(NEWS_ADDRESS);
    await waitFor(() => screen.queryByRole("region", { name: "News" }) !== null, "the mounted News list");
    await visit("#/ohbox");
    await waitFor(() => readerColumn() !== null, "the seated Ohbox again");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(replayed, "the journal was replayed by more than one seam, or again on the walk").toEqual(["m1"]);
  });
});
