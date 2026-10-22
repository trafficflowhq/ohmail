import { describe, it, expect } from "vitest";
import { normalizeMime, invitationWithoutEvent } from "../src/mime.js";
import { INVITE_SHAPES } from "./fixtures/invite-shapes.js";

/**
 * The invitation fixtures are what ingest really stores: every UI test that serves a shape's
 * `parts` serves the rows `normalizeMime` writes for its raw message, nameless parts and inline
 * flags included. A fixture that drifts from ingest fails here, not in a UI test that trusted it.
 */
describe("invite shapes: the parts ingest stores", () => {
  for (const shape of INVITE_SHAPES) {
    it(shape.name, async () => {
      const msg = await normalizeMime(shape.eml);
      expect(msg.attachments.map((a) => ({
        filename: a.filename, contentType: a.contentType, inline: a.inline, contentId: a.contentId, sizeBytes: a.sizeBytes,
      }))).toEqual(shape.parts.map((p) => ({
        filename: p.filename, contentType: p.contentType, inline: p.inline, contentId: p.contentId, sizeBytes: p.bytes.length,
      })));
      expect(invitationWithoutEvent({ headers: msg.headers, attachments: msg.attachments } as never)).toBe(shape.name === "tnef");
    });
  }
});
