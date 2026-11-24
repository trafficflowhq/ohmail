/**
 * THE SIGNATURE ON AN OUTGOING MESSAGE — re-exported from `@ohmail/client-engine/signature`, where the model and the
 * serialization now live (moved when the mobile composer gained the block: React Native cannot import the web shell,
 * where this file then stood, and a mirrored copy would be the divergence the one-derivation rule exists to prevent).
 */

/**
 * The whole contract — the follows-From state model, the exactly-as-shown serialization, the whitespace and tab-stop
 * encoding — is documented on the module itself. This file stays as the one name the composer and the screens that
 * draw the block read it by (`SignatureBlock` and the editors that draw the block), exactly
 * like the types `live.ts` re-exports on the phone: one implementation, one extra name.
 */
export {
  SIG_FOLLOWING,
  effectiveSignature,
  effectiveSignatureHtml,
  signatureHtml,
  withSignature,
  type SignatureState,
} from "@ohmail/client-engine";
