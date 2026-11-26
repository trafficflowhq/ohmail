/**
 * A door's blanks, as the person typed them. The ceremony keeps them (a refusal never loses typed input); the page
 * draws them and hands each change back.
 */
export type Blanks<F extends string> = { readonly [K in F]: string };

/** The shortest password an account takes: the server refuses a shorter one, and the forms said so before the press. */
export const PASSWORD_MIN = 12;

export function passwordLength(value: string): number {
  return [...value].length;
}

/**
 * An account's three blanks are ready to send: an address, a name and a password of the length the server takes.
 * Until then the ink button stays off, as the form's own checks held it before: no request leaves half filled.
 */
export function accountReady(fields: Blanks<"email" | "name" | "password">): boolean {
  return (
    fields.email.trim() !== "" && fields.name.trim() !== "" && passwordLength(fields.password) >= PASSWORD_MIN
  );
}
