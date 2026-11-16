import { renderAlertMail, renderDigestMail, type AlertDigest } from "@trafficflow/db/cloud";
import { renderDoc, type Block, type FooterLine, type MailDoc, type MailLocale, type RenderedEmail, type Run } from "./frame.js";

/**
 * The transactional templates. Each customer template returns the words of its mail as a `MailDoc`
 * and `frame.ts` writes the markup: one frame, one escaper, one URL door. The frame's rules hold
 * here too, enforced by `mail-templates.test.ts`: no remote resource, ever; text AND html for every
 * mail, made from the same words; every value escaped and every URL validated; factual microcopy.
 * The words are the brand kit's mail family, in the voice: English, and German where the account,
 * or the signup screen, says German. The two operator mails are rendered by `packages/db`.
 */

export { esc, safeUrl, type MailLocale, type RenderedEmail } from "./frame.js";
import { safeUrl } from "./frame.js";

export function mailLocaleOf(value: unknown): MailLocale | undefined {
  return value === "de" || value === "en" ? value : undefined;
}

/** The mail's language: German only when the data says German. */
const loc = (locale: unknown): MailLocale => mailLocaleOf(locale) ?? "en";

// ── Words every mail shares ─────────────────────────────────────────────────

const COMPANY: Record<MailLocale, string> = {
  en: "TrafficFlow GmbH, Zürich, Switzerland",
  de: "TrafficFlow GmbH, Zürich, Schweiz",
};

const NEVER: Record<MailLocale, string> = {
  en: "We never ask you for a code, a password or a recovery code by mail.",
  de: "Wir fragen dich nie per Mail nach einem Code, einem Passwort oder einem Wiederherstellungscode.",
};

const human = (lang: MailLocale, address: string): Run[] => lang === "de"
  ? ["Schreib an ", { mail: address }, ", und ein Mensch antwortet."]
  : ["Write to ", { mail: address }, " and a person answers."];

/** The capsule's address once more as words, in the html part only: the text part has it under the label. */
const noButton = (lang: MailLocale, url: string): FooterLine => ({
  htmlOnly: [
    lang === "de" ? "Falls der Button nicht funktioniert, öffne diesen Link: " : "If the button does not work, open this link: ",
    { link: url, href: url },
  ],
});

const p = (...runs: Run[]): Block => ({ p: runs });
const strong = (text: string): Block => ({ strong: [text] });
const line = (text: string): Run[] => [text];

// ─────────────────────────────────────────────────────────────────────────────
// Template 1 — waitlist confirmation.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors `SignupTier` in `apps/webapp/app/(marketing)/components/Signup.tsx`. The `waitlist` table owns the CHECK. */
export type WaitlistTier = "desktop" | "solo" | "plus" | "pro" | "undecided";

const TIER_LINE: Record<WaitlistTier, Run[]> = {
  desktop: ["You leaned toward ", { b: "Desktop" }, ", which is free and stays free."],
  solo: ["You leaned toward ", { b: "Cloud Solo" }, ", $9 a month."],
  plus: ["You leaned toward ", { b: "Cloud Plus" }, ", $15 a month."],
  pro: ["You leaned toward ", { b: "Cloud Pro" }, ", $29 a month."],
  undecided: ["You are still deciding, and nothing is binding."],
};

export interface WaitlistConfirmationData {
  /** What the signer picked on the landing form. */
  tier: WaitlistTier;
  /** The landing site, for the "until then" link. */
  siteUrl: string;
  /** A real mailbox a human reads — also the `List-Unsubscribe` target. */
  supportEmail: string;
}

