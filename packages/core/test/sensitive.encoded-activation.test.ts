import { expect, it } from "vitest";
import { classifyUserPayload } from "../src/classify-prompt.js";

it.each([
  "NDgyOTEz",
  "%34%38%32%39%31%33",
  "&#52;&#56;&#50;&#57;&#49;&#51;",
])("keeps encoded text as stored in the screening preview (%s)", (snippet) => {
  const subject = "Your sign-in code";
  expect(classifyUserPayload({ from: { name: null, address: "sender@example.test" }, subject, snippet, headersDigest: "" }))
    .toMatchObject({ subject, snippet });
});
