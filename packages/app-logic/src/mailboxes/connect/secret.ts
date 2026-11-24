/**
 * A TYPED PASSWORD ON ITS WAY TO A WIRE. The contract carries a `Secret`, never a string: the value sits in this
 * module's own map and the object has no field, so printed, serialised or cloned it gives `[secret]` or nothing.
 *
 * A form makes one at the press ({@link secretOf}) and hands it to the wire inside the body. Only a host's wire
 * adapter opens it ({@link reveal}), where the request is written.
 */
const held = new WeakMap<Secret, string>();
const SHOWN = "[secret]";

export class Secret {
  /** Nominal: a string, or an object of the same shape, is not one. Declared only; it is no field of the object. */
  declare private readonly sealed: true;

  toString(): string {
    return SHOWN;
  }

  toJSON(): string {
    return SHOWN;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return SHOWN;
  }
}

/** Seal what was typed. */
export function secretOf(value: string): Secret {
  const secret = new Secret();
  held.set(secret, value);
  Object.freeze(secret);
  return secret;
}

/** FOR A HOST'S WIRE ADAPTER ALONE: the value, where the request is written. A copy or a clone of a secret holds nothing. */
export function reveal(secret: Secret): string {
  const value = held.get(secret);
  if (value === undefined) throw new TypeError("not a sealed secret");
  return value;
}

/** Nothing was typed. */
export function secretIsEmpty(secret: Secret): boolean {
  return (held.get(secret) ?? "") === "";
}

/**
 * Does this text repeat the secret? A server's sentence that echoes what was sent is never drawn. Asked without
 * opening it, and for every length a form accepts: a short password is found too, though a sentence may hold it by
 * chance, and that sentence is then not drawn either. Nothing typed is never found.
 */
export function echoes(secret: Secret, text: string): boolean {
  const value = held.get(secret) ?? "";
  return value !== "" && text.includes(value);
}
