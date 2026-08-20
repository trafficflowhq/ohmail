/**
 * The profile-message exhibit — the artifact the Get-ohmail close shows, as DATA, so a
 * test can diff it against the writer in `@trafficflow/core` rather than trust a quote.
 *
 * The portable organizer profile is one RFC822 message in `ohmail/_meta`, and its body
 * opens with a preamble written for whoever finds it in an ordinary mail client. That
 * paragraph — real, shipped, in the product's own voice — says the portability claim
 * better than marketing copy could, so the landing quotes it instead of paraphrasing it.
 *
 * Claims-are-contracts: every string here is a verbatim fact about the message
 * `formatProfileMessage` writes (packages/core/src/adapters/organizer-profile.ts).
 * `test/get-ohmail.test.ts` diffs each one against that source, so a reworded preamble
 * or subject over there goes red here instead of quietly turning the exhibit into
 * fiction. The excerpt joins the preamble's fixed-width lines into one flowing
 * paragraph — same words, same order; only the hard wrapping differs.
 */

/** Where the message lives — `META_FOLDER`, the housekeeping folder the showcase draws. */
export const PROFILE_MESSAGE_FOLDER = "ohmail/_meta";

/** The message's real Subject header, without the label. */
export const PROFILE_MESSAGE_SUBJECT = "ohmail settings for this mailbox";

/** The preamble's first paragraph, verbatim. "YOUR" is capitalized in the message itself. */
export const PROFILE_MESSAGE_EXCERPT =
  "This message stores your ohmail settings for this mailbox: which senders " +
  "you have screened in, your filing rules, notification choices, away reply " +
  "and tag names. Keeping them here means they live in YOUR mailbox — they " +
  "travel with it to any computer or service you connect it from, and they " +
  "remain yours, readable, even if you stop using ohmail.";
