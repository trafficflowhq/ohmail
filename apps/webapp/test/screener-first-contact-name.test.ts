import { describe, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { notifiedSenderName } from "@ohmail/client-engine";
import { personalAt } from "../../../test/support/fixture-credentials.js";

const PHISH = personalAt("fixture.mila", "gmail.com");
const message = (senderCheck: EngineMessage["senderCheck"]): Pick<EngineMessage, "from" | "senderCheck"> => ({
  from: { name: "PostFinance", address: PHISH }, senderCheck,
});

describe("the identity fact on the web", () => {
  it("the guided first decision and every one-line name carry the claim with its denial", () => {
    const not = (brand: string) => `Not ${brand}`;
    expect(notifiedSenderName({ ...message({ reason: "impersonation", brand: "PostFinance", domainShared: true }) }, not))
      .toBe("PostFinance (Not PostFinance)");
    expect(notifiedSenderName({ from: { name: "PostFinance", address: personalAt("fixture.reto", "gmail.com") }, checked: { brand: "PostFinance" } }, not))
      .toBe("PostFinance (Not PostFinance)");
    expect(notifiedSenderName({ from: { name: "Anna", address: "a@firma.example" } }, not)).toBe("Anna");
  });
});
