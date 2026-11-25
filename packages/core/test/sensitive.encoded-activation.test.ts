import { expect, it } from "vitest";
import { classifyUserPayload } from "../src/classify-prompt.js";

it.each([
  "NDgyOTEz",
  "%34%38%32%39%31%33",
  "&#52;&#56;&#50;&#57;&#49;&#51;",
])("redacts an encoded code before sending the screening preview (%s)", (snippet) => {
  const subject = "Your sign-in code";
  const input = { from: { name: null, address: "sender@example.test" }, subject, snippet, headersDigest: "" };
  const payload = classifyUserPayload(input);
  expect(payload).toMatchObject({ subject, snippet: "[code]" });
  expect(JSON.stringify(payload)).not.toContain(snippet);
  expect(input).toMatchObject({ subject, snippet });
});

it.each([
  ["https://example.test/login/638194", "[sign-in link]"],
  ["https://example.test/reset/rndmzqtplwvx", "[reset link]"],
  ["https://example.test/passwort-zuruecksetzen?ticket=fixture", "[reset link]"],
  ["https://example.test/#/reset?code=fixture", "[reset link]"],
  ["https://example.test/sign-in?token=fixture", "[sign-in link]"],
  ["https://example.test/sign-in#access_token=fixture/part", "[sign-in link]"],
  ["https://example.test/redirect?url=" + encodeURIComponent("https://example.test/login/638194"), "[sign-in link]"],
  ["https://example.test/articles/reset/password-guide", "https://example.test/articles/reset/password-guide"],
  ["https://example.test/unsubscribe?token=fixture", "https://example.test/unsubscribe?token=fixture"],
  ["https://example.test/redirect?url=https%3A%2F%2Fexample.test%2Farticles%2Fguide", "https://example.test/redirect?url=https%3A%2F%2Fexample.test%2Farticles%2Fguide"],
  ["https://example.test/reset?utm_source=news", "https://example.test/reset?utm_source=news"],
])("redacts only credential links in %s", (url, expected) => {
  const snippet = `Open ${url} for details.`;
  const payload = classifyUserPayload({ from: { name: null, address: "" }, subject: "Account information", snippet, headersDigest: "" });
  expect(payload.snippet).toBe(`Open ${expected} for details.`);
});

it("keeps only the wrapper host in a sign-in notice", () => {
  const destination = Buffer.from("https://example.test/articles/how-to-sign-in").toString("base64url");
  const snippet = "More information: https://example.test/redirect?url=" + encodeURIComponent(destination);
  const input = { from: { name: null, address: "" }, subject: "Sign in to your account", snippet, headersDigest: "" };
  expect(classifyUserPayload(input).snippet).toBe("More information: https://example.test/[link]");
});
