/**
 * The profile-message exhibit — the artifact the Get-ohmail close shows, as DATA, so a test can
 * diff it against the writer in `@trafficflow/core` rather than trust a quote. The portable
 * organizer profile is one RFC822 message in `ohmail/_meta`, and its body opens with a preamble
 * written for whoever finds it in an ordinary mail client — real, shipped, in the product's own
 * voice, so the landing quotes it instead of paraphrasing. Every string here is a verbatim fact
 * about the message `formatProfileMessage` writes; `test/get-ohmail.test.ts` diffs each one, so a
 * reworded preamble goes red here instead of quietly turning the exhibit into fiction. The excerpt
 * joins the fixed-width lines into one paragraph — same words, same order, only the wrapping.
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
