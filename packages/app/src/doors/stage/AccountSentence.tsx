import { useRef, useState, type ReactNode, type RefObject } from "react";
import type { Text } from "../../text/index.js";
import { PASSWORD_MIN, type Blanks } from "./fields.js";
import { SaidWith } from "../../text/Said.js";
import { SentenceBlank } from "../../text/SentenceBlank.js";

/** An account's three blanks, in the order its sentence says them. */
export type AccountField = "name" | "email" | "password";

/** The first of an account's blanks a press finds not ready, in the sentence's order; null once every one is. */
export function accountWanted(fields: Blanks<AccountField>): AccountField | null {
  if (fields.name.trim() === "") return "name";
  if (fields.email.trim() === "") return "email";
  return fields.password.length < PASSWORD_MIN ? "password" : null;
}

/**
 * What a page's press needs to say which blank it wants: the blank a press found not ready (`wanted`, cleared as it is
 * typed in), and each blank's element to take the keys. A form of the page's own adds its other blanks to it.
 */
export function useWanted<F extends string>(
  fields: readonly F[],
): {
  wanted: F | null;
  want(field: F | null): void;
  typed(field: F): void;
  at: Readonly<Record<F, RefObject<HTMLInputElement | null>>>;
} {
  const [wanted, setWanted] = useState<F | null>(null);
  const refs = useRef<Record<F, RefObject<HTMLInputElement | null>> | null>(null);
  refs.current ??= Object.fromEntries(fields.map((f) => [f, { current: null }])) as Record<
    F,
    RefObject<HTMLInputElement | null>
  >;
  const at = refs.current;
  return {
    wanted,
    want: (field) => {
      setWanted(field);
      if (field !== null) at[field].current?.focus();
    },
    typed: (field) => {
      if (field === wanted) setWanted(null);
    },
    at,
  };
}

/**
 * "I'm ___, at ___, with a password of ___.": an account's three blanks in the page's sentence, as the design draws
 * them. Each blank holds the comma after it, so they keep their line; the last ends in the dot. The words are the
 * page's namespace's (`account`, and each blank's label and hint); `lengthHint` names the password's hint.
 */
export function AccountSentence(p: {
  t: Text;
  lengthHint: string;
  secretFieldHintId?: string;
  ids?: Readonly<Record<AccountField, string>>;
  fields: Blanks<AccountField>;
  wanted: string | null;
  at: Readonly<Record<AccountField, RefObject<HTMLInputElement | null>>>;
  type(field: AccountField, value: string): void;
}): ReactNode {
  const { t, fields, wanted, at, type, ids } = p;
  return (
    <SaidWith
      level={ids === undefined ? undefined : 1}
      parts={t.rich("account", {
        name: (comma: ReactNode) => (
          <span className="way-nb">
            <SentenceBlank
              ref={at.name}
              id={ids?.name}
              label={t("nameLabel")}
              placeholder={t("nameBlank")}
              size={t("nameBlank").length}
              autoComplete="name"
              value={fields.name}
              refused={wanted === "name"}
              onChange={(v) => type("name", v)}
            />
            {comma}
          </span>
        ),
        email: (comma: ReactNode) => (
          <span className="way-nb">
            <SentenceBlank
              ref={at.email}
              id={ids?.email}
              label={t("emailLabel")}
              placeholder={t("emailBlank")}
              size={t("emailBlank").length}
              type={ids === undefined ? undefined : "email"}
              inputMode="email"
              autoComplete="email"
              value={fields.email}
              refused={wanted === "email"}
              onChange={(v) => type("email", v)}
            />
            {comma}
          </span>
        ),
        password: () => (
          <SentenceBlank
            ref={at.password}
            id={ids?.password}
            describedBy={p.secretFieldHintId}
            label={t("passwordLabel")}
            placeholder={t(p.lengthHint)}
            size={t(p.lengthHint).length}
            type="password"
            autoComplete="new-password"
            value={fields.password}
            refused={wanted === "password"}
            onChange={(v) => type("password", v)}
          />
        ),
      })}
    />
  );
}
