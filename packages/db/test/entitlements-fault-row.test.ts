import { describe, it, expect } from "vitest";
import { entitlementsFaultRow, EDGE_THROTTLED_ERROR_CLASS, OUTLIVED_REQUEST_ERROR_CLASS } from "../src/api-faults.js";

/**
 * THE CREDIT-CHECK FAULT AS AN `api_faults` ROW (cloud 0033).
 *
 * The mapping alone is here; `entitlements-fault-row.pg.test.ts` proves the rows it produces are
 * ACCEPTED by 0033's own constraint text, which is the half that decides whether the diagnosis
 * survives contact with the database.
 */
const AT = new Date("2026-09-13T07:00:00.000Z");

describe("the route is synthetic, so a plane outage is its own series", () => {
  it("names the far end and the path, and never the route whose request failed", () => {
    // The route that answered 503 ALREADY writes its own row. A second row under
    // `/screener/suggest` would double the count every rule on this table reads, and the cause —
    // which is what the operator is missing — would still not be named.
    expect(entitlementsFaultRow({ path: "/v1/spend", status: null }, "api", AT).route)
      .toBe("entitlements:/v1/spend");
    expect(entitlementsFaultRow({ path: "/v1/access", status: 503 }, "api", AT).route)
      .toBe("entitlements:/v1/access");
    for (const p of ["/v1/spend", "/v1/access", "/v1/spend/release"]) {
      expect(entitlementsFaultRow({ path: p, status: null }, "api", AT).route)
        .not.toContain("/screener");
    }
  });

  it("the arm is the caller's, not a literal — a widened CHECK is then one value", () => {
    // `api_faults_arm_check` admits 'api' and 'worker' and refuses 'entitlements' (23514,
    // measured). The honest third value needs a migration, so the caller says which arm it is.
    expect(entitlementsFaultRow({ path: "/v1/spend", status: null }, "api", AT).arm).toBe("api");
    expect(entitlementsFaultRow({ path: "/v1/spend", status: null }, "worker", AT).arm)
      .toBe("worker");
  });
});

describe("the status stays inside the column's 5xx CHECK without inventing one", () => {
  it("nothing arrived reads 504", () => {
    const row = entitlementsFaultRow({ path: "/v1/spend", status: null }, "api", AT);
    expect(row.status).toBe(504);
    expect(row.errorClass).toBe("EntitlementsCallTimeout");
  });

  it("the program's own 5xx passes through, so an outage keeps its shape", () => {
    for (const s of [500, 502, 503, 599]) {
      const row = entitlementsFaultRow({ path: "/v1/spend", status: s }, "api", AT);
      expect(row.status, `status ${String(s)}`).toBe(s);
      expect(row.errorClass).toBe("EntitlementsCallRefused");
    }
  });

  it("anything the column would REFUSE becomes 502 rather than losing the row", () => {
    // `api_faults_status_check` is 500–599. A 4xx written verbatim is refused by the database,
    // and a refused insert takes the diagnosis with it — which is the whole reason for the row.
    for (const s of [400, 401, 404, 429, 200, 301]) {
      const row = entitlementsFaultRow({ path: "/v1/access", status: s }, "api", AT);
      expect(row.status, `status ${String(s)}`).toBe(502);
      expect(row.status).toBeGreaterThanOrEqual(500);
      expect(row.status).toBeLessThanOrEqual(599);
    }
  });

  it("every field clears the length ceiling, and the request id is null by construction", () => {
    const row = entitlementsFaultRow({ path: "/v1/account/release", status: 503 }, "api", AT);
    expect(row.route.length).toBeLessThanOrEqual(200);
    expect(row.method.length).toBeLessThanOrEqual(20);
    expect(row.errorClass.length).toBeLessThanOrEqual(200);
    // Our request id is bound by the middleware, downstream of the client that dials. Null is the
    // state the column names, not a value that was dropped.
    expect(row.requestId).toBeNull();
    expect(row.at).toBe(AT);
  });
});

describe("a call that outlived its request is its own class", () => {
  it("no answer behind a response reads the outlived class, still inside the 5xx CHECK", () => {
    const row = entitlementsFaultRow(
      { path: "/v1/access", status: null, outlivedRequest: true }, "api", AT);
    expect(row.errorClass).toBe(OUTLIVED_REQUEST_ERROR_CLASS);
    expect(row.status).toBe(504);
  });

  it("an answered 5xx is the program's refusal whoever waited; a waited-on timeout stays a timeout", () => {
    expect(entitlementsFaultRow({ path: "/v1/access", status: 503, outlivedRequest: true }, "api", AT)
      .errorClass).toBe("EntitlementsCallRefused");
    expect(entitlementsFaultRow({ path: "/v1/access", status: null, outlivedRequest: false }, "api", AT)
      .errorClass).toBe("EntitlementsCallTimeout");
  });
});

describe("a 429 is the edge's: the program never answers it, so no upstream did", () => {
  it("reads 502 under the edge class, whoever waited", () => {
    expect(EDGE_THROTTLED_ERROR_CLASS).toBe("EntitlementsEdgeThrottled");
    for (const outlivedRequest of [false, true]) {
      const row = entitlementsFaultRow({ path: "/v1/access", status: 429, outlivedRequest }, "worker", AT);
      expect([row.status, row.errorClass], String(outlivedRequest)).toEqual([502, EDGE_THROTTLED_ERROR_CLASS]);
    }
  });

  it("every other status the column refuses stays the program's refusal at 502", () => {
    for (const s of [400, 401, 404, 200, 301]) {
      expect(entitlementsFaultRow({ path: "/v1/access", status: s }, "api", AT), String(s))
        .toMatchObject({ status: 502, errorClass: "EntitlementsCallRefused" });
    }
  });
});
