/**
 * TYPES NO WHOLE-MIRROR DERIVATION READS — the deny list a shell's derived stamp asks with
 * (`reader.stampExcept(NOT_DERIVED_FROM)`), one list for the web and the phone.
 *
 * A `message_body` is read one message at a time, by id, at the moment a surface draws it; no
 * pile, count, partition or projection lists them. Everything else the mirror holds is fair game
 * for a derivation, which is why this is a DENY list: a type added later is watched by default,
 * and the day a selector learns to read bodies the honest failure is a needless rebuild. A surface
 * that draws a body subscribes to the body stamp itself.
 */
export const NOT_DERIVED_FROM: readonly string[] = ["message_body"];
