/** @vitest-environment jsdom */
import type { EngineMessage, Folder, UnsubscribeHeaderState } from "@ohmail/wire";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import { within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import { act, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import { screenerReport, screenerRow } from "./fixtures/live-screener";
import { openScreenerSender } from "./fixtures/live-screener-unsubscribe";

async function pressControl(control: HTMLElement): Promise<void> {
  await act(async () => { control.click(); });
}

describe("the unsubscribe coupling is disclosed BEFORE it runs", () => {
  afterEach(teardownShellEnv);

  const address = "waiting@bulk.example";
  const rowId = "held";
  const copy = messages.screener;
  const confirmedLabel = copy.place.unsub.screened;
  const continueLabel = messages.screening.unsubCommitMaybe;
  let decisions: Array<{ id: string; body: unknown }>;

  async function openSheet(opts: {
    bodies?: Array<UnsubscribeHeaderState | null>;
    verdict?: EngineMessage["authVerdict"];
    off?: boolean;
    refused?: boolean;
  } = {}): Promise<HTMLElement> {
    installShellEnv();
    const [first = null, ...older] = opts.bodies ?? [];
    const opened = await openScreenerSender({
      address,
      letters: [
        { id: rowId, posture: first, verdict: opts.verdict },
        ...older.map((posture, index) => ({ id: `older-${index + 1}`, posture, verdict: opts.verdict })),
      ],
      autoUnsubscribe: !opts.off,
      refused: opts.refused,
    });
    decisions = opened.decisions;
    return opened.shell;
  }

  const actions = (shell: HTMLElement) => within(shell).getByRole("toolbar", { name: copy.place.panel });
  const dialog = () => within(document.body).getByRole("dialog", { name: confirmedLabel });
  const press = (shell: HTMLElement, name = copy.pileScreenOut) =>
    pressControl(within(actions(shell)).getByRole("button", { name }));
  const sentTo = (dest: Folder, unsubscribeIds?: string[]) => [{
    id: rowId, body: { decision: "no", dest, scope: "sender", applyRetro: false, ...(unsubscribeIds ? { unsubscribeIds } : {}) },
  }];

  it("screening a waiting sender out opens the disclosure instead of committing", async () => {
    const shell = await openSheet({ bodies: ["one_click"], verdict: "pass" });
    await press(shell);
    expect(dialog().textContent).toContain("Confirming also sends them a one-click unsubscribe request for the waiting mail");
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual([]);

    await pressControl(within(dialog()).getByRole("button", { name: confirmedLabel }));
    expect(decisions).toEqual(sentTo("ohmail/Screened", [rowId]));
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual(sentTo("ohmail/Screened", [rowId]));
  });

  it("cancelling dispatches nothing and puts the destinations back", async () => {
    const shell = await openSheet();
    await press(shell);
    await pressControl(within(dialog()).getByRole("button", { name: copy.cancel }));
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual([]);
    expect(within(document.body).queryByRole("dialog", { name: confirmedLabel })).toBeNull();
    expect(within(actions(shell)).getByRole("button", { name: copy.pileScreenOut })).toBeTruthy();
    expect(within(actions(shell)).getByRole("button", { name: copy.pileSpam })).toBeTruthy();
  });

  it("OFF: a waiting sender commits straight away, with no disclosure of a request nobody will send", async () => {
    const shell = await openSheet({ off: true, bodies: ["one_click"], verdict: "pass" });
    await press(shell);
    expect(within(document.body).queryByRole("dialog")).toBeNull();
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual(sentTo("ohmail/Screened"));
  });

  it("OFF: spam likewise — both reject destinations read the same switch", async () => {
    const shell = await openSheet({ off: true, bodies: ["one_click"], verdict: "pass", refused: true });
    await press(shell, copy.pileSpam);
    expect(within(document.body).queryByRole("dialog")).toBeNull();
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual([{
      id: rowId,
      body: {
        decision: "no", dest: "ohmail/Quarantine", scope: "confirmed_sender", applyRetro: false, confirmedIds: [rowId],
      },
    }]);
    expect(screenerRow(shell, rowId)?.textContent).toContain("Not saved");
  });

  it("held mail read and offering no one-click: the confirm still says the sender-level condition", async () => {
    const shell = await openSheet({ bodies: ["no_header"], verdict: "pass" });
    await press(shell);
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual([]);
    expect(dialog().textContent).toContain("if their waiting mail offers one-click unsubscribe");
    expect(dialog().textContent).not.toContain("will also send");
  });

  it("a one-click letter its provider did not confirm: the condition, not the fact", async () => {
    const shell = await openSheet({ bodies: ["one_click"], verdict: "unavailable" });
    await press(shell);
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual([]);
    expect(dialog().textContent).toContain("if their waiting mail offers one-click unsubscribe");
    expect(within(dialog()).queryByRole("button", { name: confirmedLabel })).toBeNull();
  });

  it("a held letter still unread: the same condition, and its commit is Continue rather than a promise", async () => {
    const shell = await openSheet({ bodies: ["no_header", null] });
    await press(shell);
    expect(dialog().textContent)
      .toContain("Confirming also asks to unsubscribe you if their waiting mail offers one-click unsubscribe");
    expect(within(dialog()).queryByRole("button", { name: confirmedLabel })).toBeNull();
    await pressControl(within(dialog()).getByRole("button", { name: continueLabel }));
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual(sentTo("ohmail/Screened"));
  });

  it("the shell hands the sheet each held letter's posture, read from the body the server sent", async () => {
    const shell = await openSheet({ bodies: [null, "one_click"], verdict: "pass" });
    await press(shell);
    expect(dialog().textContent).toContain("Confirming also sends them a one-click unsubscribe request for the waiting mail");
    expect(within(dialog()).getByRole("button", { name: confirmedLabel })).toBeTruthy();
    expect(decisions).toEqual([]);
  });

  it("the prop defaults to ON: a caller that passes nothing still discloses", async () => {
    const shell = await openSheet();
    await press(shell);
    expect(dialog()).toBeTruthy();
    expect(decisions).toEqual([]);

    await pressControl(within(dialog()).getByRole("button", { name: continueLabel }));
    expect(screenerReport()).toContain("Screened out");
    expect(screenerReport()).not.toContain("unsubscribe");
    await pressControl(within(document.body).getByRole("button", { name: "Undo" }));
    await tick(COMMIT_MS + 1);
    expect(decisions).toEqual([]);
    expect(screenerRow(shell, rowId)).toBeTruthy();
  });
});
