/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import { fixture, mountJoin, signInFrom, unmountJoin } from "./join-step-up-fixture.js";

describe("returning to mailbox setup", () => {
  it("shows the mailbox choices without requesting another set of recovery codes", async () => {
    const { host } = await mountJoin();
    expect(host.querySelector("h1")?.textContent?.trim()).toBe(en.onboarding.providerFirst);
    expect(fixture.codesRequests).toEqual([]);
  });

  it("requires fresh sign-in for missing recovery codes and generates one sheet before mailbox setup", async () => {
    fixture.hasCodes = false;
    const expired = await mountJoin();
    expect(expired.host.querySelector("h1")?.textContent).toBe(en.join.expiredTitle);
    const link = [...expired.host.querySelectorAll("a")].find((a) => a.textContent === en.join.signIn);
    const retry = new URL(link!.getAttribute("href")!, "https://example.test").href;
    await unmountJoin();

    expect(await signInFrom(retry)).toEqual(["/join"]);
    expect(fixture.recentFactor).toBe(true);
    const { host, act, settle } = await mountJoin();
    expect(host.textContent).toContain("abcd-efgh-ijkl");
    const saved = [...host.querySelectorAll("button")].find((b) => b.textContent === en.join.codesSaved);
    await act(async () => { saved!.click(); });
    await settle();
    expect(host.querySelector("h1")?.textContent?.trim()).toBe(en.onboarding.providerFirst);
    expect(fixture.codesRequests).toEqual(["1", "1"]);

    await unmountJoin();
    const reopened = await mountJoin();
    expect(reopened.host.querySelector("h1")?.textContent?.trim()).toBe(en.onboarding.providerFirst);
    expect(fixture.codesRequests).toHaveLength(2);
  });

  it.each(["mailbox", "codes", "expired"] as const)("offers a way back to the app from %s", async (step) => {
    fixture.hasCodes = step === "mailbox";
    fixture.recentFactor = step === "codes";
    const { host } = await mountJoin();
    const exit = [...host.querySelectorAll("a")].find((a) => a.textContent === "Back to ohmail");
    expect(exit?.getAttribute("href")).toBe("/?setup=later");
  });
});
