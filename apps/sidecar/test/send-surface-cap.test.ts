import { describe, expect, it } from "vitest";
import { attachmentBudgetFor, effectiveAttachmentCap, SEND_ATTACHMENT_MAX_TOTAL_BYTES, SEND_UNMEASURED_MESSAGE_BYTES } from "@trafficflow/services";
import { HOST_SEND_MAX_TOTAL_BYTES } from "../src/host-listener.js";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { readEngineAsOneText } from "../../../test/support/engine-unit.js";

/**
 * THIS INSTALL DECLARES THAT IT HAS NO PLATFORM CEILING ON ATTACHMENT BYTES.
 *
 * The 3 MB attachment limit in `SendService` is the HOSTED API's serverless request-body limit
 * expressed in raw bytes — attachment bytes ride a JSON request there, base64, so 3 MB of raw
 * bytes encodes to a little more and still clears the platform's body cap. None of that describes this process:
 * the compose form, the send handler and the SMTP dial are all in it, there is no request body
 * anywhere between them, and the only ceiling that exists is the one the user's own submission
 * server announced.
 *
 * So the local service bag declares `sendSurfaceMaxTotalBytes: null` — "no platform ceiling" —
 * and `SendService` then caps a send at whatever the mailbox's server said, or at the 3 MB
 * constant while nothing has been measured.
 *
 * ── WHY THE DECLARATION IS ASSERTED FROM SOURCE ────────────────────────────────────────────
 *
 * `localServices` is module-private and building one needs a key provider, an auth config and a
 * send adapter — an engine's worth of setup to observe one property of one object literal. What
 * regressed in this family before is exactly that: a property missing from a literal. Comments are
 * stripped first, because the prose in this repository quotes the code it describes and an
 * assertion a comment can satisfy is worth nothing.
 *
 * The second half is the one that matters more than the declaration: `null` must select the LOOSE
 * branch only where a measurement exists. An install whose server has never been probed has no
 * measured ceiling anywhere, and the answer there is the strict constant — an unknown limit read
 * as no limit costs the user a message they composed and waited for.
 */


describe("the local engine declares no platform ceiling on a send", () => {
  /* The repo's one scanner, not a pair of regexes. The pair this replaced took the first `//` on
     any line — inside a URL string too — and read a block-comment opener quoted in a line comment
     as real, which deletes every line to the next terminator. Either way the negative below is
     asked about an extract that is no longer there, and a negative over nothing passes. */
  const src = withoutComments(readEngineAsOneText());

  it("resolved a real file", () => {
    expect(src).toContain("function localServices(");
  });

  it("the service bag declares `sendSurfaceMaxTotalBytes: null`", () => {
    expect(src).toMatch(/sendSurfaceMaxTotalBytes:\s*null/);
  });

  it("…and does not declare a NUMBER, which would re-impose a limit that is not this host's", () => {
    expect(src).not.toMatch(/sendSurfaceMaxTotalBytes:\s*\d/);
  });
});

describe("…and the HOST DOOR declares the ceiling its transport actually has", () => {
  /*
   * The paragraph above stops being the whole truth the moment the loopback listener exists:
   * on the DESKTOP-HOST door a phone's send DOES ride an HTTP request body — through the
   * adapter in `host-listener.ts`, attachments inline as base64 — so `null` ("no platform
   * ceiling") would let the compose surface accept a send the transport then kills with an
   * opaque 413. The door therefore overrides the bag with the NAMED constant, and the stdio
   * door's `null` above stays exactly as it was: the two doors of one engine genuinely differ
   * in this one fact. The constant's derivation against the adapter's byte cap is asserted as
   * arithmetic in `host-listener.e2e.test.ts`; here the census pins WHERE each declaration
   * lives.
   */
  const src = withoutComments(readEngineAsOneText());

  it("depsForHost overrides the bag with HOST_SEND_MAX_TOTAL_BYTES — by name, never a loose digit", () => {
    expect(src).toMatch(/sendSurfaceMaxTotalBytes:\s*HOST_SEND_MAX_TOTAL_BYTES/);
  });

  it("exactly two declarations exist in the engine: the stdio door's null and the host door's constant", () => {
    const all = src.match(/sendSurfaceMaxTotalBytes:\s*[\w$]+/g) ?? [];
    expect(all.sort()).toEqual([
      "sendSurfaceMaxTotalBytes: HOST_SEND_MAX_TOTAL_BYTES",
      "sendSurfaceMaxTotalBytes: null",
    ]);
  });
});

describe("what that declaration means once SendService reads it", () => {
  it("a probed server lifts this install past the hosted constant", () => {
    // The announcement's BUDGET FOR RAW BYTES, not its face value — `SIZE` bounds the encoded
    // message and attachments are base64 on the way into it. See `attachmentBudgetFor`.
    expect(effectiveAttachmentCap(null, 25 * 1024 * 1024))
      .toBe(attachmentBudgetFor(25 * 1024 * 1024));
    expect(attachmentBudgetFor(25 * 1024 * 1024)).toBeGreaterThan(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
  });

  it("an UNPROBED server counts as the assumed provider SIZE — past 3 MB, not unbounded", () => {
    expect(effectiveAttachmentCap(null, null)).toBe(attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES));
    expect(effectiveAttachmentCap(null, null)).toBeGreaterThan(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
  });
});

describe("what the HOST DOOR's declared surface means once SendService reads it", () => {
  it("a declared surface does NOT lift an UNPROBED mailbox past the assumed provider SIZE", () => {
    // `min(surface, mailbox)` with an unknown mailbox once resolved to the SURFACE, so the host
    // door's 32 MB transport ceiling became every never-probed mailbox's limit. An unknown
    // mailbox counts as a provider-typical announcement, never as the transport's ceiling.
    expect(effectiveAttachmentCap(HOST_SEND_MAX_TOTAL_BYTES, null))
      .toBe(attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES));
    expect(attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES)).toBeLessThan(HOST_SEND_MAX_TOTAL_BYTES);
  });

  it("a PROBED server genuinely lifts it — bounded by the transport surface", () => {
    expect(effectiveAttachmentCap(HOST_SEND_MAX_TOTAL_BYTES, 70 * 1024 * 1024))
      .toBe(HOST_SEND_MAX_TOTAL_BYTES);
    expect(effectiveAttachmentCap(HOST_SEND_MAX_TOTAL_BYTES, 20 * 1024 * 1024))
      .toBe(attachmentBudgetFor(20 * 1024 * 1024));
  });
});
