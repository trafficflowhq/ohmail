/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../messages/en.json";
import {
  announceUpdate,
  currentUpdateOffer,
  holdFilesForRestart,
  holdForRestart,
  putAwayThisRun,
  resetUpdateStoreForTests,
  sendWaits,
  setSendWaits,
} from "../app/shell/app-update";
import de from "../messages/de.json";
import { noticeServerAnswered, noticeUpdateAnswer, hearUpdateAnswer } from "../app/shell/update-answer";
import type { SendLineItem, SendPhase } from "../app/shell/mail-send";
import { SendWaitsRelay, sendWaitsOf, UpdateDot, UpdateLine } from "../app/shell/UpdateLine";

/**
 * ═══ THE LINE THAT SAYS A NEWER OHMAIL EXISTS ═══════════════════════════════════════════════
 *
 * One quiet line at the foot of the rail, above Command: a mark, a sentence, a verb, ×. In a tab
 * the newer thing is a build this origin already serves and the verb reloads; in the desktop
 * window it is a signed release the native process verified, ready, downloading or failed. The
 * line knows neither: it renders a sentence and calls the callback the offer carries, which is
 * what keeps the shared shell unable to name a feed, a version or an install.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const copy = (en as { update: Record<string, string> }).update;
const say = (key: string, version = "0.30.6") => copy[key]!.replace("{version}", version);

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages: en as never, children: node }));
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  resetUpdateStoreForTests();
});

const verb = (): HTMLButtonElement | null => host?.querySelector<HTMLButtonElement>(".ul-do") ?? null;
const later = (): HTMLButtonElement | null => host?.querySelector<HTMLButtonElement>(".ul-x") ?? null;
const click = async (button: HTMLElement | null): Promise<void> => {
  await act(async () => {
    button!.click();
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
};

describe("the update line", () => {
  it("renders NOTHING when there is nothing to say", async () => {
    const el = await mount(h(UpdateLine));
    expect(el.innerHTML).toBe("");
  });

  it("READY: the version, Restart with what a restart costs, and Later", async () => {
    const restart = vi.fn();
    const el = await mount(h(UpdateLine));
    await act(async () => announceUpdate({ kind: "ready", version: "0.30.6", act: restart, key: "ready:0.30.6" }));

    expect(el.textContent).toContain(say("lineReady"));
    expect(verb()!.textContent).toBe(copy.lineRestart);
    const tip = document.getElementById(verb()!.getAttribute("aria-describedby")!);
    // A draft's text is saved first and its files hold the restart; nothing wider is promised.
    expect(tip?.textContent).toBe("Restarts ohmail; your drafts are kept");
    expect(later()!.getAttribute("aria-label")).toBe(copy.lineLater);
    await click(verb());
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("DOWNLOADING: the version and an indeterminate track, and nothing to press", async () => {
    const el = await mount(h(UpdateLine));
    await act(async () => announceUpdate({ kind: "downloading", version: "0.30.6", key: "downloading:0.30.6" }));
    expect(el.textContent).toContain(say("lineDownloading"));
    expect(el.querySelector(".rs-track i")).not.toBeNull();
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("A SEND WAITS: Restart stands, greyed, says why, and pressing it does nothing", async () => {
    const restart = vi.fn();
    const el = await mount(h(UpdateLine));
    await act(async () => {
      announceUpdate({ kind: "ready", version: "0.30.6", act: restart, key: "ready:0.30.6" });
      setSendWaits(true);
    });
    expect(verb()!.getAttribute("aria-disabled")).toBe("true");
    expect(el.textContent).toContain(copy.lineAfterSend);
    await click(verb());
    expect(restart).not.toHaveBeenCalled();

    await act(async () => setSendWaits(false));
    expect(verb()!.getAttribute("aria-disabled")).toBeNull();
    expect(el.textContent).not.toContain(copy.lineAfterSend);
    await click(verb());
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("A DRAFT HOLDS FILES: their bytes live in memory only, so Restart stands greyed and says why", async () => {
    const restart = vi.fn();
    const el = await mount(h(UpdateLine));
    let release = (): void => {};
    await act(async () => {
      announceUpdate({ kind: "ready", version: "0.30.6", act: restart, key: "ready:0.30.6" });
      release = holdFilesForRestart();
    });
    expect(verb()!.getAttribute("aria-disabled")).toBe("true");
    expect(verb()!.getAttribute("title")).toBe(copy.lineAfterFilesTitle);
    expect(el.textContent).toContain(copy.lineAfterFiles);
    await click(verb());
    expect(restart, "a restart dropped the draft's files").not.toHaveBeenCalled();

    // A send waiting as well is the reason said first; with both gone, Restart presses.
    await act(async () => setSendWaits(true));
    expect(el.textContent).toContain(copy.lineAfterSend);
    await act(async () => {
      setSendWaits(false);
      release();
    });
    expect(verb()!.getAttribute("aria-disabled")).toBeNull();
    await click(verb());
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("FAILED: what did not finish, and Retry presses again", async () => {
    const retry = vi.fn();
    const el = await mount(h(UpdateLine));
    await act(async () => announceUpdate({ kind: "failed", failed: "install", version: "0.30.6", act: retry, key: "failed:install" }));
    expect(el.textContent).toContain(copy.lineInstallFailed);
    expect(verb()!.textContent).toBe(copy.lineRetry);
    await click(verb());
    expect(retry).toHaveBeenCalledTimes(1);

    await act(async () => announceUpdate({ kind: "failed", failed: "check", act: retry, key: "failed:check@1" }));
    expect(el.textContent).toContain(copy.lineCheckFailed);
  });

  it("A NEWER BUILD in a tab offers a reload, and pressing it does what the source armed", async () => {
    const reload = vi.fn();
    const el = await mount(h(UpdateLine));
    await act(async () => announceUpdate({ kind: "reload", act: reload }));
    expect(el.textContent).toContain(copy.lineReload);
    expect(verb()!.textContent).toBe(copy.lineReloadAction);
    await click(verb());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("RELOAD IS HELD by files only in memory and by a waiting send, as Restart is", async () => {
    const reload = vi.fn();
    const el = await mount(h(UpdateLine));
    let release = (): void => {};
    await act(async () => {
      announceUpdate({ kind: "reload", act: reload });
      release = holdFilesForRestart();
    });
    expect(verb()!.getAttribute("aria-disabled")).toBe("true");
    expect(verb()!.getAttribute("title")).toBe(copy.lineReloadAfterFilesTitle);
    expect(el.textContent).toContain(copy.lineAfterFiles);
    await click(verb());
    expect(reload, "a reload dropped the draft's files").not.toHaveBeenCalled();
    await act(async () => release());
    await click(verb());
    expect(reload).toHaveBeenCalledTimes(1);

    await act(async () => setSendWaits(true));
    expect(verb()!.getAttribute("title")).toBe(copy.lineReloadAfterSendTitle);
    expect(el.textContent).toContain(copy.lineAfterSend);
    await click(verb());
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => setSendWaits(false));
    await click(verb());
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("a hold that starts while the editors are written stops the reload and the restart", async () => {
    for (const kind of ["reload", "ready"] as const) {
      const go = vi.fn();
      let release = (): void => {};
      const drop = holdForRestart(async () => {
        release = holdFilesForRestart();
      });
      await mount(h(UpdateLine));
      await act(async () => announceUpdate({ kind, version: "0.30.6", act: go, key: kind }));
      await click(verb());
      expect(go, kind).not.toHaveBeenCalled();
      drop();
      await act(async () => release());
      await click(verb());
      expect(go, kind).toHaveBeenCalledTimes(1);
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
    }
  });

  it("LATER puts the line away, and its key stays put away for the rest of the run", async () => {
    const el = await mount(h(UpdateLine));
    await act(async () => announceUpdate({ kind: "ready", version: "0.30.6", act: () => {}, key: "ready:0.30.6" }));
    await click(later());
    expect(el.innerHTML).toBe("");
    expect(currentUpdateOffer()).toBeNull();
    expect(putAwayThisRun("ready:0.30.6")).toBe(true);
    expect(putAwayThisRun("ready:0.30.7")).toBe(false);
  });

  it("AN OPEN EDITOR IS WRITTEN BEFORE THE RESTART IS ASKED FOR", async () => {
    const order: string[] = [];
    holdForRestart(async () => {
      await Promise.resolve();
      order.push("editor saved");
    });
    await mount(h(UpdateLine));
    await act(async () => announceUpdate({ kind: "ready", version: "0.30.6", act: () => order.push("restart"), key: "k" }));
    await click(verb());
    expect(order).toEqual(["editor saved", "restart"]);
  });

  it("adopts an offer that was made before it mounted", async () => {
    announceUpdate({ kind: "reload", act: () => {} });
    const el = await mount(h(UpdateLine));
    expect(el.textContent).toContain(copy.lineReload);
  });
});

describe("a server's own answer on the update line", () => {
  const reload = vi.fn();
  const remedy = { verb: "reload" as const, act: reload };
  const copyIn = (cat: unknown): Record<string, string> => (cat as { update: Record<string, string> }).update;

  it("TOO OLD in a tab: one whole sentence, Reload, and pressing it does what the host armed", async () => {
    reload.mockClear();
    const el = await mount(h(UpdateLine));
    await act(async () => noticeUpdateAnswer("tooOld", remedy));
    expect(el.textContent).toContain("This ohmail is too old for its server.");
    expect(verb()!.textContent).toBe("Reload");
    await click(verb());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("TOO OLD on the desktop says Update, in both languages, and a German tab says Neu laden", async () => {
    const update = vi.fn();
    await mount(h(UpdateLine));
    await act(async () => noticeUpdateAnswer("tooOld", { verb: "update", act: update }));
    expect(verb()!.textContent).toBe(copyIn(en).lineUpdateAction);
    await click(verb());
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount());
    host!.remove();
    resetUpdateStoreForTests();

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "de", messages: de as never, children: h(UpdateLine) }));
    });
    await act(async () => noticeUpdateAnswer("tooOld", remedy));
    expect(host.textContent).toContain("Dieses ohmail ist zu alt für seinen Server.");
    expect(verb()!.textContent).toBe("Neu laden");
    await act(async () => announceUpdate(null));
    await act(async () => noticeUpdateAnswer("tooOld", { verb: "update", act: update }));
    expect(verb()!.textContent).toBe("Aktualisieren");
  });

  it("BEING UPDATED: the sentence and no verb, and the next answer from the server lifts it", async () => {
    const el = await mount(h(UpdateLine));
    await act(async () => noticeUpdateAnswer("serverUpdating"));
    expect(el.textContent).toContain("ohmail is being updated and will be back shortly.");
    expect(verb(), "a verb on a line with nothing to press").toBeNull();
    await act(async () => hearUpdateAnswer(new Response("{}", { status: 200 })));
    expect(el.innerHTML).toBe("");
  });

  it("is never held by a send that waits: pressing Reload is not what loses a letter", async () => {
    await mount(h(UpdateLine));
    await act(async () => setSendWaits(true));
    await act(async () => noticeUpdateAnswer("tooOld", remedy));
    expect(verb()!.getAttribute("aria-disabled")).toBeNull();
    reload.mockClear();
    await click(verb());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("LATER keeps it away for the run: a line re-armed by the next failing request stays down", async () => {
    await mount(h(UpdateLine));
    await act(async () => noticeUpdateAnswer("tooOld", remedy));
    await click(later());
    expect(currentUpdateOffer()).toBeNull();
    for (let i = 0; i < 3; i++) await act(async () => noticeUpdateAnswer("tooOld", remedy));
    expect(currentUpdateOffer(), "Later was defeated by the next failing request").toBeNull();
    // "Being updated" is its own key: Later on one does not silence the other.
    await act(async () => noticeUpdateAnswer("serverUpdating"));
    expect(currentUpdateOffer()?.kind).toBe("serverUpdating");
  });

  it("an ordinary answer lifts nothing but a \"being updated\" line; nothing lifts \"too old\" but the update", async () => {
    await mount(h(UpdateLine));
    await act(async () => noticeUpdateAnswer("tooOld", remedy));
    noticeServerAnswered();
    await act(async () => hearUpdateAnswer(new Response("{}", { status: 200 })));
    expect(currentUpdateOffer()?.kind).toBe("tooOld");
  });

  it("an edge's 503 and a stray 426 are not these answers: status and code together", async () => {
    await mount(h(UpdateLine));
    await act(async () => hearUpdateAnswer(new Response("Service Unavailable", { status: 503 }), remedy));
    await act(async () => hearUpdateAnswer(new Response(JSON.stringify({ error: { code: "db_busy" } }), { status: 503 }), remedy));
    await act(async () => hearUpdateAnswer(new Response("Upgrade Required", { status: 426 }), remedy));
    await act(async () => hearUpdateAnswer(new Response(JSON.stringify({ error: { code: "server_updating" } }), { status: 426 }), remedy));
    expect(currentUpdateOffer()).toBeNull();
  });

  it("PRECEDENCE: too old replaces a reload offer; a ready or downloading update stands; being updated yields to anything saying something", async () => {
    await mount(h(UpdateLine));
    await act(async () => announceUpdate({ kind: "reload", version: "bbbb2222", act: () => {} }));
    await act(async () => noticeUpdateAnswer("serverUpdating"));
    expect(currentUpdateOffer()?.kind, "being updated replaced a standing offer").toBe("reload");
    await act(async () => noticeUpdateAnswer("tooOld", remedy));
    expect(currentUpdateOffer()?.kind).toBe("tooOld");
    await act(async () => announceUpdate({ kind: "ready", version: "2.0.0", act: () => {}, key: "ready:2.0.0" }));
    await act(async () => noticeUpdateAnswer("tooOld", remedy));
    expect(currentUpdateOffer()?.kind, "an update that is ready was replaced by the sentence about needing one").toBe("ready");
  });
});

describe("the ≡ while the drawer is closed", () => {
  it("carries a dot while there is something to press, and none while it downloads or rests", async () => {
    const el = await mount(h(UpdateDot));
    expect(el.querySelector(".upd-dot")).toBeNull();
    await act(async () => announceUpdate({ kind: "downloading", version: "0.30.6" }));
    expect(el.querySelector(".upd-dot")).toBeNull();
    await act(async () => announceUpdate({ kind: "ready", version: "0.30.6", act: () => {} }));
    expect(el.querySelector(".upd-dot")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => announceUpdate(null));
    expect(el.querySelector(".upd-dot")).toBeNull();
  });
});

describe("a send waits — the sending line's own model, and the compose's send on its way", () => {
  const item = (state: SendLineItem["state"]): SendLineItem => ({ id: state, key: "k", state, to: null, subject: null });

  it("a queued or sending item waits; a sent or ended one does not; nor an idle composer", () => {
    expect(sendWaitsOf([], "idle")).toBe(false);
    expect(sendWaitsOf([item("sending")], "idle")).toBe(true);
    expect(sendWaitsOf([item("queued")], "idle")).toBe(true);
    expect(sendWaitsOf([item("sent"), item("ended")], "idle")).toBe(false);
    for (const phase of ["sending", "queued"] as SendPhase[]) expect(sendWaitsOf([], phase), phase).toBe(true);
    for (const phase of ["sent", "failed", "unverified"] as SendPhase[]) expect(sendWaitsOf([], phase), phase).toBe(false);
  });

  it("the relay follows the line as it moves, and lets go when the shell goes", async () => {
    let items: SendLineItem[] = [];
    let moved: (() => void) | null = null;
    const api = {
      line: () => items,
      lineVersion: () => items.length,
      subscribeLine: (cb: () => void) => {
        moved = cb;
        return () => { moved = null; };
      },
      stateOf: () => ({ phase: "idle" as SendPhase }),
    };
    await mount(h(SendWaitsRelay, { api }));
    expect(sendWaits()).toBe(false);
    await act(async () => {
      items = [item("queued")];
      moved!();
    });
    expect(sendWaits()).toBe(true);
    await act(async () => {
      items = [];
      moved!();
    });
    expect(sendWaits()).toBe(false);
    await act(async () => {
      items = [item("sending")];
      moved!();
    });
    if (root) await act(async () => root!.unmount());
    root = null;
    expect(sendWaits(), "a shell that went away still says a send waits").toBe(false);
  });
});
