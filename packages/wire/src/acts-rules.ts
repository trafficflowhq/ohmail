/**
 * THE ACTS ON A SENDER'S RULE: members of `EngineMutation` (`acts.ts`).
 */
import type { Folder } from "./base.js";
import type { RuleKeyAddress } from "./organizing.js";

export type RuleAct =
  /**
   * Revoke a rule, and change where one files — the undo for the consent gate. Engine
   * mutations, not `app/api-client` calls: the surface ships in the public desktop mirror,
   * which contains no api-client (the publish script denies it); the engine is the only wire a
   * shared-shell view has. The precedent: `tag_assign` threw UnsupportedMutationError under a
   * finished UI for all of Stage 2 — mounted, tested, reachable from nothing. A revoke does not
   * move mail: `RulesService.remove` deletes the row and never touches `folder_state`; rules
   * are consulted when mail ARRIVES, never retroactively — the surface says so before the user
   * commits (see `RulesView`).
   */
  | {
      kind: "rule_delete"; ruleId: string;
      /** A rule of the organizer's copy with no row here, by its key: relayed, nothing removed here. */
      key?: RuleKeyAddress;
    }
  /**
   * `destination` only, though `PATCH /rules/:id` accepts kind/match/priority/enabled too.
   *
   * Destination is the field the user has a mental model for — "this sender goes to the
   * wrong pile" is the whole of it — and it is the only one whose new value the surface
   * can offer as a closed set of six folders it already renders names for. `match` is a
   * free-text field whose validity is a server concern, and re-keying a rule's `kind` turns
   * one sender's decision into a whole domain's without saying so. Both are refused here
   * rather than offered thinly.
   */
  | {
      kind: "rule_update";
      ruleId: string;
      /** A rule of the organizer's copy with no row here, by its key: relayed, nothing written here. */
      key?: RuleKeyAddress;
      destination: Folder;
      /** Absent keeps the stored priority; set only to lift an address rule over its domain's. */
      priority?: number;
      /**
       * Also apply the rule to mail already filed, as the user answered it. The server re-arms the
       * retro on a retarget unless this says otherwise; an explicit `true` re-arms a rule whose
       * destination did NOT move, which is the only way to ask an existing rule for the backlog.
       * Absent means the caller has nothing to say and the server's own rule stands.
       */
      applyRetro?: boolean;
      /**
       * An undo, not a press: the rule goes back to its old place and keeps the provenance it has.
       * Absent on every press, which makes the rule the person's (`RulesService.update`).
       */
      keepProvenance?: boolean;
      /** With `keepProvenance`: the inferred value the undo read, restored only over a `manual` row. */
      restoreProvenance?: "promoted" | "seeded-from-sent" | "migrated";
      /**
       * A Rules-page Change: re-file the mail the rule filed in its place, and nothing else. Sent
       * beside `applyRetro: false`, so a server that predates it moves nothing.
       */
      refile?: true;
    }
  /**
   * Make a rule from past the gate — the verb that did not exist. Creating a rule must also
   * apply to mail already in the mailbox, by default. A new verb because `screener_decide` only
   * writes a rule for a sender the Screener still holds (zero effects ⇒ `rolled_back`, nothing
   * sent), so the Ohbox case could not reach the server; `POST /rules` was mounted the whole
   * time — this is the caller it never had. It moves no mail: the routing pass consults rules on
   * arrival, and the already-filed mail is moved by the `move` mutations the surface composes
   * alongside. `ruleKind`, not `kind` (the union's discriminant); `header` is absent — no
   * surface can compose one from a clicked message.
   */
  | {
      kind: "rule_create";
      /** The rules row's `kind`. `domain` widens it to everyone after the `@`. */
      ruleKind: "sender" | "domain";
      /** Absent is the server's 0; set only to lift an address rule over its domain's. */
      priority?: number;
      /**
       * The address or the domain, ALREADY NORMALIZED by the caller (trimmed, lower-cased).
       *
       * Normalized once at the call site rather than here, so the optimistic row and the wire
       * body are literally the same string — the server stores `match` verbatim
       * (`RulesService.validMatch` does not fold case) and echoes it back, so a client that
       * lower-cased in one place and not the other would show a row that changes under the
       * cursor on the echo. Empty yields no effects: the server answers 400, and an empty
       * `domain` match would be compared against the empty domain of every malformed address.
       */
      match: string;
      destination: Folder;
      /**
       * A second term on the rule — from this address AND with this in the subject. Absent for
       * the ordinary one-term rule; present only from the subject sheet, which offers the
       * repeating token it detected. `ruleKind: "sender"` only — the server answers 400 for a
       * term on a domain rule, and `mutationEffects` yields no effects for that combination so
       * the engine rejects it locally; the refusal is here so it stays unreachable rather than
       * silently broadening. Sent as typed, matched case-folded — both surfaces quote the term
       * back at the user, who read it off their own mail.
       */
      subjectContains?: string | null;
      /**
       * A THIRD TERM ON THE RULE — *from this address AND with this in the message text*.
       *
       * `subjectContains`' contract verbatim: absent for the ordinary rule, `ruleKind: "sender"`
       * only (the server answers 400 elsewhere and `mutationEffects` yields no effects locally),
       * sent as typed and matched case-folded by the server against the message's plain text. It
       * composes with the subject term — a mutation may carry both, and both must then hold.
       */
      bodyContains?: string | null;
      /**
       * Also apply this rule to mail that is already filed. `RulesService.create` stamps
       * `rules.retro_requested_at`; the worker's `ruleRetroPass` walks stored mail in bounded,
       * resumable pages and writes `folder_state`, which the reconciler turns into real IMAP
       * moves — this boolean is the difference between changing the future and also
       * reorganizing the past. Sent explicitly, never omitted: the server defaults absence to
       * `true`, but the surface always sends the value, so what ships is decided by one visible
       * constant (`sender-screening.ts#RETRO_DEFAULT_ON`).
       */
      applyRetro?: boolean;
    };
