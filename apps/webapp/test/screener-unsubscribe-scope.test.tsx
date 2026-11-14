/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import { afterEach, describe, expect, it } from "vitest";
import {
  clickUnsubscribe, mountUnsubscribe, unmountUnsubscribe, unsubscribeActions, unsubscribeQuestion,
} from "./_screener-unsubscribe-scope.js";
import { screenerReport } from "./fixtures/live-screener.js";
import { tick } from "./fixtures/live-walk-shell.js";

const list = "post@lists.example";
const notice = "Screen out and Spam are the exception here: they set aside only the messages that claim to be PostFinance, and make no rule.";

afterEach(unmountUnsubscribe);

describe("the unsubscribe coupling is disclosed BEFORE it runs", () => {
  it("a list the person let in: Screen out commits with no disclosure, and the foot says it makes no rule", async () => {
    const { shell, writes } = await mountUnsubscribe([list], { claimsOnly: true });
    expect(within(shell).getByText(notice)).toBeTruthy();
    await clickUnsubscribe(unsubscribeActions(shell).getByRole("button", { name: "Screen out" }));
    expect(unsubscribeQuestion()).toBeNull();
    expect(screenerReport()).toContain("No rule was made");
    await tick(COMMIT_MS + 1);
    expect(writes).toEqual([{
      path: "/api/screener/1",
      body: { decision: "no", dest: "ohmail/Screened", scope: "sender", applyRetro: false },
    }]);
  });

  it("CONTROL: a list the store says no claims-only press for opens the disclosure, and the foot promises the rule alone", async () => {
    const { shell, writes } = await mountUnsubscribe([list], { claimsOnly: false });
    expect(within(shell).queryByText(notice)).toBeNull();
    await clickUnsubscribe(unsubscribeActions(shell).getByRole("button", { name: "Screen out" }));
    expect(unsubscribeQuestion()).not.toBeNull();
    expect(unsubscribeQuestion()!.textContent).toContain("this makes a rule");
    await tick(COMMIT_MS + 1);
    expect(writes).toEqual([]);
  });
});
