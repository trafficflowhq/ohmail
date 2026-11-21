/** @vitest-environment jsdom */
/**
 * WHAT TODAY'S FEED SAID, SAID BY THE MAIL GROUND, over the new shell's door (the frame over the ground, as the
 * entries mount it): the update notice with its Restart and the restart hold, no version line for the running
 * ohmail, and the rail's account line withheld where nobody is known. Moved from `frame/todays-feeds.test.tsx`
 * (whose remaining cases still read today's feed, each by its row), their expectations as they were.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceUpdate, announceVersion, holdFilesForRestart, holdForRestart, resetUpdateStoreForTests } from "@ohmail/app-logic/doors/app-update";
import messages from "../../messages/en.json";
import { engineOver, setup, storeWith, teardown } from "../_view-shell";

/** THE NEW SHELL'S DOOR: the frame over the ground, as the entries mount it. */
async function mountMail(o: { pull?: boolean } = {}) {
  const engine = engineOver(await storeWith([]));
  /* "Pull new mail" is offered where the engine has a doorbell to ring (`pullAvailable`): the input of today's
     `pull: { available: true }`, handed as the engine's adapter carries it. */
  if (o.pull) Object.assign((engine as unknown as { adapter: object }).adapter, { requestPull: async () => undefined });
  const { MailShell } = await import("../_mail-shell");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  return render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC" } as never,
    h(ThemeProvider as never, null, h(ToastHost as never, null, h(MailShell, { demo: false, engine })))));
}

beforeEach(() => {
  setup();
  window.location.hash = "#/ohbox";
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  resetUpdateStoreForTests();
});
afterEach(async () => {
  cleanup();
  resetUpdateStoreForTests();
  await teardown();
});

const rail = () => screen.getByRole("navigation", { name: "Places" });

describe("the rail's account line, fed by the ground", () => {
  const accountLine = () => within(rail()).queryByRole("button", { name: /mailbox@example\.com|account@example\.com|\?/ });

  it("is withheld where nobody is known: no circle with a question mark and an empty name", async () => {
    await mountMail({ pull: true });
    await screen.findByRole("navigation", { name: "Places" });
    expect(accountLine()).toBeNull();
    expect(within(rail()).queryByText("?")).toBeNull();
    // Pull new mail still stands in the foot.
    expect(within(rail()).getByRole("button", { name: /Pull new mail/ })).toBeTruthy();
  });
});

describe("the update notice, on the ground", () => {
  it("says a newer ohmail is ready, and Later puts it away", async () => {
    await mountMail();
    const restart = vi.fn();
    await act(async () => { announceUpdate({ kind: "ready", version: "2.0.1", act: restart } as never); });
    expect(screen.getByText(/2\.0\.1/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart" })); });
    expect(restart).toHaveBeenCalledOnce();
  });

  /* The rail's foot keeps no version line: the running version is said nowhere, with or without an offer, and the
     update notice names the version that is ready. */
  it("keeps no version line for the running ohmail; the update notice names the ready one", async () => {
    const view = await mountMail();
    await act(async () => { announceVersion("2.0.0"); });
    expect(view.container.textContent, "the running version took a line").not.toContain("2.0.0");
    await act(async () => { announceUpdate({ kind: "ready", version: "2.0.1", act: () => {} } as never); });
    expect(view.container.textContent).toContain("2.0.1");
    expect(view.container.textContent, "the offer named the running version").not.toContain("2.0.0");
  });

  it("writes an open editor's words before Restart restarts, and a hold that began meanwhile stops the press", async () => {
    await mountMail();
    const order: string[] = [];
    const release = holdForRestart(async () => { order.push("written"); });
    await act(async () => { announceUpdate({ kind: "ready", version: "2.0.1", act: () => order.push("restarted") } as never); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart" })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(order).toEqual(["written", "restarted"]);
    release();
  });

  it("leaves the restart uncalled when a hold begins while the editor's words are written", async () => {
    await mountMail();
    const restart = vi.fn();
    let drop = (): void => {};
    /* The editor takes files while its words are written: a hold that was not there when Restart was pressed. */
    const release = holdForRestart(async () => {
      drop = holdFilesForRestart();
    });
    await act(async () => { announceUpdate({ kind: "ready", version: "2.0.1", act: restart } as never); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restart" })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(restart, "the restart dropped the files the editor took meanwhile").not.toHaveBeenCalled();
    release();
    drop();
  });
});
