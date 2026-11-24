import { expect, it, vi } from "vitest";
import { askScreenerRewrite } from "../src/screener-learning-rewrite.js";
import type { ClassifierPort } from "../src/classifier-port.js";

const evidence = [{ kind: "correction", topic: "webinar", suggested: "ohmail/News", previous: null, chosen: "ohmail/Screened" }];

it("asks for a complete compact note from generic choices and accepts free-form prose", async () => {
  const text = "Decline webinar invitations from vendors you already use.";
  const rewriteScreener = vi.fn<NonNullable<ClassifierPort["rewriteScreener"]>>().mockResolvedValue({ text });
  const beforeDispatch = vi.fn(async () => {});
  expect(await askScreenerRewrite(rewriteScreener, { language: "en", previous: "", choices: evidence }, beforeDispatch)).toBe(text);
  const call = rewriteScreener.mock.calls[0]![0];
  expect(call.input).toMatchObject({ language: "en", choices: evidence });
  expect(call.maxTokens).toBe(768);
  expect(call.system).toContain("If the new choices change no lesson, return the previous note exactly.");
  expect(call.system).not.toContain("e.g.");
  expect(beforeDispatch).toHaveBeenCalledTimes(1);
});

it.each([
  { text: "Allow sample@example.test." },
  { text: "Put Exampleco webinar invitations in News." },
  { text: "File notices from example.test in News." },
  { text: "File notices from https://localhost in News." },
  { text: "File your quarterly partner briefing in News." },
  { text: "a ".repeat(300) },
  { text: "", extra: "unrequested" },
])("refuses invalid or identifying provider output", async output => {
  const rewrite = vi.fn().mockResolvedValue(output);
  await expect(askScreenerRewrite(rewrite, { language: "en", previous: "", choices: evidence }, async () => {}, undefined,
    [{ senderName: "Exampleco", subject: "Your quarterly partner briefing" }]))
    .rejects.toThrow(/note/i);
});

it.each([
  ["en", "Keep receipts, e.g. shop invoices, in Receipts.", "Receipts"],
  ["en", "Keep personal mail, i.e. letters from a real person, in the Ohbox.", "News"],
  ["de", "Lege Belege, z.B. Quittungen, in Belege.", "Quittungen"],
  ["de", "Sammle Angebote u.a. in News, d.h. dort bleiben sie z.T. ungelesen.", "News"],
  ["en", "Keep shop receipts and file the newsletter in News.", "Shop"],
  ["en", "Put each newsletter in News.", "Newsletter"],
  ["en", "File support messages from the team in News.", "Support"],
] as const)("accepts ordinary words and abbreviations in %s", async (language, text, senderName) => {
  await expect(askScreenerRewrite(async () => ({ text }), { language, previous: "", choices: evidence },
    async () => {}, undefined, [{ senderName, subject: "" }])).resolves.toBe(text);
});

it.each(["Example Co", "Zentrix"])("still refuses the identifying name %s", async (senderName) => {
  await expect(askScreenerRewrite(async () => ({ text: `File notices from ${senderName}.` }),
    { language: "en", previous: "", choices: evidence }, async () => {}, undefined,
    [{ senderName, subject: "" }])).rejects.toThrow(/note/i);
});
