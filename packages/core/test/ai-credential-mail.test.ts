import { expect, it } from "vitest";
import { redactAiMail, redactAiPayload } from "../src/ai-credential-redaction.js";
import { classifyUserPayload, prepareScreeningQuestion } from "../src/classify-prompt.js";
import { draftUserPayload, NO_LETTER } from "../src/draft-prompt.js";
import { planChange, snippetOfText } from "../src/pipeline.js";

import { FakeRepo, FakeRouting } from "./fakes.js";

const from = { name: null, address: "" };
const classify = (subject: string, snippet: string, name: string | null = null) =>
  classifyUserPayload({ from: { ...from, name }, subject, snippet, headersDigest: "" });

const steam = ["F", "7", "K", "2", "Q"].join("");
const temporary = ["Xk", "9#mP", "2q!"].join("");
const vorlaeufig = ["Xk", "9mP", "2qa"].join("");
const backup = [["8f", "3k-2m", "9q"].join(""), ["7d", "1p-4x", "6z"].join("")];

it.each([
  ["Amazon password assistance", "To authenticate, please use the following One Time Password (OTP): 482913 Don't share this OTP", ["482913"]],
  ["Amazon password assistance", "To authenticate, please use the following One Time Password (OTP): 482913 Don't share this OTP with anyone.", ["482913"]],
  ["Your Amazon verification code", "To authenticate, please use the following One Time Password (OTP):\n482913\nDon't share this OTP with anyone.", ["482913"]],
  ["Your verification code", "482913\nUse this to verify your email.", ["482913"]],
  ["Ihr Anmeldecode", "Bitte geben Sie folgenden Code ein: 482913", ["482913"]],
  ["Your login code", "Enter this code: 482913", ["482913"]],
  ["Sign in to Acme", "Enter this code to finish signing in:\n\n482913", ["482913"]],
  ["Slack confirmation code: 482-913", "Your confirmation code is below — enter it in your open browser window and we'll help you get signed in.\n482-913\n...", ["482-913"]],
  ["Sign in to Acme", "To finish signing in, use: 482913", ["482913"]],
  ["Verify", "Your verification code is 4 8 2 9 1 3", ["4 8 2 9 1 3"]],
  ["Your recovery codes", "Save these recovery codes: abcd-1234 efgh-5678", ["abcd-1234", "efgh-5678"]],
  ["Verify your email address", "Use this code to verify your email: 638194", ["638194"]],
  ["Your one-time password", "Your one-time password (OTP) is 638194", ["638194"]],
  ["Your sign-in code", "Enter the code below to sign in.\n638194\nThis code expires in 10 minutes.", ["638194"]],
  ["Apple ID Verification Code", "Your Apple ID Code is: 638194.", ["638194"]],
  ["Your verification code", "Your code to verify your email address: 638194", ["638194"]],
  ["Dein Bestätigungscode", "Verwende 638194 als Bestätigungscode.", ["638194"]],
  ["Verify your email", "Please enter this code: 638194", ["638194"]],
  ["", "Your one-time password (OTP) is 482913", ["482913"]],
  ["", "Verification code (valid 10 min): 482913", ["482913"]],
  ["", "Ihre mTAN für die Überweisung lautet 482913", ["482913"]],
  ["", "Your Apple Account Code is: 482913.", ["482913"]],
  ["", `Here is the Steam Guard code you need to login to account bob: ${steam}`, [steam]],
  ["", `Your temporary password is: ${temporary}`, [temporary]],
  ["", `Ihr vorläufiges Passwort lautet: ${vorlaeufig}`, [vorlaeufig]],
  ["", `Backup codes: ${backup.join(" ")}`, backup],
  ["Sign in to track", "4829135 is your order number.", ["4829135"]],
] as const)("redacts credentials in %s / %s", async (subject, body, values) => {
  for (const snippet of new Set([body, snippetOfText(body)])) {
    const source = { subject, snippet };
    const expected = {
      subject: values.reduce<string>((result, value) => result.replaceAll(value, "[code]"), subject),
      snippet: values.reduce<string>((result, value) => result.replaceAll(value, "[code]"), snippet),
    };
    expect(redactAiMail(source)).toEqual(expected);
    expect(classify(subject, snippet)).toMatchObject(expected);
    expect(source).toEqual({ subject, snippet });
  }
  const redact = (source: string) => values.reduce<string>((result, value) => result.replaceAll(value, "[code]"), source);
  await expectMailPaths({ subject, body, cleanSubject: redact(subject), cleanBody: redact(body) });
});

const token = ["abcd", "1234efgh", "5678"].join("");
const deviseToken = ["Zx", "9kLmQ", "2pR", "7vT", "1"].join("");
const wordpressKey = ["AbCdEf", "123456"].join("");

