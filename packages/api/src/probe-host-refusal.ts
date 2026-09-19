import { ServiceError } from "@trafficflow/services/mail";

/**
 * THE ADD-TIME HOST REFUSAL, AS THE PERSON WHO TYPED THE ADDRESS READS IT.
 *
 * The SSRF gate says why in its own vocabulary, and `@trafficflow/services` wraps that in a
 * `validation_failed` naming the PARAMETER it was handed — so the connect form printed
 * "u is not a permitted url: host did not resolve" at somebody who had mistyped their IMAP host,
 * the likeliest mistake on that screen. The refusal is right; the sentence is not one. The gate
 * keeps both, and the seam that answers a PERSON maps each class to words, as `dial-host-guard.ts`
 * already does for the refusal a stored mailbox meets at its next dial.
 */

/** Which leg was being checked — the person typed two hosts and only one of them is at fault. */
export type ProbeLeg = "imap" | "smtp";

const LEG: Record<ProbeLeg, { name: string; example: string }> = {
  imap: { name: "incoming (IMAP)", example: "imap.example.com" },
  smtp: { name: "outgoing (SMTP)", example: "smtp.example.com" },
};

/**
 * THE GATE'S SIGNATURE, and the reason this is a match rather than an assumption. Every refusal
 * the gate raises carries it (`SsrfRefusal`: "not a permitted url: <why>"), and nothing else at
 * this seam does — the port cap's refusal is the API's own sentence and passes through untouched.
 * A message carrying this can therefore never reach the wire from here: a class below rewrites
 * it, and a class this table has not met yet still leaves by {@link GENERIC}.
 */
const GATE = "not a permitted url:";

/** Said when the gate refuses for a reason no class below claims — never the gate's own words. */
const GENERIC = (leg: string): string =>
  `That ${leg} server address cannot be used. Check the host name and try again.`;

/**
 * One sentence per refusal class, matched on the gate's own reason. The reasons are core's
 * (`assertPublicHost` and the shape check it calls); they are matched rather than imported
 * because core states them as prose, and the test drives all five THROUGH the real guard so a
 * reworded reason reddens here instead of quietly falling through to {@link GENERIC}.
 */
const CLASSES: ReadonlyArray<{ why: string; say: (leg: string, example: string) => string }> = [
  {
    why: "host is empty",
    say: (leg) => `Enter the ${leg} server address.`,
  },
  {
    why: "host is not a valid dns name",
    say: (leg, example) => `That is not a ${leg} server address. It looks like ${example}.`,
  },
  {
    why: "host did not resolve",
    say: (leg) => `That ${leg} server address could not be found. Check the host name for a typo.`,
  },
  {
    why: "host resolves to a non-public address",
    say: (leg) => `That ${leg} server address points inside a private network and cannot be used here.`,
  },
  {
    why: "host is not public",
    say: (leg) => `That ${leg} server address names this machine or your own network, not a mail server on the internet.`,
  },
];

/**
 * Re-say a host refusal for the connect form, or hand back whatever this was. Applied ONLY to
 * what the probe's host guard throws, so a `ServiceError` reaching it is that guard's; anything
 * without the gate's signature is already a sentence (the port cap's) and is left alone.
 */
export function probeHostRefusal(err: unknown, transport: ProbeLeg): unknown {
  if (!(err instanceof ServiceError) || !err.message.includes(GATE)) return err;
  const { name, example } = LEG[transport];
  const hit = CLASSES.find((c) => err.message.endsWith(c.why));
  const say = hit ? hit.say(name, example) : GENERIC(name);
  return new ServiceError(err.code, err.httpStatus, say, err.details, err.retryable);
}

/**
 * THE SAME GATE, AT THE UNSUBSCRIBE PRESS. The URL is never typed by the person — it comes out of
 * the SENDER's own List-Unsubscribe header — so the gate's `u …` wording named a parameter this
 * route does not even have. The sentence names the sender's link, and there is nothing for the
 * person to go and fix: the press failed because the link is unusable, and nothing was sent.
 */
const LINK_CLASSES: ReadonlyArray<{ why: string; say: string }> = [
  {
    why: "host did not resolve",
    say: "The unsubscribe address this sender provided points at a server that could not be found. Nothing was sent.",
  },
  {
    why: "host resolves to a non-public address",
    say: "The unsubscribe address this sender provided points inside a private network, so it was not contacted.",
  },
  {
    why: "host is not public",
    say: "The unsubscribe address this sender provided points at a private network address, so it was not contacted.",
  },
];

/** Every other class — unparseable, scheme, userinfo, an explicit port — is one fact to a person. */
const LINK_GENERIC =
  "The unsubscribe address this sender provided is not a usable web address. Nothing was sent.";

/** Re-say a one-click link refusal for the person who pressed Unsubscribe, or hand back whatever this was. */
export function unsubscribeLinkRefusal(err: unknown): unknown {
  if (!(err instanceof ServiceError) || !err.message.includes(GATE)) return err;
  const hit = LINK_CLASSES.find((c) => err.message.endsWith(c.why));
  return new ServiceError(err.code, err.httpStatus, hit ? hit.say : LINK_GENERIC, err.details, err.retryable);
}
