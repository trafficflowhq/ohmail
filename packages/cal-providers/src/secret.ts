/**
 * The holder of a value that is never shown: a password, a lasting sign-in, a subscription's
 * address (whoever has that address reads the calendar). It prints as `[secret]` wherever something
 * would print it, and hands the value out by `reveal` alone, which is called where a request's own
 * line is built and where the stored text is made for sealing.
 */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[secret]";
  }

  toJSON(): string {
    return "[secret]";
  }

  [INSPECT](): string {
    return "[secret]";
  }
}
