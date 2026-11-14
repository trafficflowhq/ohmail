"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFormatter } from "next-intl";
import type { Answer, InvitesDoor } from "@ohmail/app/account";
import { ApiError, pair } from "../../api-client";
import { useRefusalSentence } from "../refusal-sentence";
import { securityRefusal } from "./security-door";

/**
 * THE WEB'S INVITES DOOR, for a server its operator runs. The list is `GET /pair`: this account's own invites that
 * are still open, and a read that failed is said, whatever refused it. A new invite (`POST /pair {grant: "invite",
 * label?}`) and one revoked (`DELETE /pair/:id`, where 404 is every kind of already gone) are each one request,
 * tried as they are: the server decides whether the factor is asked. A refused verb is read as Security's verbs
 * are: the three panes had one rule.
 *
 * The invite link is assembled here, once, from the one answer that carries its token: this page's origin and the
 * join page's path are the two halves of one address. The token rides the fragment, which no request carries; it
 * is in no log line and no stored key, and only the link leaves this file. `day` says a day as the reader says it.
 */
export function invitesDoor(say: (err: unknown) => string, day: (iso: string) => string, expectedOwner?: string | null): InvitesDoor {
  const tried = async <T>(call: () => Promise<T>): Promise<Answer<T>> => {
    try {
      return { ok: true, value: await call() };
    } catch (err) {
      return securityRefusal(err, say);
    }
  };
  return {
    async read() {
      try {
        const { items } = await pair.list(expectedOwner);
        // Open invites only: spent and expired rows are history, and pairing codes are the Devices pane's.
        const open = items.filter((item) => item.grant === "invite" && item.status === "live");
        return {
          ok: true,
          value: open.map((invite) => ({
            id: invite.id,
            name: invite.label || null,
            made: day(invite.createdAt),
            expires: day(invite.expiresAt),
          })),
        };
      } catch (err) {
        return { ok: false, word: "said", said: say(err) };
      }
    },
    make: (name) =>
      tried(async () => {
        const made = await pair.mint(name ? { label: name } : {}, expectedOwner);
        return { link: `${window.location.origin}/join/invite#${made.token}`, name: made.label };
      }),
    revoke: (id) =>
      tried(async () => {
        try {
          await pair.revoke(id, expectedOwner);
        } catch (err) {
          // Spent, expired or revoked elsewhere: the row is leaving the list either way.
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        return null;
      }),
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The web's Invites door, its refusals and days said in the reader's language. */
export function useInvitesDoor(expectedOwner?: string | null): InvitesDoor {
  const say = useRefusalSentence();
  const format = useFormatter();
  // The door stays one door whatever formatter a draw hands in: a new door would ask the list again.
  const formatter = useRef(format);
  useEffect(() => {
    formatter.current = format;
  });
  return useMemo(
    () => invitesDoor(say, (iso) => formatter.current.dateTime(new Date(iso), { dateStyle: "medium" }), expectedOwner),
    [say, expectedOwner],
  );
}
