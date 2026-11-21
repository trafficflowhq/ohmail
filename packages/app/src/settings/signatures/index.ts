/** Settings › Signatures: the pane draws a `SignaturesModel` the shell builds from the consent row. */
export { SignaturesPane, type SignaturesPaneProps } from "./SignaturesPane.js";
export { SignatureEditor } from "./SignatureEditor.js";
export {
  isDirty,
  signatureWrite,
  type RichValue,
  type SignatureEditorProps,
  type SignaturesMailbox,
  type SignaturesModel,
} from "./model.js";
export { SIGNATURES_NAMESPACE } from "./namespace.js";
export { SIGNATURES_STATES, SIGNATURES_TYPED, signaturesState } from "./states.js";
export { useSignaturesModel } from "./use-signatures.js";
