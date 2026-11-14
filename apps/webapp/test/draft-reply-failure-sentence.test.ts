/**
 * THE DRAFTED-REPLY BUTTON'S FAILURE SENTENCE (moved from `unsaved-changes.test.tsx`, whose strip it never reached).
 *
 * `GET /drafts/:id` once answered `500 internal error` to an id it could not parse, and the drafted-reply button
 * rendered the server's own `"internal error"`. A surface has to say something usable when the server does not.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../app/api-client";

describe("the drafted-reply button's failure sentence", () => {
  /**
   * `messageFor` is the whole decision and it is pure, so it is tested directly rather than through
   * the hook — the alternative is standing up an engine, a session and a paid route to observe one
   * string.
   */
  it("passes a server refusal through verbatim, and never quotes an unhandled fault", async () => {
    const { messageFor } = await import("@ohmail/app-logic/writing/draft-reply");
    const FALLBACK = "That did not work.";
    const OPAQUE = "opaque sentence";

    // The refusals this path was built around: each already carries a true, actionable sentence.
    for (const [status, code, msg] of [
      [402, "payment_required", "no AI credits remain on this account"],
      [422, "unprocessable", "cannot AI-draft a sensitive message"],
      [503, "unavailable", "this deployment has no AI drafter connected"],
    ] as const) {
      expect(messageFor(new ApiError(status, code, msg), FALLBACK, OPAQUE)).toBe(msg);
    }

    // The unhandled fault — the shape `GET /drafts/:id` answered for a malformed id. Note the 503
    // above is ALSO a 5xx and is NOT swallowed: the discriminator is the code, not the status, and
    // a `status >= 500` rule would have eaten the most useful sentence on this path.
    expect(messageFor(new ApiError(500, "internal", "internal error"), FALLBACK, OPAQUE)).toBe(OPAQUE);
    // A blank message is the same failure with fewer characters.
    expect(messageFor(new ApiError(500, "some_code", "   "), FALLBACK, OPAQUE)).toBe(OPAQUE);
    // Something that is not an ApiError at all is not a refusal and gets the caller's fallback.
    expect(messageFor(new Error("boom"), FALLBACK, OPAQUE)).toBe(FALLBACK);
  });

});
