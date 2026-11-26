import {
  decodeEntities, foldDigits, GERMAN_SECRET_NOUN, hasCredentialMailCue, hasCredentialSenderCue, hasGermanSignInCue,
  hasModelAuthContext, hasModelBrandedCode, hasModelCodeCue, hasModelCompoundCodeLabel,
  hasModelInvitationCue, hasModelLinkCue, MODEL_ACRONYM, MODEL_LOGIN_WORDS,
  MODEL_RESET_WORDS, MODEL_URL, readableBase64Text, redactIssuedPassword,
} from "./sensitive.js";

const WEB_LINK = /(https?:\/\/[^\s<>"'\x60()[\]]+)/gi;
export const MESSAGE_PREVIEW_LIMIT = 200;
const RESET_PATH = new RegExp("^(?:reset(?:[-_]?password)?|password[-_]reset|recover(?:y)?"
  + "|(?:" + GERMAN_SECRET_NOUN + "[-_]?)?(?:zurücksetzen|zuruecksetzen)|" + GERMAN_SECRET_NOUN + "[-_]vergessen)$", "iu");
const AUTH_PATH = /^(?:auth|authenticate|session|log[-_]?in|sign[-_]?in|magic(?:[-_]?(?:login|link))?|passwordless|verify(?:[-_](?:email|account))?|verification|confirm(?:[-_]email)?|activate|otp|accept[-_]invite)$/i;
const UTILITY_PATH = /^(?:unsub(?:scribe)?|opt[-_]?out|preferences|subscriptions?|articles?|blog|news|help|docs|support)$/i;
const CREDENTIAL_PARAM = /^(?:access_token|id_token|refresh_token|reset_token|verification_token|confirmation_token|login_token|auth_token|magic_token|token_hash|oobcode|otp)$/i;
const AUTH_LANDING_PATH = /^(?:account|access|continue|callback|link)$/i;
const AUTH_PARAM = /^(?:token|code|key|t|tk|sso|auth|session|nonce|secret|ticket|bearer)$/i;
const WRAPPED_PARAM = /^(?:url|u|redirect|redirect_url|redirect_uri|target|destination|to|upn)$/i;
const EMBEDDED_BASE64 = /[A-Za-z0-9+/]{16,}={0,2}/g;
const TRACKER_PATH = /^(?:click|track|redirect|link)$/i;
const OPAQUE_PATH_VALUE = /^(?:[a-f\d]{16,}|(?=[\w.~%+-]{6,}$)(?=.*\d)(?=.*[a-z])[\w.~%+-]+|[A-Z\d_-]{12,})$/;
const POSITIONAL_CREDENTIAL = /^(?:\d{4,}|[a-z]{12,})$/i;
const EXTRA_CREDENTIAL_PARAM = /^(?:reset_password_token|password_reset_token|invitation_token|unlock_token)$/i;
const EXTRA_RESET_PATH = new RegExp("password|" + GERMAN_SECRET_NOUN + "|reset|forgot", "i");
const EXTRA_AUTH_PATH = new RegExp(EXTRA_RESET_PATH.source + "|login|signin|magic|verify|confirm", "i");
const INVITE_PATH = /^(?:(?:(?:shared|team)[-_])?invites?|invitations?|einladungen|einladung|join|redeem)$/i;

type LinkPlaceholder = "[sign-in link]" | "[reset link]";

function decodePart(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function authRoute(segments: string[]): number {
  const action = segments.findIndex(segment => AUTH_PATH.test(segment) || RESET_PATH.test(segment));
  return segments.some((segment, index) => (action === -1 || index < action) && UTILITY_PATH.test(segment)) ? -1 : action;
}

function credentialLink(raw: string, auth: boolean, reset: boolean, wrapperDepth = 2): LinkPlaceholder | undefined {
  let url: URL;
  try { url = new URL(raw.replace(/&(?:amp|#38|#x26);/gi, "&")); } catch { return undefined; }
  const segments = decodePart(url.pathname).split("/").filter(Boolean);
  const fragment = url.hash.slice(1);
  const queryStart = fragment.indexOf("?");
  const fragmentRoute = decodePart(queryStart === -1 ? fragment : fragment.slice(0, queryStart));
  const fragmentIsRoute = fragmentRoute.startsWith("/")
    || (!fragmentRoute.includes("=") && (fragmentRoute.includes("/") || queryStart !== -1));
  const routes = [segments, fragmentIsRoute ? fragmentRoute.split("/").filter(Boolean) : []];
  const actions = routes.map(authRoute);
  const pathAuth = actions.some(action => action !== -1);
  const contextualLanding = (auth || reset) && (!segments.length || AUTH_LANDING_PATH.test(segments.at(-1)!));
  const pathReset = routes.some((route, index) => actions[index] !== -1 && route.some(segment => RESET_PATH.test(segment)));
  const fragmentParams = fragmentIsRoute ? (queryStart === -1 ? "" : fragment.slice(queryStart + 1)) : fragment;
  const params = [...url.searchParams, ...new URLSearchParams(fragmentParams)];
  const trackerInAuthMail = (auth || reset) && segments.some(segment => TRACKER_PATH.test(segment));
  let opaqueWrapper = false;
  // Wrappers can carry a percent-escaped URL. Inspect it even on a utility path.
  for (const [key, value] of params) {
    if (!WRAPPED_PARAM.test(key)) continue;
    const decoded = /^https?:\/\//i.test(value) ? value : decodePart(value);
    const target = /^https?:\/\//i.test(decoded) ? decoded : readableBase64Text(value);
    if (target && /^https?:\/\//i.test(target)) {
      const nested = wrapperDepth ? credentialLink(target, auth, reset, wrapperDepth - 1) : undefined;
      if (nested) return nested;
    } else if (trackerInAuthMail && OPAQUE_PATH_VALUE.test(value)) {
      opaqueWrapper = true;
    }
  }
  const utilityOnly = !pathAuth && routes.some(route => route.some(segment => UTILITY_PATH.test(segment)));
  if (!utilityOnly) {
    const resetParam = params.some(([key, value]) => value && (/^reset_token$/i.test(key)
      || (/^(?:mode|type|action)$/i.test(key) && /^(?:recovery|reset(?:[_-]?password)?)$/i.test(value))));
    const bearerParam = params.some(([key, value]) => value && (CREDENTIAL_PARAM.test(key)
      || ((pathAuth || contextualLanding || resetParam) && AUTH_PARAM.test(key))));
    const bearerPath = routes.some((route, index) => {
      const action = actions[index]!;
      return action !== -1 && route.slice(action + 1).some(segment =>
        OPAQUE_PATH_VALUE.test(segment) || POSITIONAL_CREDENTIAL.test(segment));
    });
    if (bearerParam || bearerPath || opaqueWrapper) {
      return pathReset || resetParam || (reset && !pathAuth) ? "[reset link]" : "[sign-in link]";
    }
  }

  const explicit = params.find(([key, value]) => value && EXTRA_CREDENTIAL_PARAM.test(key));
  if (explicit) return /password/i.test(explicit[0]) ? "[reset link]" : "[sign-in link]";
  const inviteQuery = params.some(([key, value]) => value && AUTH_PARAM.test(key));
  for (const route of routes) {
    // A token directly after a compound auth action, including actions like wp-login.php.
    const utility = route.findIndex(segment => UTILITY_PATH.test(segment));
    const action = route.findIndex((segment, index) => {
      const next = route[index + 1] ?? "";
      return (utility === -1 || index < utility) && (
        INVITE_PATH.test(segment) && (inviteQuery || OPAQUE_PATH_VALUE.test(next))
        || EXTRA_AUTH_PATH.test(segment) && (OPAQUE_PATH_VALUE.test(next) || POSITIONAL_CREDENTIAL.test(next))
      );
    });
    if (action !== -1) return EXTRA_RESET_PATH.test(route[action]!) ? "[reset link]" : "[sign-in link]";
  }
}

// Spaces can join numeric chunks or uppercase/mixed code chunks. Dashes can join any code chunks.
const CODE_CHUNK = `(?:(?!${MODEL_ACRONYM.source})[\\p{Lu}]{2,12}|[\\p{L}]{0,11}\\p{Nd}[\\p{L}\\p{Nd}]{0,11})`;
const BROAD_CODE = new RegExp(
  "(?<![\\p{L}\\p{N}_@])(?:" +
  `${CODE_CHUNK}(?:[\\p{Zs}\\p{Pd}\\t]+${CODE_CHUNK})+(?![\\p{Pd}])|` +
  "[\\p{L}\\p{Nd}]+(?:\\p{Pd}[\\p{L}\\p{Nd}]+)*)(?![\\p{L}\\p{N}_@])",
  "gu",
);
const SPLIT_DIGITS = /(?<![\p{L}\p{N}_@])\p{Nd}+(?:[ \t]*\r?\n[ \t\r\n]*\p{Nd}+)+(?![\p{L}\p{N}_@])/gu;
const BODY_NUMERIC_CODE = /^\p{Nd}(?:[\s-]*\p{Nd}){3,11}$/u;

function redactBroadCodes(text: string, previewAtLimit: boolean): string {
  const mask = (value: string, min = 4) => {
    if (min === 4 && !/\p{Nd}/u.test(value)) return value;
    const length = [...value.replace(/[^\p{L}\p{Nd}]/gu, "")].length;
    return length >= min && length <= 12 ? "[code]" : value;
  };
  return redactIssuedPassword(text).replace(BROAD_CODE, (value: string, offset: number, source: string) => {
    const min = previewAtLimit && offset + value.length === source.length ? 3 : 4;
    const masked = mask(value, min);
    if (masked !== value) return masked;
    // Preserve dash groups when a list of adjacent codes exceeds the length limit.
    return value.replace(/[^\p{Zs}\t]+/gu, (group: string, at: number) => {
      const groupMin = at + group.length === value.length ? min : 4;
      const maskedGroup = mask(group, groupMin);
      return maskedGroup !== group ? maskedGroup
        : group.replace(/[\p{L}\p{Nd}]+/gu, (part: string, start: number) =>
          mask(part, start + part.length === group.length ? groupMin : 4));
    });
  });
}

function linkHost(link: string): string {
  try {
    const { protocol, host } = new URL(link);
    return host ? `${protocol}//${host}/[link]` : "[link]";
  } catch {
    return "[link]";
  }
}

const CANDIDATE =
  /(?<![\p{L}\p{N}_#€$£+@/-])(?:(?:%[\da-fA-F]{2}){4,48}|(?:&#(?:x[\da-fA-F]{1,6}|\d{1,7});){4,48}|[A-Za-z\d+/]{6,24}={1,2}|eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}|\p{Nd}{2,4}(?:[ -]\p{Nd}{2,4}){1,3}|\p{Nd}{4,8}|[A-Za-z\d]+(?:[-_][A-Za-z\d]+)*)(?![\p{L}\p{N}_@/-])/gu;
const CODE_JOIN = /(?:[\s:：=*`(\[“"'–—>-]|\b(?:is|ist|lautet|est|è|es|é|sind|d[ei] la|für die anmeldung)\b)+$/iu;
const CODE_INTRO = /\b(?:(?:enter(?:ing)?|use|type) (?:(?:the|this) )?(?:(?:verification|sign-in|one-time) )?code (?:below|above)|(?:here|this) is (?:the|your) (?:(?:verification|sign-in|one-time) )?code(?: you need)?|verwenden sie (?:den )?code (?:unten|oben))[.!:]?$/iu;
const CODE_SUFFIX = /^[\t *\x60"']*(?:(?:is|ist)\s+(?:(?:your|dein|ihr|der)\s+)?([^\n!,.;?]{1,48})|(?:to\s+(?:sign[\s-]*in|log[\s-]*in|verify|authenticate)|zum\s+(?:anmelden|einloggen|bestätigen))\b)/iu;
const USE_CODE = /\b(?:use|enter|type|verwende(?:n|st|t)?(?: sie)?|gib|geben sie)\s+[*\x60"']*$/iu;
const LABELED_TOKEN = /\b(?:reset|verification|login|sign[- ]in|auth(?:entication)?|recovery|access|bestätigungs|anmelde)[- ]*token\b|\b(?:your code|dein code|ihr code|(?:einmalige|einmal verwendbare) (?:ziffern|zahlen)folge)\b/iu;
const END_LABELED_TOKEN = new RegExp("(?:" + LABELED_TOKEN.source + ")$", "iu");
const LEADING_SPACE = /^[\s:：=*"'`(\[{–—>-]*$/u;
const CONTEXTUAL_LABEL = new RegExp("(?:(?:^|[.!?;\\n])\\s*|\\b(?:the (?:following )?|den (?:folgenden )?|diesen ))"
  + "(?:code|token|passcode|" + GERMAN_SECRET_NOUN + ")\\b$", "iu");
const CREDENTIAL_CONTINUATION = /^[\s>]*(?:(?:it |this code )?expires|it is valid|is (?:valid|your)|gilt|läuft ab)\b/iu;
const POSITIVE_CODE_CONTEXT = /\b(?:(?:enter|use|type) (?:the|this|your) (?:verification|one-time|sign-in) code\b|here is (?:the|your) (?:(?:verification|sign-in|one-time) )?code\b|(?:verification|one-time|sign-in) code\s*[:=])/iu;
const TOKEN_END = /^(?:$|[.,;!?)}\]\s]*$|[.;!?]\s)/u;
const DATE_PREFIX = /\d[./-]$/u;
const MONEY_SUFFIX = /^[.,]\p{Nd}|^\s*(?:€|\$|£|EUR\b|USD\b|CHF\b)/iu;
const DATE_VALUE = /^\d{4}[- ]\d{2}[- ]\d{2}$/;

function codeCue(value: string, atEnd = false, includeAcronyms = true): boolean {
  return hasModelCodeCue(value, atEnd, includeAcronyms) || (atEnd ? END_LABELED_TOKEN : LABELED_TOKEN).test(value)
    || hasModelBrandedCode(value, atEnd);
}

function acronymCanPair(separator: string): boolean {
  return !/[\r\n]/u.test(separator) || /^[ \t]*[:：](?:[ \t]*\r?\n){1,2}[ \t]*$/u.test(separator);
}

function looksLikePlainCode(value: string): boolean {
  const numeric = foldDigits(value);
  if (/^[\d -]+$/.test(numeric)) {
    const count = numeric.replace(/\D/g, "").length;
    return count >= 4 && count <= 8 && !DATE_VALUE.test(numeric);
  }
  if (value.length < 4) return false;
  return (/[a-z]/i.test(value) && /\d/.test(value)) || /^eyJ[\w-]+\./.test(value) || /^[a-f\d]{16,}$/i.test(value)
    || /^[A-Z]{4,12}$/.test(value) || /^[A-Za-z]+(?:[-_][A-Za-z]+)+$/.test(value);
}

function looksLikeCode(value: string): boolean {
  if (value.startsWith("%")) return looksLikePlainCode(decodePart(value));
  if (value.startsWith("&#")) return looksLikePlainCode(decodeEntities(value));
  if (looksLikePlainCode(value)) return true;
  if (!/^[A-Za-z\d+/]{6,24}={0,2}$/.test(value)) return false;
  try {
    return looksLikePlainCode(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return false;
  }
}

const LETTER_CODE = /(?<![\p{L}\p{N}@_/-])\p{L}{5,10}(?![\p{L}\p{N}@_/-])/gu;
const LETTER_VALUE = /^\p{L}{5,10}$/u;
const PROSE_AFTER_LABEL = new Set([
  "above", "appears", "arrives", "available", "below", "changed", "expired", "expires", "follows", "invalid",
  "listed", "message", "needed", "notification", "ready", "request", "required", "should", "shown", "thanks", "works",
  "abholung", "angefordert", "anfordern", "bleibt", "eingeben", "erscheint", "fehlt", "folgt", "gehört", "gilt",
  "gültig", "kommt", "läuft", "lautet", "nicht", "stimmt", "ungültig", "unten", "verfällt", "verwenden", "wurde",
]);
const SIGNATURE = /(?:^|\r?\n)[ \t]*(?:regards|best regards|thanks|sincerely|mit freundlichen grüßen|viele grüße|gruss|gruß)[ \t,]*(?:\r?\n|$)/iu;
const VALUE_FOLLOWS_LABEL = /(?:\b(?:code|passcode)|\bcode (?:below|above))\b[ \t]*(?:[.!:]|(?:is|ist|lautet)[ \t]*:?)?[\s>*]*$/iu;
const BARE_CODE_LABEL = /\b(?:code|passcode|code (?:below|above)[.!]?)[\s>*]+$/iu;
const CODE_FOLLOWUP = /^(?:,\s*|\s+(?:and\s+)?)(?:enter it|it expires|it is valid|if this|don't share)\b/iu;
const CODE_DELIMITER = /(?:[:：=]|\blautet)[\s>*]*$/iu;
const CODE_COPULA = /\b(?:is|ist)[\s>*]*$/iu;
const DELIMITED_CODE_PHRASE = /\b(?:code|passcode)\b[^.!?;:\n]{0,70}[:：][\s>*]*$/iu;
const VALUE_END = /^[^\S\n]*(?:[.!?]|$|\r?\n)/u;

function labeledLetterCode(value: string, before: string, after: string, credentialContext: boolean): boolean {
  const delimited = CODE_DELIMITER.test(before);
  const attached = delimited || CODE_COPULA.test(before);
  const label = before.replace(CODE_JOIN, "");
  const separator = before.slice(label.length);
  const onNewLine = /[\r\n]/u.test(separator);
  // Preserve known prose after an inline label in a sentence or a flattened preview.
  if (!delimited && !onNewLine && /^\p{Lu}?\p{Ll}+$/u.test(value) && PROSE_AFTER_LABEL.has(value.toLowerCase())) return false;
  const compound = credentialContext && hasModelCompoundCodeLabel(label);
  if (DELIMITED_CODE_PHRASE.test(before) || (attached && (codeCue(label, true, acronymCanPair(separator)) || compound))) return true;
  if (!VALUE_FOLLOWS_LABEL.test(before) && !compound) return false;
  // A known credential can have a bare label in a flattened preview between unrelated sentences.
  return attached || onNewLine || VALUE_END.test(after) || CODE_FOLLOWUP.test(after)
    || (credentialContext && (BARE_CODE_LABEL.test(before) || (compound && /^[\s>*]+$/u.test(separator))));
}

function redactLetterCodes(text: string, part?: { first: boolean; last: boolean }): string {
  const signature = part ? SIGNATURE.exec(text)?.index ?? text.length : 0;
  return text.replace(LETTER_CODE, (value: string, at: number) => {
    const before = text.slice(Math.max(0, at - 100), at);
    const after = text.slice(at + value.length, at + value.length + 70);
    const startsText = part?.first && at === before.length && /^\s*$/u.test(before);
    const startsLine = startsText || /\n[ \t]*$/u.test(before);
    const endsLine = /^[ \t]*\r?\n/u.test(after) || (part?.last && at + value.length + after.length === text.length
      && /^[ \t]*$/u.test(after));
    const ownLine = startsLine && endsLine && at < signature && !/^anmeldung$/iu.test(value);
    const leading = part && /^\s*$/u.test(before) && CODE_FOLLOWUP.test(after);
    return ownLine || leading || labeledLetterCode(value, before, after, true) ? "[code]" : value;
  });
}

const FOOTER_CUE = /\b(?:never (?:ask|share|give|send)|do not share|don't share|niemals|fordern sie niemals)\b/iu;
const INCIDENTAL_SUBJECT = new RegExp("\\b(?:age verification|tan-verfahren|account recovery webinars?|"
  + "rolling out (?:two[- ]factor|" + "2" + "fa))\\b", "giu");
const CODE_LABEL = new RegExp("\\b(?:[\\p{L}-]*(?:code|tan)s?|otp|token|pin|passwords?|" + GERMAN_SECRET_NOUN + ")\\b", "iu");
const BODY_CODE = new RegExp("(?<![\\p{L}\\p{N}])\\p{Nd}(?:[ \\t]+\\p{Nd}){3,11}(?![\\p{L}\\p{N}]|[ \\t]+\\p{Nd}\\b)|"
  + SPLIT_DIGITS.source + "|" + CANDIDATE.source, "gu");

const CODE_LABEL_END = /(?:[:：=.!]|\b(?:is|ist|lautet))[\s>*:]*$/iu;
const GERMAN_SIGN_IN_CONFIRMATION = /\banmeldung\s+bestätigt(?:[\s:：]+(?:code|link)\b)?[\s:：]*$/iu;

function bodyHasCode(text: string, authContext: boolean): boolean {
  if (redactIssuedPassword(text) !== text) return true;
  for (const match of text.matchAll(BODY_CODE)) {
    const value = match[0];
    const at = match.index;
    const before = text.slice(Math.max(0, at - 100), at);
    const after = text.slice(at + value.length, at + value.length + 100);
    if (FOOTER_CUE.test(before) || DATE_PREFIX.test(before) || MONEY_SUFFIX.test(after)) continue;
    const numericCode = BODY_NUMERIC_CODE.test(value) && !DATE_VALUE.test(foldDigits(value));
    if (!looksLikeCode(value) && !numericCode
      && !(LETTER_VALUE.test(value) && labeledLetterCode(value, before, after, authContext))) continue;
    const label = before.replace(CODE_JOIN, "");
    const pairAcronym = acronymCanPair(before.slice(label.length));
    const suffix = CODE_SUFFIX.exec(after);
    if (suffix && (suffix[1] ? hasCredentialMailCue(suffix[0], !/[\r\n]/u.test(suffix[0])) : USE_CODE.test(before))) return true;
    const delimited = CODE_LABEL_END.test(before);
    if (CODE_INTRO.test(label) || codeCue(label, true, pairAcronym) || (authContext && hasModelCompoundCodeLabel(label))) return true;
    if (GERMAN_SIGN_IN_CONFIRMATION.test(before) || (CODE_DELIMITER.test(before) && hasGermanSignInCue(label))) return true;
    if (delimited && CODE_LABEL.test(label) && hasCredentialMailCue(label, pairAcronym)) return true;
  }
  return false;
}

function bodyHasLink(label: string, link: string): boolean {
  // Consider the clause introducing this URL. Navigation and unrelated article titles carry no credential.
  const end = label.trimEnd();
  const nearby = end.match(/[^.!?;\n]{1,120}$/u)?.[0] ?? "";
  if (FOOTER_CUE.test(nearby)) return false;
  if (hasModelLinkCue(nearby) || /\b(?:sign|log)[- ]?in (?:here|below):?$/iu.test(nearby)) return true;
  const germanContext = end.match(/[^.!?;]{1,120}$/u)?.[0] ?? "";
  if (hasGermanSignInCue(germanContext) || GERMAN_SIGN_IN_CONFIRMATION.test(germanContext)) return true;
  if (!hasModelInvitationCue(nearby)) return false;
  try {
    return decodePart(new URL(link).pathname).split("/").some(segment => INVITE_PATH.test(segment));
  } catch {
    return false;
  }
}

function hasCredentialBodyCue(text: string): boolean {
  const parts = text.split(MODEL_URL);
  const authContext = parts.some((part, index) => index % 2 === 0 && part.split(/[.!?;\r\n]/u)
    .some(clause => !FOOTER_CUE.test(clause) && hasModelAuthContext(clause)));
  return parts.some((part, index) => index % 2 ? bodyHasLink(parts[index - 1]!, part) : bodyHasCode(part, authContext));
}

const PRIVATE_KEY_BLOCK = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
const BEARER_VALUE = /^([\t >]*(?:proxy-)?authorization[ \t]*:[ \t]*bearer[ \t]+)\S+/gim;
const BACKUP_CODE_VALUE = /^([\t >]*(?:your )?backup code[ \t]*(?:(?:[ \t]+(?:is|ist|lautet)\b)[ \t]*[:=]?|[:=])[ \t]*)(?:"[^"\r\n]+"|'[^'\r\n]+'|\S+)([ \t]*)$/gimu;
const PASSWORD_NAME = /(?:(?:the|your|das|dein|ihr)[ \t]+)?(?<name>password|passphrase|passwort|kennwort)/u;
const FIELD_DELIMITER = /[:：=]/u;
const PASSWORD_VERB = /[ \t]+(?:is|ist|lautet)\b/u;
const PASSWORD_LABEL = new RegExp(String.raw`(?<![^\s>])${PASSWORD_NAME.source}`
  + String.raw`(?:(?:${PASSWORD_VERB.source})?[ \t]*${FIELD_DELIMITER.source}|${PASSWORD_VERB.source})[ \t]*`, "giu");
const NEXT_PASSWORD_FIELD = new RegExp(String.raw`(?<![ \t])[ \t]+(?=${PASSWORD_NAME.source}(?:${PASSWORD_VERB.source})?[ \t]*${FIELD_DELIMITER.source})`, "iu");
const NEXT_USERNAME_FIELD = new RegExp(String.raw`(?<![ \t])[ \t]+(?=(?:user[ \t]?name|benutzername)[ \t]*${FIELD_DELIMITER.source}[ \t]*\S+$)`, "iu");
const QUOTED_PASSWORD = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60|“[^”]*”|‘[^’]*’)/u;
const PASSWORD_GUIDANCE = /^(?:(?:not|always|usually|nicht|immer)[ \t]+)?(?:required|needed|optional|case[- ]sensitive|recommended|erforderlich|notwendig|empfohlen)\b(?=$|[.!?,;]|[ \t]+(?:to|for|before|after|when|if|and|but|um|für|vor|nach|wenn|und|aber)\b)/iu;
const PASSWORD_LENGTH_REQUIREMENT = /^(?:a (?:minimum|maximum) of|at least|at most)[ \t]+[\p{L}\p{Nd}]+(?:-[\p{L}\p{Nd}]+)?[ \t]+characters?(?=$|[.!?,;]|[ \t]+(?:long|in length|and|or)\b)/iu;
const PASSWORD_TOKEN_BEFORE_SENTENCE = /^\S+?(?=[.!?][ \t]+(?:The|This|That|Please|You|We|It)[ \t]+.+[.!?]$)/u;

function maskPasswordValues(text: string): { text: string; complete: boolean } {
  let out = "";
  let from = 0;
  let continuationAt = -1;
  for (const label of text.matchAll(PASSWORD_LABEL)) {
    if (label.index < from) continue;
    const at = label.index + label[0].length;
    const line = text.slice(at).match(/^[^\r\n\u2028\u2029]*/u)![0].trimEnd();
    const delimited = FIELD_DELIMITER.test(label[0]);
    if (!delimited && (PASSWORD_GUIDANCE.test(line) || PASSWORD_LENGTH_REQUIREMENT.test(line))) continue;
    const quoted = /^["'\x60“‘]/u.test(line);
    const quotedValue = quoted ? QUOTED_PASSWORD.exec(line)?.[0] : undefined;
    if ((quoted && quotedValue === undefined) || (!line && at < text.trimEnd().length)) {
      // Its value may continue onto another line. Keep the earlier text and mask the rest.
      return { text: out + text.slice(from, at) + "[code]", complete: false };
    }
    if (!line) continue;
    const continuesValue = label.index === continuationAt;
    out += text.slice(from, at) + "[code]";
    if (quotedValue && !continuesValue) {
      from = at + quotedValue.length;
      continue;
    }
    // A field-like word can be part of an unquoted passphrase. Only split where masking continues.
    const allowProse = !continuesValue && label.groups?.name?.toLowerCase() !== "passphrase";
    const nextPassword = NEXT_PASSWORD_FIELD.exec(line);
    const nextUsername = allowProse ? NEXT_USERNAME_FIELD.exec(line) : null;
    const fieldEnd = Math.min(nextPassword?.index ?? line.length, nextUsername?.index ?? line.length);
    const token = allowProse ? PASSWORD_TOKEN_BEFORE_SENTENCE.exec(line.slice(0, fieldEnd))?.[0] : undefined;
    const singleValue = token && (token === "[code]" || looksLikePlainCode(token));
    from = at + (singleValue ? token.length : fieldEnd);
    if (!singleValue && nextPassword?.index === fieldEnd) continuationAt = from + nextPassword[0].length;
  }
  return { text: out + text.slice(from), complete: true };
}

/** Redact the outgoing copy using nearby wording from the field and its siblings. */
function redactText(text: string, context: string, heading = false, credentialMail = false,
  previewAtLimit = false, decodeEmbedded = true): string {
  const contextAuth = MODEL_LOGIN_WORDS.test(context);
  const contextReset = MODEL_RESET_WORDS.test(context);
  const auth = contextAuth || MODEL_LOGIN_WORDS.test(text);
  const reset = contextReset || MODEL_RESET_WORDS.test(text);
  const contextCode = contextAuth || contextReset || codeCue(context);
  const headingContext = heading && (POSITIVE_CODE_CONTEXT.test(context) || codeCue(context.trimEnd(), true));
  const withoutExplicitSecrets = maskPasswordValues(text.replace(PRIVATE_KEY_BLOCK, "[code]")
    .replace(BEARER_VALUE, "$1[code]").replace(BACKUP_CODE_VALUE, "$1[code]$2")).text;
  // Capture URLs before scanning words so codes inside ordinary links remain undisturbed.
  const parts = withoutExplicitSecrets.split(credentialMail ? MODEL_URL : WEB_LINK);
  return parts.map((part, index) => {
    if (index % 2) {
      const punctuation = part.match(credentialMail ? /[.,;!?)']+$/ : /[.,;!?]+$/)?.[0] ?? "";
      const link = punctuation ? part.slice(0, -punctuation.length) : part;
      if (credentialMail) return linkHost(link) + punctuation;
      const replacement = credentialLink(link, auth, reset);
      return replacement ? replacement + punctuation : part;
    }
    const last = index === parts.length - 1;
    const source = credentialMail
      ? redactBroadCodes(redactLetterCodes(part.replace(SPLIT_DIGITS, value => BODY_NUMERIC_CODE.test(value) ? "[code]" : value),
        heading ? undefined : { first: index === 0, last }), previewAtLimit && last)
      : part;
    const outgoing = source.replace(CANDIDATE, (value: string, offset: number) => {
      if (!looksLikeCode(value)) return value;
      const before = source.slice(Math.max(0, offset - 100), offset);
      const after = source.slice(offset + value.length);
      if (DATE_PREFIX.test(before) || MONEY_SUFFIX.test(after)) return value;
      const prefix = before.replace(CODE_JOIN, "");
      const separator = before.slice(prefix.length);
      const introduced = CODE_INTRO.test(prefix);
      const labeled = codeCue(prefix, true, acronymCanPair(separator))
        || (contextCode && CONTEXTUAL_LABEL.test(prefix));
      const lettersOnly = /^[a-z_-]+$/i.test(value) && looksLikePlainCode(value);
      const delimiter = /[：:=]/u.test(separator);
      // A bare acronym needs credential syntax. A word after a label needs stronger evidence than a number.
      const directlyLabeled = separator && labeled
        && (!/\bPIN$/i.test(prefix) || delimiter || /\b(?:is|ist|lautet)\b/iu.test(separator))
        && (!lettersOnly || delimiter || /[-_]/.test(value) || CREDENTIAL_CONTINUATION.test(after));
      const suffix = CODE_SUFFIX.exec(after);
      const credentialUse = suffix && (suffix[1] ? codeCue(suffix[1], false, !/[\r\n]/u.test(suffix[0]))
        : USE_CODE.test(before) || contextCode);
      const afterValue = after.replace(/^[*\x60"']+/u, "");
      const leading = index === 0 && LEADING_SPACE.test(source.slice(0, offset));
      const leadingCode = leading && (!lettersOnly || value.replace(/[^aeiou]/gi, "").length <= 1)
        && !/^(?:19|20)\d\d$/.test(value);
      const startsPreview = leadingCode && contextCode
        && (TOKEN_END.test(afterValue) || CREDENTIAL_CONTINUATION.test(afterValue) || /^[\s>]*>[\s>]*$/.test(before)
          && /^[^\S\n]*\r?\n/.test(afterValue));
      const startsHeading = leadingCode && headingContext && /^\s+\p{L}/u.test(after);
      const startsNotice = leadingCode && /^\s*[-—–:]\s*(?:your|dein|ihr)\b/iu.test(after)
        && codeCue(after.slice(0, 60));
      return directlyLabeled || introduced || credentialUse || startsPreview || startsHeading || startsNotice ? "[code]" : value;
    });
    if (!decodeEmbedded) return outgoing;
    return outgoing.replace(EMBEDDED_BASE64, encoded => {
      const decoded = readableBase64Text(encoded);
      if (decoded === undefined) return encoded;
      const cleaned = redactText(decoded, context, heading, credentialMail, false, false);
      return cleaned === decoded ? encoded : cleaned;
    });
  }).join("");
}

/** Build a fresh provider payload. Prompt instructions and original mail remain untouched. */
export function redactAiPayload<T>(payload: T, context = ""): T {
  return redactFields(payload, false, context);
}

/** Apply the broader rule to a single outgoing message, using only its own evidence. */
export function redactAiMail<T extends { subject?: string; snippet: string }>(
  mail: T, { fromName, body = mail.snippet, foldSnippet = false }:
    { fromName?: string | null; body?: string; foldSnippet?: boolean } = {},
): T {
  const credentialMail = hasCredentialSubjectCue(mail.subject ?? "", body)
    || hasCredentialSenderCue(fromName ?? "") || hasCredentialBodyCue(body);
  const cleaned = redactFields(mail, credentialMail);
  if (foldSnippet) {
    const folded = cleaned.snippet.replace(/\s+/g, " ").trim();
    // Keep the evidence from the original layout when checking the newly adjacent values.
    cleaned.snippet = credentialMail ? redactText(folded, cleaned.subject ?? "", false, true) : folded;
  }
  return cleaned;
}

/** Use the old excerpt if an explicit password makes the full letter unsafe to share. */
export function redactAiLetter<T extends { subject?: string; snippet: string }>(
  mail: T, { fromName, text }: { fromName?: string | null; text?: string },
): { cleaned: T; full: boolean } {
  const fullText = text !== undefined && maskPasswordValues(text).complete ? text : undefined;
  return {
    cleaned: redactAiMail({ ...mail, snippet: fullText ?? mail.snippet }, { fromName, body: text }),
    full: fullText !== undefined,
  };
}

function hasCredentialSubjectCue(text: string, body: string): boolean {
  const subject = text.replace(INCIDENTAL_SUBJECT, " ");
  return END_LABELED_TOKEN.exec(subject.trim())?.index === 0
    || hasCredentialMailCue(subject) || hasGermanSignInCue(subject.replace(MODEL_URL, " "), body) || hasCredentialBodyCue(subject)
    || (GERMAN_SIGN_IN_CONFIRMATION.test(subject) && hasCredentialBodyCue(subject + "\n" + body));
}

const PASTED_SUBJECT = /(^[ \t]*(?:subject|betreff|fwd?|wg)[ \t]*:[ \t]*|\bforwarding this[ \t]*:[ \t]*)([^\r\n]*)(\r?\n|$)/gimu;

/** Recognize a credential in the person's own draft text with the same evidence as a mail. */
export function redactAiDraftWords<T extends { text: string; subject?: string }>(words: T, context = ""): T {
  const pasted = [...words.text.matchAll(PASTED_SUBJECT)];
  const credentialText = pasted.some((heading, index) => hasCredentialSubjectCue(
    heading[2]!, words.text.slice(heading.index + heading[0].length, pasted[index + 1]?.index),
  )) || hasCredentialSubjectCue(words.subject ?? "", words.text) || hasCredentialBodyCue(words.text);
  if (!pasted.length || !credentialText) return redactFields(words, credentialText, context);

  // Keep pasted headings separate so the letter-code rules can still read the body layout.
  const cleaned = redactFields({ ...words, text: "" }, true, context);
  let text = "";
  let start = 0;
  let nearby = words.subject ?? context;
  for (const [index, heading] of pasted.entries()) {
    text += redactText(words.text.slice(start, heading.index), nearby, false, true);
    start = heading.index + heading[0].length;
    const body = words.text.slice(start, pasted[index + 1]?.index);
    text += heading[1] + redactText(heading[2]!, body, true, true) + heading[3];
    nearby = heading[2] || nearby;
  }
  return { ...cleaned, text: text + redactText(words.text.slice(start), nearby, false, true) };
}

/** Match emitted placeholders, including harmless formatting changes in a provider echo. */
export const AI_REDACTION_PLACEHOLDER = /\[\s*(code|link|sign[-\s]+in\s+link|reset\s+link)\s*\]/iu;

function redactFields<T>(payload: T, credentialMail: boolean, context = ""): T {
  if (typeof payload === "string") return redactText(payload, context, false, credentialMail) as T;
  if (Array.isArray(payload)) return payload.map(value => redactFields(value, credentialMail)) as T;
  if (payload === null || typeof payload !== "object") return payload;
  const fields = payload as Record<string, unknown>;
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (typeof value !== "string") return [key, redactFields(value, credentialMail)];
    const heading = key === "subject" || key === "title";
    const sibling = heading ? fields.snippet ?? fields.content ?? fields.body ?? fields.text
      : /^(?:snippet|body|content|text)$/.test(key) ? fields.subject ?? fields.title : undefined;
    const nearby = typeof sibling === "string" && sibling ? [sibling, context].filter(Boolean).join("\n") : context;
    const previewAtLimit = key === "snippet" && value.length === MESSAGE_PREVIEW_LIMIT;
    return [key, redactText(value, nearby, heading, credentialMail, previewAtLimit)];
  })) as T;
}
