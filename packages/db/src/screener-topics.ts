import type { ScreenerTopic } from "@ohmail/wire";

/** Matching subject wording is a fallback for advice stored before the model returned a topic. */
const TOPIC_WORDS = {
  receipt: /\b(?:receipts?|kaufbelege?|quittung(?:en)?)\b/iu,
  invoice: /\b(?:invoices?|bills?|rechnung(?:en)?)\b/iu,
  order: /\b(?:order confirmations?|orders?|bestellbestätigung(?:en)?|bestellungen?)\b/iu,
  delivery: /\b(?:deliver(?:y|ies)|shipping|shipments?|versand(?:meldung(?:en)?)?|lieferstatus)\b/iu,
  travel: /\b(?:bookings?|reservations?|flights?|travel|buchung(?:en)?|reservierung(?:en)?|reise(?:n)?)\b/iu,
  newsletter: /\bnewsletters?\b/iu,
  promotion: /\b(?:promotions?|(?:special )?offers?|sonderangebote?|angebote?|werbung)\b/iu,
  webinar: /\bwebinar(?:s|einladung(?:en)?|[- ]einladung(?:en)?)?\b/iu,
  event: /\b(?:events?|veranstaltung(?:seinladung(?:en)?|en)?)\b/iu,
  social: /\b(?:social (?:media|notifications?)|soziale netzwerke|social.media)\b/iu,
  job: /\b(?:job alerts?|job postings?|stellenangebote?|jobbenachrichtigung(?:en)?)\b/iu,
  survey: /\b(?:surveys?|umfragen?)\b/iu,
  security: /\b(?:security|account notices?|login|sicherheit(?:shinweis(?:e)?)?|kontohinweis(?:e)?)\b/iu,
  family: /\b(?:school|family|schule|familie)\b/iu,
  banking: /\b(?:banking|bank statements?|kontoauszüg(?:e|en)|kontoauszug)\b/iu,
  health: /\b(?:health|medical|gesundheit|arzttermin(?:e)?)\b/iu,
  government: /\b(?:government|tax notices?|behörden?|steuerbescheid(?:e)?)\b/iu,
  subscription: /\b(?:subscriptions?|abonnements?|abos?)\b/iu,
  community: /\b(?:communities|community|clubs?|vereine?|gemeinschaft(?:en)?)\b/iu,
  personal: /\b(?:personal (?:messages?|mail|threads?)|persönliche (?:nachrichten|post))\b/iu,
  work: /\b(?:work (?:threads?|mail|conversations?)|berufliche (?:nachrichten|gespräche))\b/iu,
} satisfies Record<Exclude<ScreenerTopic, "other">, RegExp>;
const TOPICS = Object.keys(TOPIC_WORDS) as (keyof typeof TOPIC_WORDS)[];

export function isScreenerTopic(value: unknown): value is ScreenerTopic {
  return value === "other" || typeof value === "string" && Object.hasOwn(TOPIC_WORDS, value);
}

export function matchingScreenerTopics(text: string): ScreenerTopic[] {
  return TOPICS.filter(topic => TOPIC_WORDS[topic].test(text));
}

export function screenerTopic(subject: string): ScreenerTopic {
  const matches = matchingScreenerTopics(subject);
  return matches.length === 1 ? matches[0]! : "other";
}

export function screenerLessonKind(chosen: string, suggested: string | null, previous: string | null) {
  if (previous !== null && previous !== chosen) return "reversal";
  if (suggested === null) return "independent";
  return suggested === chosen ? "confirmation" : "correction";
}
