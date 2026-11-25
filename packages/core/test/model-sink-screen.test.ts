import { expect, it } from "vitest";
import { draftUserPayload } from "../src/draft-prompt.js";

// The content gate was removed by decision of 24 Nov 2026.
it("serializes authentication mail and related grounding in the ordinary draft shape", () => {
  const input = {
    incoming: { from: "sender@example.test", subject: "Your passphrase", snippet: "It is 481920, on the label." },
    context: {
      kbEntries: [{ title: "Password reset", content: "Ask when the new link will arrive." }],
      threadMessages: [{ from: "sender@example.test", snippet: "Your previous sign-in link expired." }],
    },
  };
  expect(draftUserPayload(input)).toEqual({
    ...input,
    incoming: { ...input.incoming, snippet: "It is [code], on the label." },
  });
});