/** English only: the waitlist row carries no language. */
function waitlistConfirmation(d: WaitlistConfirmationData): MailDoc {
  const site = safeUrl(d.siteUrl);
  const tier = Object.hasOwn(TIER_LINE, d.tier) ? TIER_LINE[d.tier] : null;
  return {
    lang: "en",
    subject: "You're on the ohmail waitlist",
    title: "You're on the waitlist.",
    // RFC 8058 one-click needs a POST endpoint we do not have; the mailto form is RFC 2369.
    headers: { "List-Unsubscribe": `<mailto:${d.supportEmail}?subject=Remove%20me%20from%20the%20ohmail%20waitlist>` },
    blocks: [
      p("We have your waitlist signup. This mail confirms the address, and you need to do nothing more."),
      ...(tier ? [p(...tier)] : []),
      p("When beta accounts open, we send one more mail with an invite code. That is the only other mail you get from this list."),
      p("Until then, ", { link: new URL(site).hostname, href: site }, " says what ohmail is."),
    ],
    footer: [
      ["If this was not you, or you changed your mind, write to ", { mail: d.supportEmail }, " and we delete the entry."],
      line(COMPANY.en),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 2 — invite delivery (the code that opens the gate).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The copy deliberately claims LESS than a well-built invite system would. It once asserted that a
 * code was single-use and tied to the address while `register` checked codes against a reusable
 * in-memory `Set`; a recipient deciding whether forwarding the mail is safe would have relied on a
 * claim the system could not keep. The words are true under both mechanisms, the bootstrap `Set`
 * and the consumable, email-bound invite rows. Do not strengthen them; `mail-templates.test.ts`
 * asserts the absence of the claims.
 */
export interface InviteData {
  /** The beta code. Shown in full — it is not a secret to the holder of this inbox. */
  code: string;
  /** Where to redeem it (`https://app.ohmail.app/join?code=…` in production). */
  redeemUrl: string;
  /** Human-readable deadline, already formatted by the caller (UTC, no locale guessing). */
  expiresAt: string;
  supportEmail: string;
}

/** English only: the invite is minted by the operator for a waitlist row, which has no language. */
function invite(d: InviteData): MailDoc {
  const url = safeUrl(d.redeemUrl);
  return {
    lang: "en",
    subject: "Your ohmail beta invite",
    title: "Beta accounts are open.",
    preheader: "Beta accounts are open. One is reserved for you.",
    blocks: [
      p("One is reserved for you."),
      { label: "Your invite code:", code: d.code },
      p(`The code stops working on ${d.expiresAt}. Keep it to yourself: anyone who has it can open an ohmail account.`),
      p("ohmail asks you to set up a passkey or an authenticator app, and to connect a mailbox you already own. It then organizes that mailbox where it is and copies nothing to a new address."),
    ],
    action: { label: "Redeem the invite", url },
    footer: [
      noButton("en", url),
      ["If you have questions, or it does not work, write to ", { mail: d.supportEmail }, "."],
      line(COMPANY.en),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 3 — the security notices.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Passkeys make a password-reset mail unnecessary; these notices make an unrecognised sign-in, or an
 * attack on one, visible. They contain **no link that changes state** and no capsule: a "this was not
 * me" button in a mail is a phishing template with our branding on it. The reader is pointed at the
 * app's own device list, which they reach the way they always do.
 *
 * A security notice (`AuthService.drainSecurityNotices`): a closed KIND, a time and configuration,
 * nothing a caller wrote; in the account's own language.
 */
export interface SecurityNoticeData {
  kind: "sign_in_slowed" | "factor_refused";
  at: string;
  devicesUrl: string;
  supportEmail: string;
  /** The account's own (`account_settings.locale`), English when unset. */
  locale?: MailLocale;
}

const SECURITY_COPY: Record<MailLocale, {
  slowed: { subject: string; title: string; lines: (devices: string) => Run[][] };
  refused: { subject: string; title: string; lines: (devices: string, support: string) => Run[][] };
  time: string;
}> = {
  en: {
    slowed: {
      subject: "Failed sign-in attempts on your ohmail account",
      title: "Many sign-in attempts failed.",
      lines: (devices) => [
        ["In the last few minutes, many attempts to sign in to your ohmail account failed. They came from devices that had not signed in before, and none of them had your password."],
        ["ohmail has slowed sign-in from new devices for a while. The devices you already use sign in as before."],
        ["If you are signing in from a new device, wait a few minutes and try again."],
        ["Settings › Devices lists the devices signed in to your account (", { link: devices, href: devices }, ")."],
      ],
    },
    refused: {
      subject: "Your ohmail password was used and the second step failed",
      title: "Your password was used, and the second step failed.",
      lines: (devices, support) => [
        ["Somebody signed in to your ohmail account with your password and then failed the second step several times."],
        ["If that was you, there is nothing to do."],
        ["If it was not, somebody knows your password, and your second factor stopped them. Open ohmail yourself and check Settings › Devices (",
          { link: devices, href: devices }, "). Then write to ", { mail: support }, ", and we help you secure the account."],
      ],
    },
    time: "Time",
  },
  de: {
    slowed: {
      subject: "Fehlgeschlagene Anmeldeversuche bei deinem ohmail-Konto",
      title: "Viele Anmeldeversuche sind fehlgeschlagen.",
      lines: (devices) => [
        ["In den letzten Minuten sind viele Versuche fehlgeschlagen, dich bei deinem ohmail-Konto anzumelden. Sie kamen von Geräten, die noch nie angemeldet waren, und keines davon hatte dein Passwort."],
        ["ohmail hat die Anmeldung von neuen Geräten für eine Weile verlangsamt. Die Geräte, die du schon benutzt, melden sich an wie bisher."],
        ["Meldest du dich gerade von einem neuen Gerät an, warte ein paar Minuten und versuch es noch einmal."],
        ["Unter Einstellungen › Geräte stehen die Geräte, die bei deinem Konto angemeldet sind (", { link: devices, href: devices }, ")."],
      ],
    },
    refused: {
      subject: "Dein ohmail-Passwort wurde benutzt, und der zweite Schritt schlug fehl",
      title: "Dein Passwort wurde benutzt, und der zweite Schritt schlug fehl.",
      lines: (devices, support) => [
        ["Jemand hat sich mit deinem Passwort bei deinem ohmail-Konto angemeldet und ist dann mehrmals am zweiten Schritt gescheitert."],
        ["Warst du das, ist nichts zu tun."],
        ["Warst du es nicht, kennt jemand dein Passwort, und dein zweiter Faktor hat ihn aufgehalten. Öffne ohmail selbst und prüfe Einstellungen › Geräte (",
          { link: devices, href: devices }, "). Schreib dann an ", { mail: support }, ", und wir helfen dir, das Konto zu sichern."],
      ],
    },
    time: "Zeit",
  },
};

function securityNotice(d: SecurityNoticeData): MailDoc {
  const lang = loc(d.locale);
  const url = safeUrl(d.devicesUrl);
  const c = SECURITY_COPY[lang];
  const slowed = d.kind === "sign_in_slowed";
  const lines = slowed ? c.slowed.lines(url) : c.refused.lines(url, d.supportEmail);
  return {
    lang,
    subject: slowed ? c.slowed.subject : c.refused.subject,
    title: slowed ? c.slowed.title : c.refused.title,
    blocks: [...lines.map((l) => p(...l)), { facts: [[c.time, d.at]] }, strong(NEVER[lang])],
    // The second notice names support in its text, so its footer does not name it again.
    footer: [...(slowed ? [human(lang, d.supportEmail)] : []), line(COMPANY[lang])],
  };
}

export interface NewDeviceSignInData {
  /** `devices.label` — "Web", "ohmail for Mac", … Never trusted; escaped. */
  device: string;
  /** The client IP recorded on the device row, or "unknown". */
  ip: string;
  /** When, formatted by the caller as UTC. */
  at: string;
  /** Deep link to the app's device list — informational, changes nothing by itself. */
  devicesUrl: string;
  supportEmail: string;
}

/** English only: nothing sends it yet, and its German is written the day a caller is wired. */
function newDeviceSignIn(d: NewDeviceSignInData): MailDoc {
  const url = safeUrl(d.devicesUrl);
  return {
    lang: "en",
    subject: "New sign-in to your ohmail account",
    title: "A new device signed in.",
    preheader: "A new device signed in. It had not signed in to your ohmail account before.",
    blocks: [
      p("It had not signed in to your ohmail account before."),
      { facts: [["Device", d.device], ["IP address", d.ip], ["Time", d.at]] },
      p("If that was you, there is nothing to do."),
      p("If it was not, open ohmail yourself and go to Settings › Devices (", { link: url, href: url },
        "). Sign that device out there, and replace your second factor."),
      strong(NEVER.en),
    ],
    footer: [human("en", d.supportEmail), line(COMPANY.en)],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 4 — email verification.
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailVerificationData {
  /** `https://ohmail.app/verify-email?token=…` — the raw token; only its hash is stored. */
  verifyUrl: string;
  /** How long the link lives, rendered as the caller wants it read. */
  expiresIn: string;
  supportEmail: string;
  /** The signup screen's language; English when unset. */
  locale?: MailLocale;
}

/**
 * The "if you did not start this" line says what is enforced (by `withVerifiedEmail`): an unverified
 * account cannot reach Checkout and cannot connect a mailbox. It does NOT promise the row is deleted:
 * nothing reaps unverified accounts, and a mail that invents a retention policy is a liability.
 */
function emailVerification(d: EmailVerificationData): MailDoc {
  const lang = loc(d.locale);
  const url = safeUrl(d.verifyUrl);
  const de = lang === "de";
  return {
    lang,
    subject: de ? "Bestätige deine Adresse für ohmail" : "Confirm your address for ohmail",
    title: de ? "Bestätige deine Adresse." : "Confirm your address.",
    blocks: de ? [
      p("Bestätige diese Adresse, dann ist dein ohmail-Konto fertig eingerichtet."),
      p(`Der Link funktioniert einmal und läuft in ${d.expiresIn} ab. Die Seite dahinter fragt nach dem Passwort, das du gewählt hast.`),
      p("Hast du das nicht gestartet, ignoriere diese Mail. Ohne den Link kann das Konto kein Postfach verbinden und nichts abonnieren."),
    ] : [
      p("Confirm this address to finish setting up your ohmail account."),
      p(`The link works once and expires in ${d.expiresIn}. The page it opens asks for the password you chose.`),
      p("If you did not start this, ignore this mail. Without the link, the account cannot connect a mailbox and cannot subscribe to anything."),
    ],
    action: { label: de ? "Adresse bestätigen" : "Confirm this address", url },
    footer: [noButton(lang, url), human(lang, d.supportEmail), line(COMPANY[lang])],
  };
}

/**
 * Template 5 — OPERATOR ALERT. Not a customer mail: its recipient is a single configured operator
 * address (`sendOperatorAlert` refuses any other), it carries no user-controlled string, and its
 * content is counts and ages produced by `packages/db/src/alerts.ts`. Mail is the pager's second
 * delivery path, on infrastructure that shares nothing with the first. No free-form body: this
 * template's data shape cannot express one.
 */
export interface OperatorAlertData {
  /** `production` / `staging` — first word of the subject so nobody pages on staging. */
  environment: string;
  /** Which driver observed this: `worker` or `api`. */
  source: string;
  /** The firing conditions, already rendered to prose by `alerts.ts`. */
  alerts: Array<{ title: string; detail: string; severity: string }>;
  /** Where the operator goes next. First-party origin; `safeUrl` enforces https. */
  consoleUrl: string;
}

function operatorAlert(d: OperatorAlertData): RenderedEmail {
  // THE WORKER'S MAIL ARM SENDS THESE BYTES TOO: both drivers page from one `alert_state`, so
  // one renderer (`packages/db`) makes the mail, whichever driver won the claim.
  return renderAlertMail({
    alerts: d.alerts, environment: d.environment, source: d.source, consoleUrl: safeUrl(d.consoleUrl),
  });
}

/**
 * The operator's DAILY ALERT SUMMARY — `operator_alert`'s sibling, not customer mail: the configured
 * operator address, a digest of incident keys, kinds, titles and timestamps. Rendered by
 * `packages/db`, so the worker's mail arm and this one send the same bytes.
 */
export interface OperatorDigestData {
  environment: string;
  digest: AlertDigest;
  consoleUrl: string;
}

function operatorDigest(d: OperatorDigestData): RenderedEmail {
  return renderDigestMail(d.digest, d.environment, safeUrl(d.consoleUrl));
}

/**
 * Template 6 — ACCOUNT ALREADY EXISTS, the one that closes the oracle. `POST /auth/register` answers
 * a CONSTANT 202 on the public path either way, so the "sign in instead" news goes here, the inbox
 * only the address owner can read. It carries NO CREDENTIAL: the only link is the sign-in page.
 * `signInUrl` and `supportEmail` are deployment config; the recipient is the envelope, not the body.
 */
export interface AccountExistsData {
  /** `https://ohmail.app/login` — built from config by `MailService`, never by a caller. */
  signInUrl: string;
  supportEmail: string;
  /** The signup screen's language, as the verification mail's: the two branches stay alike. */
  locale?: MailLocale;
}

function accountExists(d: AccountExistsData): MailDoc {
  const lang = loc(d.locale);
  const url = safeUrl(d.signInUrl);
  const de = lang === "de";
  return {
    lang,
    subject: de ? "Du hast schon ein ohmail-Konto" : "You already have an ohmail account",
    title: de ? "Du hast schon ein ohmail-Konto." : "You already have an ohmail account.",
    blocks: de ? [
      p("Jemand hat versucht, mit dieser Adresse ein ohmail-Konto anzulegen. Es gibt schon eins, also wurde nichts angelegt und nichts geändert."),
      p("Warst du das, melde dich stattdessen an. Dein Konto ist, wie es war."),
      p("Warst du es nicht, kannst du diese Mail ignorieren. Wer es versucht hat, hat nicht erfahren, ob es zu dieser Adresse ein Konto gibt, und kommt ohne dein Passwort oder deinen Passkey nicht hinein."),
    ] : [
      p("Someone tried to create an ohmail account with this address. One exists already, so nothing was created and nothing changed."),
      p("If that was you, sign in instead. Your account is as it was."),
      p("If it was not you, you can ignore this mail. Whoever tried was not told whether this address has an account, and cannot get in without your password or your passkey."),
    ],
    action: { label: de ? "Bei ohmail anmelden" : "Sign in to ohmail", url },
    footer: [noButton(lang, url), human(lang, d.supportEmail), line(COMPANY[lang])],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 7 — the account lifecycle notices (cloud 0040, the wall).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE template, three notices: the trial ending, the closure, the erasure week. The data is dates,
 * closed words and configuration — nothing a sender or a caller chose can enter the body. `locale`
 * is the account's own (`account_settings.locale`, en when unset); the mailbox is the master and the
 * words say so every time, and no notice names a price or a plan.
 */
interface LifecycleNoticeData {
  kind: "trial_two_days" | "closed" | "erasure_week";
  locale: "en" | "de";
  /** The anchor's own date (trial end / closure / erasure), formatted by the caller as UTC. */
  anchorDate: string;
  /** The erasure forecast's date, or null while none exists (an operator hold, say). A late erasure
   *  warning's is a week after it was sent, its anchor's date having passed. */
  erasureDate: string | null;
  /** Deep link to the app's account page — informational, changes nothing by itself. */
  accountUrl: string;
  /** The signup wizard's mailbox step, through sign-in (`<app>/login?next=join`). */
  setupUrl: string;
  /** The account has never had a mailbox: the trial and closure notices must not say ohmail organizes one. */
  noMailbox?: boolean;
  supportEmail: string;
}

const LIFECYCLE_KINDS = new Set(["trial_two_days", "closed", "erasure_week"]);

/** The words of one notice; the Microsoft sign-in is named for work or school accounts only. */
function lifecycleWords(d: LifecycleNoticeData, de: boolean, bare: "trial_two_days" | "closed" | null):
  { subject: string; title: string; action: string; blocks: Array<string | null> } {
  const erase = d.erasureDate
    ? (de ? `Tust du nichts, löschen wir deine ohmail-Kontodaten am ${d.erasureDate}: deine Regeln, deine Screener-Entscheidungen und deine Einstellungen.`
      : `If you do nothing, we erase your ohmail account data on ${d.erasureDate}: your rules, your Screener decisions and your settings.`)
    : null;
  const openAccount = de ? "ohmail-Konto öffnen" : "Open your ohmail account";
  if (bare === "trial_two_days") {
    return de ? {
      subject: "Deine ohmail-Testphase endet in zwei Tagen", title: "Deine Testphase endet in zwei Tagen.", action: "Postfach verbinden",
      blocks: [
        `Deine Testphase endet am ${d.anchorDate}, und mit deinem ohmail-Konto ist noch kein Postfach verbunden. ohmail hat also noch keine Mail für dich organisiert.`,
        "Das Verbinden dauert ein paar Minuten. Der Button unten öffnet den Postfach-Schritt, falls nötig über die Anmeldung. Liegen deine Mails in einem Microsoft-365-Postfach deiner Arbeit oder Schule, verbinde es stattdessen unter Einstellungen › Postfächer mit „Outlook verbinden“: Du meldest dich bei Microsoft an und brauchst kein App-Passwort.",
        "Hängst du fest oder bist unsicher, ob ohmail passt, antworte auf diese Mail, und ein Mensch antwortet dir.",
      ],
    } : {
      subject: "Your ohmail trial ends in two days", title: "Your trial ends in two days.", action: "Connect your mailbox",
      blocks: [
        `Your trial ends on ${d.anchorDate}, and your ohmail account has no mailbox connected yet. So ohmail has not organized any mail for you.`,
        "Connecting takes a few minutes. The button below opens the mailbox step, through sign-in if needed. If your mail is in a Microsoft 365 work or school account, connect it in Settings › Mailboxes with Connect Outlook instead: you sign in with Microsoft and need no app password.",
        "If you are stuck, or not sure ohmail fits, reply to this mail and a person answers.",
      ],
    };
  }
  if (bare === "closed") {
    return de ? {
      subject: "Dein ohmail-Konto ist geschlossen", title: "Dein Konto ist geschlossen.", action: openAccount,
      blocks: [
        `Dein ohmail-Konto ist seit dem ${d.anchorDate}, geschlossen. Mit ihm war kein Postfach verbunden, ohmail hat also nie eine deiner Mails gelesen oder verschoben.`,
        "Melde dich an, um doch noch zu abonnieren und ein Postfach zu verbinden, oder um dein Konto zu löschen.",
        erase,
        "Hast du Fragen oder hängst du beim Verbinden fest, antworte auf diese Mail, und ein Mensch antwortet dir.",
      ],
    } : {
      subject: "Your ohmail account has closed", title: "Your account has closed.", action: openAccount,
      blocks: [
        `Your ohmail account closed on ${d.anchorDate}. It had no mailbox connected, so ohmail never read or moved any of your mail.`,
        "Sign in to subscribe and connect a mailbox after all, or to delete your account.",
        erase,
        "If you have questions or are stuck connecting, reply to this mail and a person answers.",
      ],
    };
  }
  if (d.kind === "trial_two_days") {
    return de ? {
      subject: "Deine ohmail-Testphase endet in zwei Tagen", title: "Deine Testphase endet in zwei Tagen.", action: openAccount,
      blocks: [
        `Deine Testphase endet am ${d.anchorDate}. Damit ohmail dein Postfach weiter organisiert, wähl auf deiner Kontoseite ein Abo.`,
        "Tust du nichts, hört ohmail am Ende der Testphase auf zu organisieren. Dein Postfach bleibt deins. ohmail fasst darin nichts an, und alles Einsortierte bleibt, wo es ist.",
      ],
    } : {
      subject: "Your ohmail trial ends in two days", title: "Your trial ends in two days.", action: openAccount,
      blocks: [
        `Your trial ends on ${d.anchorDate}. To keep ohmail organizing your mailbox, choose a subscription on your account page.`,
        "If you do nothing, ohmail stops organizing when the trial ends. Your mailbox stays yours. ohmail touches nothing in it, and everything it filed stays where it is.",
      ],
    };
  }
  if (d.kind === "closed") {
    return de ? {
      subject: "Dein ohmail-Abo ist beendet", title: "Dein Abo ist beendet.", action: openAccount,
      blocks: [
        `Dein Abo endete am ${d.anchorDate}, deshalb organisiert und synchronisiert ohmail nicht mehr. Dein Postfach bleibt deins. ohmail fasst darin nichts an, und deine Mails behält dein eigener Mailserver.`,
        "Melde dich an, um wieder zu abonnieren, deine Einstellungen zu exportieren oder dein Konto zu löschen.",
        erase,
      ],
    } : {
      subject: "Your ohmail subscription has ended", title: "Your subscription has ended.", action: openAccount,
      blocks: [
        `Your subscription ended on ${d.anchorDate}, so ohmail has stopped organizing and syncing. Your mailbox stays yours. ohmail touches nothing in it, and your own mail server keeps the mail.`,
        "Sign in to subscribe again, export your settings or delete your account.",
        erase,
      ],
    };
  }
  const on = d.erasureDate ?? d.anchorDate;
  return de ? {
    subject: "Deine ohmail-Kontodaten werden in einer Woche gelöscht", title: "In einer Woche löschen wir deine Kontodaten.", action: openAccount,
    blocks: [
      `Am ${on}, löschen wir deine ohmail-Kontodaten: deine Regeln, deine Screener-Entscheidungen und deine Einstellungen. In deinem Postfach fasst ohmail nichts an. Deine Mails waren nie bei uns.`,
      "Melde dich vorher an, um das Konto zu behalten, oder exportiere zuerst deine Einstellungen.",
    ],
  } : {
    subject: "Your ohmail account data is erased in a week", title: "We erase your account data in a week.", action: openAccount,
    blocks: [
      `On ${on}, we erase your ohmail account data: your rules, your Screener decisions and your settings. ohmail touches nothing in your mailbox. Your mail was never ours to hold.`,
      "Sign in before then to keep the account, or export your settings first.",
    ],
  };
}

function lifecycleNotice(d: LifecycleNoticeData): MailDoc {
  if (!LIFECYCLE_KINDS.has(d.kind)) throw new Error("mail template: unknown lifecycle kind");
  const lang = loc(d.locale);
  const bare = d.noMailbox === true && d.kind !== "erasure_week" ? d.kind : null;
  const url = safeUrl(bare === "trial_two_days" ? d.setupUrl : d.accountUrl);
  const c = lifecycleWords(d, lang === "de", bare);
  return {
    lang,
    subject: c.subject,
    title: c.title,
    blocks: c.blocks.filter((b): b is string => b !== null).map((b) => p(b)),
    action: { label: c.action, url },
    // A mail that already says "reply to this mail" does not name support a second time.
    footer: [noButton(lang, url), ...(bare ? [] : [human(lang, d.supportEmail)]), line(COMPANY[lang])],
    ...(bare ? { replyTo: d.supportEmail } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 8 — the billing link, the one customer mail staff send by hand.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent from the staff console (`POST /admin/accounts/:id/billing-link`, three per account a day) to
 * the account's owner. The data is a language, the app's own billing door and the support address:
 * no recipient (the envelope), no id, no token. The door asks for sign-in and only then mints the
 * billing page's link, so a forwarded mail opens nothing.
 */
export interface BillingLinkData {
  /** The account's own (`account_settings.locale`), English when unset. */
  locale: MailLocale;
  /** `<app>/account/manage` — built from config by `MailService`, never by a caller. */
  billingUrl: string;
  supportEmail: string;
}

function billingLink(d: BillingLinkData): MailDoc {
  const lang = loc(d.locale);
  const url = safeUrl(d.billingUrl);
  const de = lang === "de";
  const title = de ? "Der ohmail-Support hat dir diesen Link geschickt." : "ohmail support sent you this link.";
  const first = de
    ? "Er öffnet die Abo-Seite deines ohmail-Kontos, sobald du bei ohmail angemeldet bist. Der Link allein meldet niemanden an."
    : "It opens the subscription page of your ohmail account, once you are signed in to ohmail. The link alone signs nobody in.";
  return {
    lang,
    subject: de ? "Deine ohmail-Abo-Seite" : "Your ohmail subscription page",
    title,
    preheader: `${title} ${first.slice(0, first.indexOf(".") + 1)}`,
    blocks: [
      p(first),
      p(de ? "Du kannst die Seite auch selbst öffnen, in ohmail unter Einstellungen › Abo."
        : "You can also open the page yourself, in ohmail under Settings › Subscription."),
      p(de ? "Hast du diese Mail nicht erwartet, kannst du sie ignorieren. Von selbst ändert sich nichts."
        : "If you did not expect this mail, you can ignore it. Nothing changes by itself."),
      strong(NEVER[lang]),
    ],
    action: { label: de ? "Abo-Seite öffnen" : "Open the subscription page", url },
    footer: [noButton(lang, url), human(lang, d.supportEmail), line(COMPANY[lang])],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 9 — the connect reminder, once per trial that has connected no mailbox.
// ─────────────────────────────────────────────────────────────────────────────

/** Which connecting advice the reminder gives. */
export type ConnectProvider = "gmail" | "microsoft" | "other";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
/** Microsoft's personal-account domains: outlook.*, hotmail.*, live.* and msn.com. */
const MICROSOFT_DOMAIN_RE = /^(?:(?:outlook|hotmail|live)\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})|msn\.com)$/;

/**
 * The advice class of the address an account signed up with, from its domain alone: the address
 * itself never reaches the template. A Microsoft 365 or Workspace mailbox on an own domain reads as
 * `other`, which names the Microsoft 365 sign-in too.
 */
export function providerClassOf(address: string): ConnectProvider {
  const at = address.trim().toLowerCase().lastIndexOf("@");
  const domain = at < 0 ? "" : address.trim().toLowerCase().slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) return "gmail";
  return MICROSOFT_DOMAIN_RE.test(domain) ? "microsoft" : "other";
}

/**
 * Sent by the lifecycle pass, once per trial (`account_lifecycle_notices`, kind `connect_reminder`),
 * to a trial a day old with no mailbox. The data is a language, a closed advice class, the sign-in
 * door to the signup wizard's mailbox step and the support address: no recipient, no mailbox address,
 * host or server, and no tracking. A service mail, so no List-Unsubscribe; replies reach a person.
 */
export interface ConnectReminderData {
  /** The account's own (`account_settings.locale`), English when unset. */
  locale: MailLocale;
  provider: ConnectProvider;
  /** `<app>/login?next=join` — built from config by `MailService`, never by a caller. */
  setupUrl: string;
  supportEmail: string;
}

/**
 * Microsoft personal accounts (Outlook.com, Hotmail) are asked to reply until their sign-in is proven;
 * Microsoft 365 work or school mail connects by signing in with Microsoft in Settings › Mailboxes.
 */
const CONNECT_COPY: Record<MailLocale, {
  subject: string; title: string; action: string; intro: string; advice: Record<ConnectProvider, string>; how: string; once: string;
}> = {
  en: {
    subject: "Connect your mailbox to ohmail",
    title: "Connect your mailbox.",
    action: "Connect your mailbox",
    intro: "You started an ohmail trial, and no mailbox is connected yet. So ohmail has no mail to organize for you.",
    advice: {
      gmail: "Gmail takes an app password, not your Google password. Turn on 2-Step Verification in your Google account, create an app password with any name and paste its 16 letters into the mailbox step.",
      microsoft: "For an Outlook.com or Hotmail address, reply to this mail and a person helps you connect it. If your mail is in a Microsoft 365 work or school account, connect it in Settings › Mailboxes with Connect Outlook: you sign in with Microsoft and need no app password.",
      other: "Most providers ask for an app password in place of your usual password, and the mailbox step says where to make one. If your mail is in a Microsoft 365 work or school account, connect it in Settings › Mailboxes with Connect Outlook instead: you sign in with Microsoft and need no app password.",
    },
    how: "The button below opens the mailbox step, through sign-in if needed. Connecting takes a few minutes.",
    once: "We send this reminder once. If you have questions or are stuck, reply to this mail and a person answers.",
  },
  de: {
    subject: "Verbinde dein Postfach mit ohmail",
    title: "Verbinde dein Postfach.",
    action: "Postfach verbinden",
    intro: "Du hast eine ohmail-Testphase gestartet, und noch ist kein Postfach verbunden. ohmail hat also keine Mails, die es für dich organisieren kann.",
    advice: {
      gmail: "Gmail nimmt ein App-Passwort, nicht dein Google-Passwort. Schalte in deinem Google-Konto die Bestätigung in zwei Schritten ein, erstelle ein App-Passwort mit beliebigem Namen und füge seine 16 Buchstaben im Postfach-Schritt ein.",
      microsoft: "Für eine Outlook.com- oder Hotmail-Adresse antworte auf diese Mail, und ein Mensch hilft dir beim Verbinden. Liegen deine Mails in einem Microsoft-365-Postfach deiner Arbeit oder Schule, verbinde es unter Einstellungen › Postfächer mit „Outlook verbinden“: Du meldest dich bei Microsoft an und brauchst kein App-Passwort.",
      other: "Die meisten Anbieter verlangen ein App-Passwort statt deines üblichen Passworts, und der Postfach-Schritt sagt dir, wo du es erstellst. Liegen deine Mails in einem Microsoft-365-Postfach deiner Arbeit oder Schule, verbinde es stattdessen unter Einstellungen › Postfächer mit „Outlook verbinden“: Du meldest dich bei Microsoft an und brauchst kein App-Passwort.",
    },
    how: "Der Button unten öffnet den Postfach-Schritt, falls nötig über die Anmeldung. Das Verbinden dauert ein paar Minuten.",
    once: "Wir schicken diese Erinnerung nur einmal. Hast du Fragen oder hängst du fest, antworte auf diese Mail, und ein Mensch antwortet dir.",
  },
};

function connectReminder(d: ConnectReminderData): MailDoc {
  const lang = loc(d.locale);
  const url = safeUrl(d.setupUrl);
  const c = CONNECT_COPY[lang];
  const advice = Object.hasOwn(c.advice, d.provider) ? c.advice[d.provider] : c.advice.other;
  return {
    lang,
    subject: c.subject,
    title: c.title,
    blocks: [p(c.intro), p(advice), p(c.how)],
    action: { label: c.action, url },
    footer: [noButton(lang, url), line(c.once), line(COMPANY[lang])],
    replyTo: d.supportEmail,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates 10 and 11 — the storage mails, at 90% and when storage is full (cloud 0057).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent by the storage mail pass, once per (account, level, cap) and never two in a week, to the
 * account's own users. The data is numbers, closed words, the program's fitted choice with its price,
 * the app's own Settings › Storage door and the support address: no token (the door asks for sign-in),
 * no mailbox, no address. A service mail, so no List-Unsubscribe; the footer says where to turn them off.
 */
export interface StorageNoticeData {
  locale: MailLocale;
  usedBytes: number;
  capBytes: number;
  limitReason: "plan" | "trial" | "held";
  /** When the cap held after a drop ends; null otherwise. */
  limitDropsAt: string | null;
  expectedBytes: number;
  importing: boolean;
  /** "YYYY-MM": text is kept for letters from this month on; null while none was emptied. */
  keptFrom: string | null;
  fit: { plan: "solo" | "plus" | "pro"; addonUnits: number; roomBytes: number; amount: number; keepsAll: boolean };
  /** The storage the fitted choice adds on top of its plan's own room, in bytes. */
  addonBytes: number;
  currency: string;
  interval: "month" | "year";
  /** `<app>/#/settings/storage` — built from config by `MailService`, never by a caller. */
  settingsUrl: string;
  supportEmail: string;
}

const PLAN_NAMES: Record<StorageNoticeData["fit"]["plan"], string> = { solo: "Solo", plus: "Plus", pro: "Pro" };

const MONTH_NAMES: Record<MailLocale, readonly string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  de: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
};

/** Decimal gigabytes with at most one decimal, in the locale's separator: 4 GB, 3.6 GB, 3,6 GB. */
export function storageAmount(bytes: number, locale: MailLocale): string {
  const gb = Math.max(0, bytes) / 1_000_000_000;
  if (gb > 0 && gb < 0.1) return `${Math.max(1, Math.round(gb * 1000))} MB`;
  const s = String(Math.round(gb * 10) / 10);
  return `${locale === "de" ? s.replace(".", ",") : s} GB`;
}

const CURRENCY_SIGNS: Record<string, string> = { usd: "$", eur: "€", gbp: "£" };

/** The program's price as a sentence says it: $15 a month, 15 $ im Monat; minor units of its currency. */
export function storagePrice(amount: number, currency: string, interval: "month" | "year", locale: MailLocale): string {
  const whole = amount % 100 === 0;
  const units = whole ? String(amount / 100) : (amount / 100).toFixed(2);
  const n = locale === "de" ? units.replace(".", ",") : units;
  const sign = Object.hasOwn(CURRENCY_SIGNS, currency) ? CURRENCY_SIGNS[currency] : undefined;
  if (locale === "de") return `${sign ? `${n} ${sign}` : `${currency.toUpperCase()} ${n}`} ${interval === "year" ? "im Jahr" : "im Monat"}`;
  return `${sign ? `${sign}${n}` : `${currency.toUpperCase()} ${n}`} ${interval === "year" ? "a year" : "a month"}`;
}

/** "March 2019" / "März 2019" from "YYYY-MM"; null for anything else. */
function monthOf(keptFrom: string | null, locale: MailLocale): string | null {
  const m = keptFrom === null ? null : /^(\d{4})-(0[1-9]|1[0-2])$/.exec(keptFrom);
  return m ? `${MONTH_NAMES[locale][Number(m[2]) - 1]} ${m[1]}` : null;
}

/** "21 November 2026" / "21. November 2026", UTC. */
function dayOf(iso: string | null, locale: MailLocale): string | null {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const month = MONTH_NAMES[locale][d.getUTCMonth()]!;
  return locale === "de" ? `${d.getUTCDate()}. ${month} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

function storageNotice(level: "near" | "full", d: StorageNoticeData): MailDoc {
  const lang = loc(d.locale);
  const de = lang === "de";
  const full = level === "full";
  const url = safeUrl(d.settingsUrl);
  const amount = (bytes: number): string => storageAmount(bytes, lang);
  const plan = Object.hasOwn(PLAN_NAMES, d.fit.plan) ? PLAN_NAMES[d.fit.plan] : d.fit.plan;
  const choice = d.fit.addonUnits > 0 ? `${plan} + ${amount(d.addonBytes)} ${de ? "Speicher" : "storage"}` : plan;
  const price = storagePrice(d.fit.amount, d.currency, d.interval, lang);
  const used = de ? `${amount(d.usedBytes)} von ${amount(d.capBytes)}` : `${amount(d.usedBytes)} of ${amount(d.capBytes)}`;
  const until = dayOf(d.limitDropsAt, lang);
  const month = full ? monthOf(d.keptFrom, lang) : null;
  const cap = amount(d.capBytes);
  const need = amount(d.expectedBytes);
  const usedTail = de
    ? (d.limitReason === "trial" ? " belegt, der Speicher deiner Testphase."
      : d.limitReason === "held" && until !== null ? ` belegt, der Platz, den du bis zum ${until} behältst.`
      : " belegt, der Speicher deines Tarifs.")
    : (d.limitReason === "trial" ? " used, your trial room."
      : d.limitReason === "held" && until !== null ? ` used, the room you keep until ${until}.`
      : " used, your plan's storage.");
  const needRuns: Run[] = d.expectedBytes > 0
    ? (de
      ? [" Deine Mails brauchen etwa ", { b: need }, !full && d.importing ? ", wenn der Import fertig ist." : "."]
      : [" Your mail needs about ", { b: need }, !full && d.importing ? " when the import finishes." : "."])
    : [];
  const older = de ? "Die älteren Mails behält dein Mailserver vollständig, und ohmail listet und findet sie weiterhin."
    : "Your mail server keeps the older mail complete, and ohmail still lists it and finds it.";
  const what = full
    ? (de ? `ohmail Cloud behält jetzt den Text deiner neuesten Mails, ${cap}${month ? `, alles ab ${month}` : ""}. ${older}`
      : `ohmail Cloud now keeps the text of your newest ${cap}${month ? `, mail from ${month} on` : ""}. ${older}`)
    : (de ? `Ist er voll, behält ohmail Cloud den Text deiner neuesten Mails. ${older}`
      : `When it is full, ohmail Cloud keeps the text of your newest mail. ${older}`);
  const fitTail = de
    ? ` ${d.fit.keepsAll ? "behält alle deine Mails" : "behält am meisten"}: ${amount(d.fit.roomBytes)} für ${price}.${full ? " Danach holt ohmail den älteren Text von deinem Mailserver zurück." : ""}`
    : ` ${d.fit.keepsAll ? "keeps all your mail" : "keeps the most"}: ${amount(d.fit.roomBytes)} for ${price}.${full ? " ohmail then fetches the older text back from your mail server." : ""}`;
  const c = de ? {
    subject: full ? "Dein ohmail-Speicher ist voll" : "Dein ohmail-Speicher ist zu 90 % voll",
    title: full ? "Dein Speicher ist voll." : "Dein Speicher ist zu 90 % voll.",
    action: "Speicher wählen",
    counts: "Es zählt nur der Text deiner Mails, Anhänge nie.",
    stop: full ? "Das ist die letzte Speicher-Mail, bis sich etwas ändert. Abschalten kannst du Speicher-Mails unter Einstellungen › Speicher."
      : "ohmail schickt diese Mail einmal bei 90 % und einmal, wenn der Speicher voll ist. Abschalten kannst du Speicher-Mails unter Einstellungen › Speicher.",
  } : {
    subject: full ? "Your ohmail storage is full" : "Your ohmail storage is 90% full",
    title: full ? "Your storage is full." : "Your storage is 90% full.",
    action: "Choose storage",
    counts: "Only the text of your mail counts. Attachments never do.",
    stop: full ? "This is the last storage mail until something changes. To stop storage mails, turn them off in Settings › Storage."
      : "ohmail sends this mail once at 90% and once when storage is full. To stop storage mails, turn them off in Settings › Storage.",
  };
  return {
    lang,
    subject: c.subject,
    title: c.title,
    blocks: [p({ b: used }, usedTail, ...needRuns), p(what), p({ b: choice }, fitTail)],
    action: { label: c.action, url },
    footer: [noButton(lang, url), line(c.counts), line(c.stop), line(COMPANY[lang])],
    replyTo: d.supportEmail,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry — the single place the set is enumerated.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Template name → its data shape — the contract `MailerPort.send` is generic over, so a caller
 * cannot pass invite data to the verification template. The set is closed on purpose: adding an
 * entry is a product decision, argued at its definition. What may never happen: an entry whose data
 * shape can carry arbitrary text into an outbound message from our domain, or a `send` overload that
 * skips this map. `operator_alert` and `operator_digest` are not customer mail.
 */
export interface TemplateDataMap {
  waitlist_confirmation: WaitlistConfirmationData;
  invite: InviteData;
  new_device_signin: NewDeviceSignInData;
  security_notice: SecurityNoticeData;
  email_verification: EmailVerificationData;
  operator_alert: OperatorAlertData;
  operator_digest: OperatorDigestData;
  account_exists: AccountExistsData;
  lifecycle_notice: LifecycleNoticeData;
  billing_link: BillingLinkData;
  connect_reminder: ConnectReminderData;
  storage_near: StorageNoticeData;
  storage_full: StorageNoticeData;
}

export type TemplateName = keyof TemplateDataMap;

const framed = <T>(words: (d: T) => MailDoc) => (d: T): RenderedEmail => renderDoc(words(d));

const RENDERERS: { [K in TemplateName]: (data: TemplateDataMap[K]) => RenderedEmail } = {
  waitlist_confirmation: framed(waitlistConfirmation),
  invite: framed(invite),
  new_device_signin: framed(newDeviceSignIn),
  security_notice: framed(securityNotice),
  email_verification: framed(emailVerification),
  operator_alert: operatorAlert,
  operator_digest: operatorDigest,
  account_exists: framed(accountExists),
  lifecycle_notice: framed(lifecycleNotice),
  billing_link: framed(billingLink),
  connect_reminder: framed(connectReminder),
  storage_near: framed((d: StorageNoticeData) => storageNotice("near", d)),
  storage_full: framed((d: StorageNoticeData) => storageNotice("full", d)),
};

export const TEMPLATE_NAMES = Object.keys(RENDERERS) as TemplateName[];

/** Render one template. Throws only on invalid data (a bad URL); `MailerPort.send` catches. */
export function renderTemplate<K extends TemplateName>(
  template: K, data: TemplateDataMap[K],
): RenderedEmail {
  const render = RENDERERS[template] as ((d: TemplateDataMap[K]) => RenderedEmail) | undefined;
  if (!render) throw new Error(`mail: unknown template ${JSON.stringify(template)}`);
  return render(data);
}
