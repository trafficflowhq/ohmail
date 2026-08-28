/**
 * THE SIGNATURE ON AN OUTGOING MESSAGE — re-exported from `@ohmail/client-engine/signature`,
 * where the model and the serialization now live (moved when the mobile composer gained the
 * block: React Native cannot import this shell, and a mirrored copy would be the divergence
 * the one-derivation rule exists to prevent). The whole contract — the follows-From state
 * model, the exactly-as-shown serialization, the whitespace and tab-stop encoding — is
 * documented on the module itself.
 *
 * This file stays so the shell's importers (`AppShell`, `SignatureBlock`, `InlineReply`,
 * `compose.ts`, `mail-send.ts`, `message-chrome.tsx`) keep their local path, exactly like the
 * types `live.ts` re-exports on the phone: one implementation, one extra name.
 */
export {
  SIG_FOLLOWING,
  effectiveSignature,
  signatureHtml,
  withSignature,
  type SignatureState,
} from "@ohmail/client-engine";
