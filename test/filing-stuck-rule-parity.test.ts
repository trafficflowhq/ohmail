import { describe, expect, it } from "vitest";
import { FILING_STUCK_ATTEMPTS as SERVER_ATTEMPTS, FILING_STUCK_MS as SERVER_MS } from "@trafficflow/db";
import {
  FILING_ROTATION_ESTIMATE_MS, FILING_STUCK_ATTEMPTS, FILING_STUCK_MS,
} from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ONE STUCK RULE IN TWO WORKSPACES. The server counts the stuck filings (`filingStuck`) and the
 * shell re-declares the thresholds for a server that predates that count; the shell may not import
 * the server's packages, so this repository-level file pins the two equal. A drift would make one
 * build's strip call a filing stuck that the other's count leaves out.
 */
describe("the filing stuck rule is one rule", () => {
  it("the shell's thresholds are the server's", () => {
    expect(FILING_STUCK_MS).toBe(SERVER_MS);
    expect(FILING_STUCK_ATTEMPTS).toBe(SERVER_ATTEMPTS);
  });

  it("and the wait still outlasts a rotation", () => {
    expect(SERVER_MS).toBeGreaterThan(FILING_ROTATION_ESTIMATE_MS);
  });
});
