/**
 * WHAT THE FORM SAYS WHERE A PHONE OPENS ITS OWN MAILBOX (the purpose `standalone`). The phone's native side refuses
 * with a code, and the phone's catalogue holds that code's sentence (`phoneRefusal`). The form says that sentence
 * and nothing that crossed with the refusal: a wire of this purpose hands on no words, so nothing a mail server or
 * a platform said, and nothing that could repeat what was typed, is ever drawn here.
 *
 * A sentence's places are filled from this side alone: the provider's two names from the provider table, where the
 * sentence names the provider, and nothing everywhere else.
 */
import { authHintPreset } from "./providers.js";
import type { Said } from "./refusal.js";
import type { Refusal } from "./types.js";

/** A code is one plain key of the phone's refusals: never a path into them, never a name every object carries. */
const PLAIN = /^[a-z][A-Za-z0-9]{0,63}$/;
/** The sentence for a code the catalogue does not hold, and for no answer at all. */
const UNKNOWN = "unknown";
/** A sentence of the phone's refusals has at most six places. Each is said empty unless this side knows it. */
const NOTHING = Object.freeze({ 0: "", 1: "", 2: "", 3: "", 4: "", 5: "" });
/** The refused sign-ins whose sentence names the provider and its account: the provider table's own two names. */
const NAMES_THE_PROVIDER: ReadonlySet<string> = new Set([
  "standaloneAuthAppOnly",
  "standaloneAuthInvalid",
  "standaloneAuthWebLogin",
  "standaloneAuthImapDisabled",
]);
/** This build cannot say why: no answer, a code that is no key, and the rows a phone's wire never reaches. */
export const STANDALONE_UNKNOWN: Said = Object.freeze({ ns: "phoneRefusal", key: UNKNOWN });

/** A name that cannot be stored: more than a hundred characters, or more than one line. Nothing was sent. */
export const NAME_REFUSED: Said = Object.freeze({ ns: "phoneRefusal", key: "standaloneNameRefused" });

/**
 * A refused open, as the sentence of its code. `orElse` is said where this build's catalogue has no sentence for the
 * code, and where its sentence is nothing but a place this side fills with nothing.
 */
export function standaloneSaid(r: Refusal): Said {
  const code = r.code;
  if (code === null || code === UNKNOWN || !PLAIN.test(code) || code in Object.prototype)
    return STANDALONE_UNKNOWN;
  if (!NAMES_THE_PROVIDER.has(code))
    return { ns: "phoneRefusal", key: code, values: NOTHING, orElse: UNKNOWN };
  const preset = authHintPreset();
  return {
    ns: "phoneRefusal",
    key: code,
    values: { ...NOTHING, 0: preset.label, 1: preset.account ?? preset.label },
    orElse: UNKNOWN,
  };
}