it.each([
  ["[Site] Password Reset", `https://example.com/wp-login.php?action=rp&key=${wordpressKey}&login=anna`],
  ["[Site] Password Reset", `https://site.example/wp-login.php?action=rp&key=${token}&login=bob`],
  ["Reset password instructions", `https://example.com/users/password/edit?reset_password_token=${token}`],
  ["Reset password instructions", `https://example.test/users/password/edit?reset_password_token=${deviseToken}`],
  ["Reset password instructions", `https://app.example.com/users/password/edit?reset_password_token=${token}`],
  ["Reset password instructions", "https://example.com/users/password/edit?reset_password_token=" + ["xYz", "123AbC", "456"].join("")],
  ["Reset password instructions", `https://example.test/password_resets/${token}/edit`],
  ["Reset password instructions", `https://example.test/reset-password?k=${token}`],
  ["Reset your password", `https://example.com/reset-password?k=${token}`],
  ["Reset your password", `https://example.test/password/new?token=${token}`],
  ["Reset your password", `https://example.test/new-password?token=${token}`],
  ["Reset your password", `https://example.test/users/password/edit?token=${token}`],
  ["Reset your password", `https://example.test/forgot-password/${token}`],
  ["Reset your password", `https://example.test/set-password?key=${token}`],
  ["Reset your password", `https://example.test/account/change-password/${token}`],
  ["Unlock your account", `https://example.test/users/unlock?unlock_token=${token}`],
  ["Sign in to Notion", `https://notion.so/loginwithemail?token=${token}`],
  ["Sign in to Figma", `https://figma.com/email_login?token=${token}`],
  ["Sign in to Medium", `https://medium.com/m/callback/email?token=${token}&operation=login`],
  ["Secure sign in link for Blog", `https://blog.example.com/members/?token=${token}&action=signin`],
  ["Sign in to Example", `https://www.example.test/loginwithemail?token=${token}`],
  ["Sign in to Example", `https://www.example.test/m/callback/email?token=${token}&operation=login`],
  ["Sign in to Example", `https://www.example.test/emaillogin?t=${token}`],
  ["Your sign-in link", `https://example.test/sign-in-link?token=${token}`],
  ["Your sign-in link", `https://example.test/email-login?token=${token}`],
  ["Your sign-in link", `https://example.test/l/${token}`],
  ["Accept your invitation", `https://example.test/invitations/accept?invitation_token=${token}`],
  ["Accept the invitation", `https://example.test/invitations/accept?invitation_token=${token}`],
  ["Neues Passwort", `https://beispiel.de/konto/neues-passwort?t=${token}`],
  ["Passwort zurücksetzen", `https://beispiel.de/konto/neues-passwort?t=${token}`],
  ["Konto bestätigen", `https://example.test/click?url=${encodeURIComponent(`https://example.test/l/${token}`)}#destination`],
])("keeps only the host of a credential link in %s / %s", async (subject, link) => {
  const expected = `Open ${new URL(link).origin}/[link].`;
  const snippet = `Open ${link}.`;
  expect(redactAiMail({ subject, snippet }).snippet).toBe(expected);
  expect(classify(subject, snippet).snippet).toBe(expected);
  await expectMailPaths({ subject, body: snippet, cleanBody: expected });
});

it.each([
  [`https://example.test/continue?reset_password_token=${token}`, "[reset link]"],
  [`https://example.test/continue?password_reset_token=${token}`, "[reset link]"],
  [`https://example.test/invitations/accept?invitation_token=${token}`, "[sign-in link]"],
  [`https://example.test/forgot-password/${token}/edit`, "[reset link]"],
  [`https://example.test/wp-login.php/${token}`, "[sign-in link]"],
  ["https://example.test/login/638194/reset", "[reset link]"],
])("uses the precise tier for an auth link in otherwise ordinary mail (%s)", (url, expected) => {
  expect(classify("Account information", url).snippet).toBe(expected);
});

it("keeps the precise redactor's explicitly supplied nearby context", () => {
  expect(redactAiPayload("482913", "Your code")).toBe("[code]");
});

it("uses the sender display name locally and applies the broad tier to every request field", () => {
  const input = {
    from: { ...from, name: "VERIFICATION" },
    subject: "Message 9876",
    snippet: "638 194 is the number. https://example.test/anything?q=private#fragment",
    headersDigest: "",
    ohboxBar: "Keep the note ABCD-" + "1234",
    learnedWords: "The prior number was 123456789012",
  };
  expect(classifyUserPayload(input)).toMatchObject({
    subject: "Message [code]",
    snippet: "[code] is the number. https://example.test/[link]",
    ohboxBar: input.ohboxBar,
    learnedWords: input.learnedWords,
  });
  expect(classifyUserPayload(input)).not.toHaveProperty("name");
});

it("leaves an ordinary newsletter byte-identical", () => {
  const subject = "November newsletter • issue 4281";
  const snippet = [
    "Order 4429117, price CHF 1290.00, flight LH" + "1234, date 25.11.2026.",
    "Read https://example.test/articles/reset/password-guide.",
    "Track https://example.test/tracking/4429117?source=news.",
    "Unsubscribe https://example.test/unsubscribe?token=stay.",
  ].join("\n");
  expect(classify(subject, snippet)).toMatchObject({ subject, snippet });
});

it("uses the broad tier for an order mail that asks you to sign in", () => {
  const subject = "Sign in to see your order";
  const snippet = "Order 4429117. https://example.test/orders/4429117";
  expect(classify(subject, snippet)).toMatchObject({ subject, snippet: "Order [code]. https://example.test/[link]" });
});

it.each(["One-time passwords", "Sign-ins", "Passwort-Wiederherstellungen", "Einmalpasswörter"])(
  "recognizes the plural cue %s",
  subject => {
    expect(classify(subject, "Reference 638194 for later.").snippet).toBe("Reference [code] for later.");
  },
);

it("redacts groups as a single value and observes the token length bounds", () => {
  const subject = "Wiederherstellungscodes";
  const spaced = "ab" + "12 cd" + "34";
  const snippet = `ABCD 1234, ${spaced}, 638 194-ABCD, 123456789012, 1234567890123, 123`;
  expect(classify(subject, snippet).snippet).toBe("[code], [code], [code], [code], 1234567890123, 123");
});

it.each(["482", "abc"])("redacts a partial code at the stored preview limit (%s)", fragment => {
  const tail = " Use this code to sign in: " + fragment;
  const preview = snippetOfText("x".repeat(200 - tail.length) + tail + "913");
  expect(preview).toHaveLength(200);
  expect(classify("Sign in", preview).snippet).toBe(preview.slice(0, -3) + "[code]");
  expect(classify("Sign in", "Call extension 482").snippet).toBe("Call extension 482");
  const body = "x".repeat(200 - tail.length) + tail + "913";
  expect(draftFromText(`Forwarding this: Sign in\n${body}`)).toBe(`Forwarding this: Sign in\n${body.slice(0, -6)}[code]`);
});

it("redacts pasted instructions before writing a draft from text", () => {
  const own = { replying: false, text: "Tell them: use this code to verify your email: 638194" };
  const payload = draftUserPayload({ incoming: NO_LETTER, context: { kbEntries: [], threadMessages: [] }, own });
  expect(payload.own?.text).toBe("Tell them: use this code to verify your email: [code]");
  expect(own.text).toContain("638194");
});

it("applies a quoted mail cue only to the message carrying it", () => {
  const url = `https://site.example/wp-login.php?action=rp&key=${token}&login=bob`;
  const input = {
    incoming: { subject: "Following up 482913", from: "", snippet: "ABCD-" + "1234" },
    context: {
      kbEntries: [{ title: "Case 4429117", content: "Details https://example.test/docs/private" }],
      threadMessages: [{ from: "", subject: "[Site] Password Reset", snippet: url }],
    },
    own: { replying: true, text: "Mention 638194", subject: "Reference 4382" },
  };
  const original = structuredClone(input);
  expect(draftUserPayload(input)).toEqual({
    incoming: input.incoming,
    context: {
      kbEntries: input.context.kbEntries,
      threadMessages: [{ from: "", snippet: "https://site.example/[link]" }],
    },
    own: { text: input.own.text, subject: input.own.subject },
  });
  expect(input).toEqual(original);
});

it.each([
  ["ohboxBar", "Security codes and sign-in mails always come to me."],
  ["ohboxBar", "Bestätigungscodes und Anmeldungen bitte immer zu mir."],
  ["ohboxBar", "People I know. Bank sign-in and verification mails too."],
  ["learnedWords", "Mail about login alerts goes to me"],
  ["learnedWords", "Verification codes go to Ohbox"],
  ["senderFacts", "Previous sign-in notifications went to Ohbox."],
])("keeps an order intact with an account cue in %s (%s)", (field, words) => {
  const mail = {
    subject: "Your order 48291735 has shipped",
    snippet: "Order 48291735 shipped. Track: https://shop.example.com/orders/48291735/track?c=abc",
  };
  expect(classifyUserPayload({ from, headersDigest: "", ...mail, [field]: words }))
    .toMatchObject({ ...mail, [field]: words });
});

it("keeps flight, date and tracking details with an account correction about sign-in", () => {
  const mail = {
    subject: "Your order 4429117 has shipped",
    snippet: "Flight LX" + "1234 on 25.11.2026. Track: https://track.example.test/p/4429117?ref=mail",
  };
  const recentCorrections = [{ topic: "Sign-in alerts", chosen: "Ohbox", suggested: "News" }];
  expect(classifyUserPayload({ from, headersDigest: "", ...mail, recentCorrections }))
    .toMatchObject({ ...mail, recentCorrections });
});

it("keeps order details in a draft with password help and sign-in instructions", () => {
  const incoming = { from: "", subject: "Invoice 48291735 for order 482917", snippet: "Where is order 48291735? It totals CHF 1290.00." };
  const context = { threadMessages: [], kbEntries: [
    { title: "Password help", content: "Forgot your password? Customers can sign in and reset it at https://help.example.com/account/help." },
    { title: "Shipping", content: "See https://shop.example.com/orders/48291735/track." },
  ] };
  const own = { replying: true, text: "Explain where to sign in. Mention order 48291735." };
  expect(draftUserPayload({ incoming, context, own })).toEqual({ incoming, context, own: { text: own.text } });
});

it.each([
  ["Your order 48291735 is out for delivery", "Questions? Log in to your account to see the status."],
  ["Your order 48291735 has shipped", "Log in to your account to see your order."],
  ["Your order 48291735 has shipped", "We will never ask for your password or verification code by email."],
  ["Order 48291735 shipped", "Forgot your password? Visit our help center."],
  ["Ihre Bestellung 48291735", "Jetzt anmelden"],
  ["Newsletter 4281", "Home | Sign in | Support"],
  ["Newsletter 4281", "Manage subscription: sign in at https://shop.example.test/help/login"],
  ["Newsletter 4281", "We support " + "2" + "FA for all accounts."],
  ["HN digest", "Show HN: A login page in 50 lines https://news.ycombinator.com/item?id=42819374"],
  ["Conference slides", "Two-factor authentication done right https://conf.example.org/slides/2026"],
  ["Password managers in 2026", "Read https://shop.example.test/articles/password-managers."],
  ["Age verification required for order 48291735", ""],
  ["TAN-Verfahren ändert sich am 01.12.2026", ""],
  ["Account recovery webinar on 03.12.2026", ""],
])("keeps ordinary mail byte-identical with incidental wording in %s / %s", (subject, footer) => {
  const snippet = "Order 48291735, CHF 1290.00, flight LX" + "1234 on 25.11.2026. https://shop.example.test/orders/48291735\n" + footer;
  for (const text of new Set([snippet, snippetOfText(snippet)])) {
    expect(classify(subject, text)).toMatchObject({ subject, snippet: text });
  }
});

const germanCode = ["X", "7", "K", "2-9QPM"].join("");
const activationCode = ["7", "F", "3", "K", "9QX", "2"].join("");
const reportedCodes: ReadonlyArray<readonly [string, string, string, string?]> = [
  ["Kennwort für Microsoft-Konto zurücksetzen", "Verwenden Sie den folgenden Code, um das Kennwort zurückzusetzen: 4829173", "4829173"],
  ["Bestätige deine E-Mail-Adresse", "Dein Code für die Bestätigung: 482917", "482917"],
  ["Willkommen bei Acme", `Ihr Aktivierungscode lautet: ${germanCode}`, germanCode],
  ["Ihr Freischaltcode", "Ihr Freischaltcode lautet: 4829-1735", "4829-1735"],
  ["", "Ihr Authentifizierungscode: 482917", "482917"],
  ["", "Ihr Registrierungscode: 482917", "482917"],
  ["Freigabe Ihrer Zahlung", "Ihr Freigabecode: 4829 1735", "4829 1735"],
  ["Ihr photoTAN-Aktivierungsbrief", `Aktivierungscode: ${activationCode}`, activationCode],
  ["SwissID: Bestätigung Ihrer E-Mail-Adresse", "Ihr SwissID Code: 482917", "482917"],
  ...["Login", "Anmelde", "Verifizierungs"].map(word => ["Willkommen", `Ihr ${word}-Code: 482917`, "482917"] as const),
  ...["photo", "chip", "push", "sms", "m"].map(word => [`Ihre ${word}TAN`, "Wert: 482917", "482917"] as const),
  ["[GitHub] Your launch code", "Here is your GitHub launch code: 48291735 Continue signing up for GitHub by entering the code above.", "48291735"],
  ["482917 is your Acme code", "Thanks for using Acme.", "482917"],
  ["", "482917 is your Acme verification code. Enter it in the app.", "482917"],
  ["", "482917 is your Acme login code. Enter it in the app.", "482917"],
  ["", "482917 is your Acme sign-in code. Enter it in the app.", "482917"],
  ["Your Acme code", "482917\nEnter it in the app to continue.", "482917"],
  ["Dein N" + "26-Code", "Dein N" + "26 Code lautet 482917.", "482917", "Dein [code]"],
  ["Dein TWINT-Code: 4821", "Thank you.", "4821"],
  ["Dein Code für Acme", "Gib diesen Code in der App ein: 482917", "482917"],
  ["Steam Guard code", "Login Code\nRKQTV\nIf this wasn't you, change your password.", "RKQTV"],
  ["Your sign-in code", "Your code is: kpqzrt", "kpqzrt"],
  ["Your sign-in code", "Your code is kpqzrt", "kpqzrt"],
  ["Your sign-in code", "Your code is: abcdefghij", "abcdefghij"],
  ["Your sign-in code", "Use the code below.\nkpqzrt\nIt expires soon.", "kpqzrt"],
  ["Your sign-in code", "kpqzrt\nEnter it in the app.", "kpqzrt"],
];
it.each(reportedCodes)("redacts the reported credential value in %s / %s", (subject, body, value, outgoingSubject) => {
  for (const snippet of new Set([body, snippetOfText(body)])) {
    const expected = { subject: outgoingSubject ?? subject.replace(value, "[code]"), snippet: snippet.replace(value, "[code]") };
    expect(classify(subject, snippet)).toMatchObject(expected);
    const draft = draftUserPayload({ incoming: { from: "", subject, snippet }, context: { kbEntries: [], threadMessages: [] } });
    expect(draft.incoming).toMatchObject(expected);
  }
});

it("redacts a lowercase code on its own line beside a credential link", () => {
  const snippet = "Open https://example.test/verify/secret\n\nkpqzrt\nEnter it in the app.";
  expect(classify("Your sign-in code", snippet).snippet)
    .toBe("Open https://example.test/[link]\n\n[code]\nEnter it in the app.");
});

it.each([
  ["Kennwort zurücksetzen", "Kennwort zurücksetzen:", `https://bank.example.de/k/${token}`],
  ["Neues Kennwort anfordern", "", `https://shop.example.de/kennwort/neu?h=${token}`],
  ["Neue Kennwörter", "", `https://shop.example.de/credentials/${token}`],
  ["Bestätige deine E-Mail-Adresse", "Hallo Anna, bitte bestätige deine E-Mail-Adresse:", `https://acme.example.de/e/${token}`],
  ["", "Bitte bestätige Ihre E-Mail:", `https://acme.example.de/e/${token}`],
  ["", "Bestätigung deiner E-Mail-Adresse:", `https://acme.example.de/e/${token}`],
  ["", "Bestätigung Ihrer E-Mail-Adresse:", `https://acme.example.de/e/${token}`],
  ["Anna has invited you to work with them in Slack", "Join now:", `https://join.slack.com/t/acmeteam/shared_invite/${token}`],
  ["Anna invited you to Acme Workspace", "", `https://www.notion.so/invite/${token}`],
  ["Anna invited you to a Figma team", "Accept invite:", `https://www.figma.com/team_invite/redeem/${token}`],
  ["Anna invited you to join Jira", "", `https://id.atlassian.com/invite/p/jira-software?id=${token}`],
  ["Einladung zu Acme", "Einladung annehmen:", `https://acme.example.de/join/${token}`],
  ["", "Accept the invite:", `https://acme.example.de/redeem/${token}`],
  ["", "Anna lädt dich ein:", `https://acme.example.de/shared_invite/${token}`],
  ["", "Anna lädt Sie ein:", `https://acme.example.de/team_invite/${token}`],
])("redacts the reported credential URL in %s / %s", (subject, label, url) => {
  const snippet = [label, url].filter(Boolean).join(" ");
  const expected = snippet.replace(url, new URL(url).origin + "/[link]");
  expect(classify(subject, snippet).snippet).toBe(expected);
  expect(draftUserPayload({ incoming: { from: "", subject, snippet }, context: { kbEntries: [], threadMessages: [] } }).incoming?.snippet)
    .toBe(expected);
});

it.each(["invite", "join", "shared_invite", "team_invite", "redeem", "kennwort"])(
  "redacts a token on the precise %s path",
  path => {
    const snippet = `Read https://example.test/${path}/${token} and https://example.test/articles/${path}.`;
    const replacement = path === "kennwort" ? "[reset link]" : "[sign-in link]";
    expect(classify("Account information", snippet).snippet)
      .toBe(`Read ${replacement} and https://example.test/articles/${path}.`);
  },
);

function draftFromText(text: string, replying = false): string {
  return draftUserPayload({
    incoming: NO_LETTER, context: { kbEntries: [], threadMessages: [] }, own: { replying, text },
  }).own!.text;
}

interface CredentialCase {
  subject: string;
  body: string;
  cleanBody?: string;
  cleanSubject?: string;
  name?: string;
  draftPrefix?: string;
  cleanDraftBody?: string;
  keepSnippetLines?: boolean;
}

async function expectMailPaths({ subject, body, cleanSubject = subject, cleanBody = body, name,
  draftPrefix = "Forwarding this: ", cleanDraftBody = cleanBody, keepSnippetLines = false }: CredentialCase) {
  const snippet = keepSnippetLines ? body : snippetOfText(body);
  const expected = { subject: cleanSubject, snippet: keepSnippetLines ? cleanBody : snippetOfText(cleanBody) };
  const screening = prepareScreeningQuestion({ fromAddress: "", fromName: name, subject, snippet });
  expect(screening).not.toBeNull();
  const letter = { from: "", fromName: name, subject, snippet };
  const draft = draftUserPayload({ incoming: letter, context: { kbEntries: [], threadMessages: [letter] } });
  expect.soft(classify(subject, snippet, name), "stored classify").toMatchObject(expected);
  expect.soft(classifyUserPayload(screening!), "Screener").toMatchObject(expected);
  expect.soft(draft.incoming, "reply draft").toMatchObject(expected);
  expect.soft(draft.context.threadMessages, "draft thread").toEqual([{ from: "", snippet: expected.snippet }]);
  for (const replying of [false, true]) {
    expect.soft(draftFromText(`${draftPrefix}${subject}\n${body}`, replying), "draft from text")
      .toBe(`${draftPrefix}${cleanSubject}\n${cleanDraftBody}`);
  }

  const repo = new FakeRepo();
  repo.senders.add("fixture@example.test");
  const inputs: unknown[] = [];
  const raw = Buffer.from([
    "Message-ID: <fixture@example.test>",
    `From: ${name ?? "Fixture"} <fixture@example.test>`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n"));
  await planChange({ type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw }, {
    repo, routing: new FakeRouting(), accountId: "account", mailboxId: "mailbox",
    classifier: {
      async classify(input) {
        inputs.push(classifyUserPayload(input));
        return { destination: "ohmail/News", confidence: 0.9, rationale: "", spam: false };
      },
    },
  });
  expect.soft(inputs, "ingest").toEqual([expect.objectContaining({ ...expected, snippet: snippetOfText(cleanBody) })]);
}

it.each([
  ["Your Steam account: Access from new web or mobile device", "Dear bob,\nHere is the Steam Guard code you need to login to account bob:\n\nBCDFG\n\nThis email was generated because of a login attempt.", "BCDFG"],
  ["Ihr Steam-Account: Zugriff von einem neuen Gerät", "Hallo bob,\nHier ist der Steam-Guard-Code, den Sie zum Anmelden bei bob benötigen:\n\nBCDFG\n\nDiese E-Mail wurde wegen eines Anmeldeversuchs versendet.", "BCDFG"],
  ["Steam Guard code", "Login Code\nRKQTV\nIf this wasn't you, change your password.", "RKQTV"],
  ["Steam Guard code", "Login Code\nRKQTV\nThis code was requested from Zurich.", "RKQTV"],
  ["Steam Guard code", "Your Steam Guard code BCDFG Thanks", "BCDFG"],
  ["Steam Guard code", "Your Steam Guard code abcdefghij Thanks", "abcdefghij"],
  ["Your sign-in code", "Use the code below.\nkpqzrt\nThanks for using Acme today.", "kpqzrt"],
  ["Your sign-in code", "Your code is: kpqzrt\nThe app will ask you for it.", "kpqzrt"],
  ["Your sign-in code", "Your code is kpqzrt\nThe app will ask you for it.", "kpqzrt"],
  ["Your sign-in code", "Your code is: abcdefghij\nKeep this value private.", "abcdefghij"],
  ["Your sign-in code", "Use the code below.\nkpqzrt\nIt expires soon.", "kpqzrt"],
  ["Your sign-in code", "kpqzrt\nEnter it in the app.", "kpqzrt"],
  ["Your sign-in code", "Open https://example.test/verify/secret\n\nkpqzrt\nEnter it in the app.", "kpqzrt"],
  ...["QWRTY and it expires", "qwrty and it expires", "QWRTYZ and it expires", "QWRTY, it expires"].map(
    phrase => ["Your verification code", `Your verification code is ${phrase} in 10 minutes.`, phrase.split(/[ ,]/)[0]!],
  ),
  ["Hello", "Your verification code is QWRTY and it expires in 10 minutes.", "QWRTY"],
  ["Hallo Anna", "Ihr Prüfcode: 482917", "482917"],
  ["Hallo Anna", "Ihr Prüfcode lautet 482917", "482917"],
  ["Hallo Anna", "Ihr Prüfcode: 482917352761", "482917352761"],
  ["Hallo Anna", "Ihr Prüfcode lautet QWRTY Geben Sie ihn ein.", "QWRTY"],
  ...["Prüfcode", "Entsperrcode", "Einmalcode", "Einmal-Code", "Kopplungscode", "Gerätecode", "Bankingcode",
    "Zugangscode", "Bestätigungscode", "Sicherheitscode", "Verifizierungscode", "Anmeldecode", "Freischaltcode",
    "Aktivierungscode", "Authentifizierungscode", "Registrierungscode", "Freigabecode"].map(
    label => ["Hallo Anna", `Der ${label} ist 482917.`, "482917"],
  ),
  ["Hallo Anna", "Ihr Kopplungscode: KX7Q-RM2Z", "KX7Q-RM2Z"],
  ["Ihr Prüfcode", "Ihr Prüfcode: 482917. Er ist 10 Minuten gültig.", "482917"],
  ["Konto entsperren", "Dein Entsperrcode: 4829-1735", "4829-1735"],
  ["Konto entsperren", "Dein Entsperrcode: 482917", "482917"],
  ["Hallo Anna", "Zum Anmelden. Ihr Prüfcode lautet QWRTY Geben Sie ihn ein.", "QWRTY"],
  ["Hallo Anna", "Verification is required. Ihr Prüfcode: 482917", "482917"],
  ["Hallo Anna", "Temporary password issued for you. Ihr Prüfcode: 482917", "482917"],
  ["Hallo Anna", "Ihre Zugangscodes: 482917", "482917"],
  ...["app", "photo", "push", "chip", "sms", "m", "Photo", "Secure", "Chip", "Smart", "BestSign", "appSMS"]
    .map(word => ["Überweisung", `Ihre ${word}TAN: 482917`, "482917"]),
  ["Zahlung", "Ihre SecureTAN 482917 für die Überweisung an Max.", "482917"],
  ["Zahlung", "Ihre TAN:\n482917", "482917"],
  ["Account information", "Your PIN:\n4821", "4821"],
  ...["TAN", "PIN", "OTP"].flatMap(word => [
    ["Account information", `Your ${word}: 482917`, "482917"],
    ["Account information", `Your ${word} 482917`, "482917"],
    ["Account information", `Your ${word} is kpqzrt and it expires.`, "kpqzrt"],
  ]),
  ["Ihre neue Anmeldung", "Wert: 482917", "482917"],
  ["Anmeldeversuch", "Wert: 482917", "482917"],
  ["Anmeldung bei Acme", "Wert: 482917", "482917"],
  ["Anmeldung bestätigen", "Wert: 482917", "482917"],
  ["Code zur Anmeldung", "Wert: 482917", "482917"],
  ["Link für Ihre Anmeldung", "Wert: 482917", "482917"],
  ["Anmeldung: Code", "Wert: 482917", "482917"],
])("uses the credential rule on every path for %s / %s", async (subject, body, value) => {
  const cleanBody = body!.replace(value!, "[code]").replace("/verify/secret", "/[link]");
  await expectMailPaths({ subject: subject!, body: body!, cleanBody });
});

it.each([
  ["Du wurdest zu Acme eingeladen", "Anna lädt dich ein. Jetzt beitreten:", `https://acme.example.de/einladung/${token}`],
  ["Einladung", "Einladung annehmen:", `https://acme.example.de/invites/${token}`],
  ["Anna lädt Sie zu Acme ein", "Einladung annehmen:", `https://acme.example.de/x/${token}`],
  ["You have been invited to join a team", "Join Microsoft Teams:", `https://teams.example.com/l/invite?token=${token}`],
  ["you have been invited", "Accept:", `https://acme.example.de/w/${token}`],
  ["You've been invited", "Accept:", `https://acme.example.de/w/${token}`],
  ["You've been invited to join Acme", "Accept:", `https://acme.example.de/w/${token}`],
  ["You’ve been invited to join Acme", "Accept:", `https://acme.example.de/w/${token}`],
  ["You're invited to join Acme", "Open:", `https://acme.example.de/x/${token}`],
  ["Account information", "Anmeldung bestätigen:", `https://acme.example.de/x/${token}`],
  ...["invite", "invites", "invitation", "einladung", "join"].map(path => [
    "A message from Acme", "Anna lädt dich ins Team ein:", `https://acme.example.de/${path}/${token}`,
  ]),
])("recognizes invitation wording or a nearby invitation route for %s / %s", async (subject, label, url) => {
  await expectMailPaths({ subject: subject!, body: `${label} ${url}`, cleanBody: `${label} ${new URL(url!).origin}/[link]` });
});

const ordinaryNotes = "Notes from our meeting on 25.11.2026: budget 48'000, order 4471, see https://docs.example.com/d/"
  + ["1a", "2B", "3c", "4D", "5e", "6F", "7g", "8H", "9i", "0J"].join("") + "/edit";
it.each(["Amy Tan", "Kevin Tan", "Tan Wei Ming", "Michael Tans", "Anna Login", "Login Tours AG", "Otp Logistics",
  "Tan", "Pin", "Amy Lee"])("keeps ordinary mail from %s intact", async name => {
  await expectMailPaths({ name, subject: "Notes from Tuesday", body: ordinaryNotes });
});

it.each(["VERIFICATION", "Acme Verification", "Security Code", "Verification Desk", "Sign-in Service",
  "Two-Factor Service", "Acme OTP", "Acme TAN", "TAN", "PIN", "OTP"])("recognizes %s as sender credential evidence", async name => {
  const body = "482917 - use it within 10 minutes.";
  await expectMailPaths({ name, subject: "Message", body, cleanBody: "[code] - use it within 10 minutes.", cleanDraftBody: body });
});

it.each(["Subject", "Betreff", "Fwd", "Fw", "WG", "Forwarding this"])("recognizes a pasted %s header after a lead-in", async header => {
  await expectMailPaths({
    subject: "Sign in to Notion", body: `Open https://notion.so/loginwithemail?token=${token}`,
    cleanBody: "Open https://notion.so/[link]", draftPrefix: `Please reply politely to this:\r\n\r\n${header}: `,
  });
});

it("recognizes a pasted subject after an inline forwarding phrase", async () => {
  await expectMailPaths({
    subject: "Reset your password", body: `Open https://example.test/password/new?token=${token}`,
    cleanBody: "Open https://example.test/[link]", draftPrefix: "Can you answer this one? Forwarding this: ",
  });
});

it("checks later pasted subjects when an earlier one has no credential cue", async () => {
  await expectMailPaths({
    subject: "Your code", body: "Use 482913 to continue.", cleanBody: "Use [code] to continue.",
    draftPrefix: "Subject: Ordinary notes\n\nFwd: ",
  });
});

it.each(["TAN", "PIN", "OTP", "photoTAN"])("requires a colon to pair %s with a value across a preserved line break", async acronym => {
  await expectMailPaths({ subject: "Layout notes", body: `Terms:\n${acronym}:\n482917`,
    cleanBody: `Terms:\n${acronym}:\n[code]`, keepSnippetLines: true });
  await expectMailPaths({ subject: "Layout notes", body: `Terms:\n${acronym}\n482917`, keepSnippetLines: true });
});

it.each([
  ["Your verification code", "Your verification code\n4\n8\n2\n9\n1\n7\nIt expires in 10 minutes.", "4\n8\n2\n9\n1\n7"],
  ["Your sign-in code", "Enter this code:\n482\n917\n", "482\n917"],
  ["Your Slack confirmation code", "Your confirmation code is below\n482\n917\nEnter it in the app.", "482\n917"],
  ["Your sign-in code", "Hi Anna,\n\n482\n917\n\nEnter it in the app.", "482\n917"],
  ["Dein Code", "Dein Code:\n48\n29\n17\nGruss", "48\n29\n17"],
])("masks a code split across lines in %s", async (subject, body, value) => {
  await expectMailPaths({ subject, body, cleanBody: body.replace(value, "[code]") });
});

it.each([
  ["Buchungscode", ["Q", "7XK", "2M"].join("")], ["Fehlercode", "80070005"], ["Artikelcode", "482917"],
  ["Ticketcode", "482917"], ["Kundencode", "482917"], ["Aktionscode", "482917"],
  ["Vorteilscode", "482917"], ["Referenzcode", "482917"], ["Kurscode", "4821"],
  ["Zipcode", "80331"], ["Dresscode", "elegant"],
  ["Gutscheincode", "482917"], ["Rabattcode", "SPRING20"], ["Promocode", "BF2026"],
  ["Ländercode", "0041"], ["QR-Code", "48291735A"],
])("keeps %s intact without credential context", async (label, value) => {
  await expectMailPaths({ subject: "Bestellung vom 25.11.2026", body: `Danke für Ihren Einkauf. ${label}: ${value}. Details: https://shop.example.de/o/48291735ab` });
});

it("keeps a QR code in a ticket intact without credential context", async () => {
  await expectMailPaths({ subject: "Ihr Ticket", body: "Ihr QR-Code: 48291735A, Sitz 14C, Konzert am 03.12.2026." });
});

it.each(["PAKISTAN", "MANHATTAN", "TITAN", "KAZAKHSTAN", "SPARTAN", "AFGHANISTAN", "METROPOLITAN", "SULTAN"])("keeps %s intact in the subject and body", async word => {
  await expectMailPaths({ subject: `${word} 2026`, body: `Fares from CHF 482. Booking 77431902. ${word} 482917 tickets.` });
  await expectMailPaths({ subject: "Weekend deals", body: `${word} 482917 tickets. Order 77431902 on 03.12.2026.` });
});

it.each([
  ["Danke für Ihre Anmeldung", "Kurs 4821 startet am 03.12.2026."],
  ["Danke für Ihre Anmeldung bei uns", "Kurs 4821 startet am 03.12.2026."],
  ["Danke für Ihre Anmeldung bei Acme", "Kurs 4821 startet am 03.12.2026."],
  ...["Vielen Dank für Ihre Anmeldung bei uns", "Dank für deine Anmeldung bei uns",
    "Danke für die Anmeldung bei Lauf 2027", "Danke für die Anmeldung bei Acme",
    "Wir danken Ihnen für Ihre Anmeldung bei der Volkshochschule", "Ihre Anmeldung bei der VHS Zürich",
    "Bestätigung Ihrer Anmeldung bei Acme", "Anmeldung bei Dr. Meier am 03.12.2026",
    "Ihre Anmeldung zur Tagung", "Ihre Anmeldung für den Kurs", "Anmeldung bestätigt"].map(
    subject => [subject, "Kurs 4821 startet am 03.12.2026. Details: https://kurse.example.de/k/48291735ab."],
  ),
  ["Ordinary correspondence", "For questions call Kevin Tan 079 482 91 73. Invoice 48291735 due 10.12.2026."],
  ["Ordinary correspondence", "Call Amy Tan: 079 482 91 73 about the venue. Also the report for 2026 is ready."],
  ["Ordinary correspondence", "Pin 4821 to the board. Meeting at 10 in room 3."],
  ["Ordinary correspondence", "Pin: Berlin. Score 4821 points on 03.12.2026."],
  ["Ordinary correspondence", "The report for 2026 is ready.\nBest regards,\nLisa Pin\n079 482 91 73"],
  ["Ordinary correspondence", "Best regards,\nKevin Tan\n9123-4567"],
  ["Support request", "Der Fehlercode lautet 80070005. Rechnung 48291735."],
  ...["tan", "TaN", "pin", "PiN", "otp", "Otp"].flatMap(word => [
    ["Account information", `Your ${word}: 482917`],
    ["Account information", `Your ${word} 482917`],
    ["Account information", `Your ${word} is kpqzrt and it expires.`],
  ]),
  ["Ihre Anmeldung zum Webinar am 03.12.2026", "Webinar-ID 84213 am 03.12.2026."],
  ["Ihre Anmeldung ist bestätigt – Kurs 4821", "Kursnummer 4821."],
  ["Anmeldebestätigung Yoga 03.12.2026", "Buchung 73921."],
  ["Anmeldeschluss 30.11.2026 für Tagung 4821", "Tagung 4821 am 30.11.2026."],
  ["Your registration for the webinar on 03.12.2026", "Webinar reference 84213."],
  ["Tan lines and summer 2026", "Trip 482917."],
  ["Pin the printout", "Reference 482917."],
  ["Programming notes", "Please decode 482917."],
  ["Invitation: Lunch @ Fri 28 Nov 2026 12:00", "You have been invited to Lunch. Fri 28 Nov 2026 12:00 – 13:00 (CET)."],
  ["Your receipt #48291735", "Receipt 48291735. Total CHF 129.00, paid on 25.11.2026. We will never ask for your password."],
  ["Ihre Quittung 4829173", "Bestellnummer 4829173, Betrag 89,90 €, bezahlt am 25.11.2026. Wir fragen Sie niemals nach Ihrem Passwort."],
  ["Ihre Sendung 00340434161094012221 kommt heute", "Sendungsnummer 00340434161094012221. Zustellung zwischen 10:00 und 14:00."],
  ["UPS Update: Package scheduled for delivery", "Tracking number " + ["1Z", "999AA", "10123456784"].join("") + ". Home | Sign in | Help | Contact."],
  ["Expected delivery 11/27", "Tracking 9400111899223817465721 arrives Thursday."],
  ["Rechnung RE-" + "2026-11-4471", "Bitte überweisen Sie 142,30 € bis 10.12.2026 auf IBAN CH" + "93 0076 2011 6238 5295 7."],
  ["Invoice INV-48291 is available", "Invoice INV-48291 for $43.50 is due 2026-12-01. View it in your dashboard after you sign in."],
  ["Issue 412: Rust, passkeys and more", "Why passkeys beat passwords. Unsubscribe at https://news.example.test/unsubscribe?token=stay."],
  ["Your booking confirmation ABC" + "12D", "Flight LX" + "1234 on 25.11.2026 at 07:40. Seat 14C."],
  ["Ihre Buchung", "Buchungscode " + ["Q", "7XK", "2M"].join("") + ", Flug LH 1234 am 03.12.2026. Online-Check-in ab 30 Stunden vor Abflug."],
  ["Ihr Billett: Zürich HB - Bern", "Billett-Nr. 48291735, gültig am 25.11.2026. Abfahrt 07:32, Gleis 32. Preis CHF 26.00."],
  ["Ihr Kontoauszug November", "Konto CH" + "93 0076 2011 6238 5295 7. Loggen Sie sich in E-Finance ein, um ihn anzusehen."],
  ["[JIRA] (APP-" + "4821) Password field shows wrong error", "Anna updated APP-" + "4821: Status changed to In Review."],
  ["Steuererklärung 2025", "Ihre Steuererklärung 2025 ist eingegangen. Referenz 2025-77-48291. Entscheid folgt bis 31.03.2026."],
  ["Payslip November 2026", "Hi, the payslip for November is attached. Employee number 48291, net CHF 6'420.35."],
  ["Weihnachten 2026", "Wir kommen am 24.12.2026 um 17:00. Zug IC 1084."],
  ["otp planning notes", "Reference 482917."],
  ["Welcome to the shop", "Ihr Rabattcode: SPRING20."],
  ["Willkommen", "Ihr Gutscheincode: 482917."],
  ["Willkommen", "Ihr Sendungscode: 482917."],
])("preserves ordinary prose in %s", async (subject, detail) => {
  await expectMailPaths({ subject, body: detail + " Read https://events.example.de/calendar/84213." });
});

it("applies the mail rule to typed credential text without borrowing the reply subject", () => {
  const draft = (text: string) => draftUserPayload({
    incoming: { from: "", subject: "Your verification code", snippet: "" },
    context: { kbEntries: [], threadMessages: [] }, own: { replying: true, text },
  }).own!.text;
  expect(draft("Your one-time password (OTP) is 638194")).toBe("Your one-time password (OTP) is [code]");
  expect(draft("Explain how to sign in. Mention order 48291735.")).toBe("Explain how to sign in. Mention order 48291735.");
  expect(draft("Subject: Sign in to Medium\nOpen https://medium.com/m/callback/email?token=" + token))
    .toBe("Subject: Sign in to Medium\nOpen https://medium.com/[link]");
});

it("redacts the explicit Devise unlock token under an otherwise ambiguous subject", async () => {
  const body = `Open https://app.example.com/users/unlock?unlock_token=${token}.`;
  await expectMailPaths({ subject: "Unlock instructions", body, cleanBody: "Open [sign-in link]." });
});

it.each(["TAN", "PIN", "OTP"])("recognizes the uppercase %s cue in the subject", async subject => {
  await expectMailPaths({ subject, body: "Wert: 482917", cleanBody: "Wert: [code]" });
});

const signInOrigin = "https://acme.example.de";
const signInUrl = `${signInOrigin}/m/${deviseToken}`;
const signInBodies = [
  [`Hier klicken: ${signInUrl}`, signInUrl],
  [`Weiter: ${signInUrl}\nDer Link ist 15 Minuten gültig.`, signInUrl],
  ["Code: 482917", "482917"],
  ["482917\nGültig 10 Minuten.", "482917"],
] as const;
const signInSubjects = [
  "Anmeldung bei Acme", "Anmeldung bei Acme AG", "Anmeldung bei E-Banking", "Anmeldung bei UBS e-banking",
  "Anmeldung bei Ihrem Acme-Konto", "Anmeldung bei Acme bestätigen", "Anmeldung bei Acme – Ihr Link",
  "Ihre Anmeldung bei Acme", "Anmeldung bei der Acme App", "Neue Anmeldung bei Acme",
  "Anmeldung bei myAcme", "Ihr Link zur Anmeldung bei Acme",
];
const signInBodyCues = [
  [`Anmeldung bei Acme: ${signInUrl}`, signInUrl],
  ["Anmeldung bei Acme: 482917", "482917"],
  [`Anmeldung bei Acme\n${signInUrl}`, signInUrl],
  [`Zur Anmeldung bei Acme: ${signInUrl}`, signInUrl],
] as const;

it.each([
  ...signInSubjects.flatMap(subject => [...signInBodies, ...signInBodyCues].map(([body, value]) => ({ subject, body, value }))),
  ...["Anmeldung: Ihr Link", "Hallo"].flatMap(subject => signInBodyCues.map(([body, value]) => ({ subject, body, value }))),
  ...["Anmeldung: bei Acme", "Anmeldung–bei Acme", "Anmeldung-bei Acme", "Anmeldung\nbei Acme"]
    .map(cue => ({ subject: "Hallo", body: `${cue}: ${signInUrl}`, value: signInUrl })),
  { subject: "Hallo", body: "Anmeldung bestätigt: Code: 482917", value: "482917" },
  { subject: "Hallo", body: `Anmeldung bestätigt: Link: ${signInUrl}`, value: signInUrl },
  { subject: "Anmeldung bestätigt", body: "Code: 482917", value: "482917" },
  { subject: "Anmeldung bestätigt", body: `Link: ${signInUrl}`, value: signInUrl },
])("redacts sign-in credentials in $subject / $body", async ({ subject, body, value }) => {
  await expectMailPaths({
    subject, body, cleanBody: body.replace(value, value === signInUrl ? `${signInOrigin}/[link]` : "[code]"),
  });
});

it.each([
  "Vielen Dank für Ihre Anmeldung bei Acme.",
  "Wir danken Ihnen für Ihre Anmeldung bei der Volkshochschule.",
  "Eure Anmeldung zum Kurs ist eingetragen.",
  "Ihre Anmeldung für das Seminar ist eingetragen.",
  "Anmeldung bestätigt.",
  "Anmeldung bei Dr. Meier am 03.12.2026.",
])("keeps event registration in the body intact for %s", async registration => {
  await expectMailPaths({
    subject: "Termin", body: registration + " Kurs 4821 startet am 03.12.2026. Details: https://kurse.example.de/k/48291735ab",
  });
});

it.each([
  "Ihr Code wurde soeben angefordert. Sie haben zehn Minuten Zeit.",
  "Der Code wurde an Ihre Nummer gesendet.",
  "Der Code kommt gleich per SMS.",
  "Your code arrives shortly by SMS.",
  "Dein Code bleibt zehn Minuten gültig.",
  "Your code message is on its way.",
  "The code notification is on its way.",
  "Der Code gehört zu Ihrer Anmeldung.",
])("keeps the prose after a code label in %s", async body => {
  await expectMailPaths({ subject: "Ihr Anmeldecode", body });
});

it.each([
  ["Your sign-in code", "Your code\nkpqzrt\nIt expires in 10 minutes.", "kpqzrt"],
  ["Hallo", "Login Code\nkpqzrt", "kpqzrt"],
  ["Hallo", "Login Code\nQxRtZb", "QxRtZb"],
  ["Ihr Anmeldecode", "Dein Code\n\nkpqzrt\n\nGruss", "kpqzrt"],
  ["Your sign-in code", "Your code QxRaTb. It expires in 10 minutes.", "QxRaTb"],
  ["Your sign-in code", "Your code kpaqrt. It expires in 10 minutes.", "kpaqrt"],
])("redacts letters after a code label in %s / %s", async (subject, body, value) => {
  await expectMailPaths({ subject, body, cleanBody: body.replace(value, "[code]") });
});

it("pairs a word-shaped code with its label across a line break", async () => {
  await expectMailPaths({ subject: "Hallo", body: "Login Code\nready", cleanBody: "Login Code\n[code]", keepSnippetLines: true });
});

it.each([
  ["Ihre TAN:\n\n482917", "482917"],
  ["Your PIN:\n\n4821", "4821"],
  ["Your OTP:\n\n482917\n\nValid 5 minutes", "482917"],
  ["Ihre pushTAN:\r\n\r\n482917", "482917"],
  ["TAN:\n \n482917", "482917"],
])("pairs an acronym and value across a blank line in %s", async (body, value) => {
  await expectMailPaths({ subject: "Zahlung", body, cleanBody: body.replace(value, "[code]") });
});
