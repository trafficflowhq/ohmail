-- EXCHANGE / Microsoft 365 OAuth2, PHASE 2 — the web onboarding CEREMONY and the Entra APP REGISTRATION,
-- both HOSTED-ONLY facts.
--
-- ══ WHY BOTH TABLES ARE CLOUD, AND NOT BY ANALOGY ═════════════════════════════════════════
--
-- `mailbox_oauth_ceremonies` is a redirect-based browser ceremony: a `state` this service minted,
-- a PKCE verifier it is holding for the ninety seconds a person spends at Microsoft's consent
-- screen, and a return path into the hosted app. A LOCAL desktop install has no redirect ceremony
-- at all — Phase 4 uses a loopback listener on the machine itself and never writes a row anywhere
-- — so the whole table is meaningless off the hosted service. It sits beside `oauth_auth_codes`
-- and `webauthn_challenges` (cloud 0000), which are the same shape of fact: single-use,
-- short-lived, redirect-bound ceremony state.
--
-- `oauth_provider_config` is the operator's own Entra application registration — a client id, a
-- client secret, a tenant, the redirect URIs registered in Azure. It is ONE registration for the
-- whole hosted deployment, held by the operator, not by an account; a local install has no
-- operator and nothing to register. It also names a `staff_users` actor, and `staff_users` is a
-- CLOUD table (cloud 0007), so a mail-journal placement could not carry the actor at all — the
-- same argument that put `account_suspensions` here rather than on `accounts`.
--
-- Neither statement performs DDL on a shared object. `mailbox_oauth_ceremonies.account_id`
-- REFERENCES `public.accounts`, which is a READ of a shared table and legal (every
-- `REFERENCES public.accounts` in this folder is one); nothing here alters `mailboxes`,
-- `mailbox_credentials` or `accounts`.
--
-- ══ THE CEREMONY ROW IS CONSUMED ONCE, AND `state` IS THE KEY THAT MAKES THAT TRUE ════════
--
-- `state` is the PRIMARY KEY and it is 256 bits of `randomBytes`, base64url. It is doing two jobs
-- and both need the same property:
--
--   · it is the CSRF token of the redirect (RFC 6749 §10.12) — an attacker cannot make a victim's
--     browser complete a ceremony the attacker started, because they cannot guess a value;
--   · it is the CONSUMPTION KEY. The callback's only write is
--     `UPDATE … SET consumed_at = now() WHERE state = $1 AND consumed_at IS NULL RETURNING …`,
--     so the row itself decides which of N concurrent replays of one authorization code is the
--     real one. Postgres serializes the two UPDATEs on the row; the loser sees zero rows and is
--     refused. There is no read-then-write window for a second request to slip through, which is
--     the reason this is not `SELECT … then UPDATE`.
--
-- `consumed_at` is a TIMESTAMP and not a boolean deliberately: "when was this ceremony spent" is
-- the question asked after the fact, and a replay attempt is worth being able to date. Presence is
-- the state (the predicate is `IS NULL`), so there is no second flag to forget.
--
-- TTL is enforced by the READER against `created_at` (ten minutes), not by a partial index or a
-- constraint: a row that has aged out must be refused with a sentence a person can act on
-- ("that took too long — start again"), and a constraint can only produce a 23514.
--
-- ══ THE PKCE VERIFIER IS ENCRYPTED AT REST, WITH ITS KEY VERSION BESIDE IT ════════════════
--
-- `code_verifier_enc` is the KEK envelope, exactly as `totp_secrets.secret_enc` and
-- `mailbox_credentials.secret_enc` are, and `code_verifier_key_version` is NOT NULL beside it for
-- the reason every other envelope in this schema carries one: `KeyProvider.decrypt(ciphertext,
-- keyVersion)` cannot be called without it, so a ring rotation would make every in-flight ceremony
-- undecryptable. The two are NOT NULL together — there is no state in which one exists without the
-- other, so unlike `staff_users` there is no CHECK to write.
--
-- A verifier is not as sensitive as a refresh token: on its own it buys nothing, because redeeming
-- the code also needs the confidential client's secret. It is encrypted anyway, because the row is
-- the one place a read-only SQL injection could stand between a leaked authorization code and a
-- mailbox, and "this secret was not worth encrypting" is a judgement that ages badly.
--
-- ══ NO FK TO `mailboxes`, AND THAT IS THE RECONNECT DESIGN ════════════════════════════════
--
-- A reconnect ("this Microsoft mailbox needs consent again") does NOT name a mailbox row here.
-- The address the ceremony ends up writing comes from the `id_token`'s `preferred_username` claim —
-- the user never types it — and mail 0021's `mailboxes_active_address_uq` (`account_id`,
-- `lower(address)`) guarantees there is AT MOST ONE live mailbox for that address. So the callback
-- resolves its target by address and either updates that row's credential or creates one. A
-- `mailbox_id` column here would be a SECOND answer to the same question, and the two could
-- disagree — a person who reconnects mailbox A and then signs in to Microsoft as B would have the
-- row repointed at an address it does not hold. The address decides, and nothing else can.

CREATE TABLE IF NOT EXISTS "mailbox_oauth_ceremonies" (
  "state" text PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "public"."accounts"("id"),
  "provider" text NOT NULL,
  "code_verifier_enc" text NOT NULL,
  "code_verifier_key_version" integer NOT NULL,
  "return_to" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone
);
--> statement-breakpoint
-- The reaper's probe, and the only query that is not keyed by `state`. A sweep of spent or aged-out
-- ceremonies reads `created_at`; without an index it is a seq scan over every ceremony this
-- deployment has ever run. Not partial: the sweep wants BOTH the consumed rows (tidy-up) and the
-- abandoned ones (a person who closed the consent tab), so a `WHERE consumed_at IS NULL` predicate
-- would exclude half of its own input.
CREATE INDEX IF NOT EXISTS "mailbox_oauth_ceremonies_created_idx"
  ON "mailbox_oauth_ceremonies" USING btree ("created_at");
--> statement-breakpoint
-- ══ THE ENTRA APPLICATION REGISTRATION ════════════════════════════════════════════════════
--
-- ONE ROW PER PROVIDER, `provider` as the PRIMARY KEY — today `'microsoft'` and nothing else. A
-- singleton row with a `bool` "is the one" flag, or an id + `ORDER BY updated_at DESC LIMIT 1`,
-- would both admit two live registrations for one provider, which is a state no reader could
-- resolve: the API's authorize URL and the worker's token POST would be signing with different
-- clients and only one of them would work. The PK makes it unrepresentable and makes the write an
-- `INSERT … ON CONFLICT (provider) DO UPDATE`.
--
-- WHY A TABLE AND NOT ENV. It is a table because the operator manages it in the admin console: a
-- client secret rotated in Azure has to be replaceable without a redeploy of two apps, and the
-- registration is a fact about the deployment rather than about a build. ENV
-- (`MS_OAUTH_CLIENT_ID` / `MS_OAUTH_CLIENT_SECRET` / `MS_OAUTH_TENANT`) remains the BOOTSTRAP: the
-- resolver prefers a row and falls back to env, so the first deploy can work with no row at all
-- and an operator locked out of the console still has a way in. Both readers — the API's
-- onboarding routes and the sync worker — go through the same resolver, so there is exactly one
-- precedence rule.
--
-- `client_secret_enc` is the KEK envelope with its `client_secret_key_version` beside it, and here
-- the two ARE nullable together, because a half-written registration is a real state: an operator
-- can save a client id and tenant before Azure has minted the secret. The CHECK is what makes
-- "sealed together" true rather than hoped for — the same constraint `staff_users` carries over its
-- TOTP secret, and for the same reason: a ciphertext with no key version is undecryptable and a key
-- version with no ciphertext is a reader that thinks it has a secret.
--
-- `enabled` DEFAULTS FALSE. A registration that exists is not a registration that is live: the
-- operator pastes the id, saves the secret, checks the redirect URIs against Azure, and only then
-- turns it on. The onboarding route refuses while it is false, with a sentence that says so. The
-- dangerous direction would be a default of true — a half-entered registration that starts
-- offering a consent screen it cannot complete.
--
-- `redirect_uris` and `scopes` are jsonb ARRAYS with `'[]'` defaults, because Azure holds several:
-- the hosted web callback today, and a loopback URI for the desktop flow later. They are the
-- OPERATOR'S RECORD of what is registered in Azure — the web flow selects the first `https://`
-- entry, so a loopback URI can sit in the list without changing which one the browser ceremony
-- uses. An empty list is a configuration fault the resolver reports, never a silent default.
--
-- `updated_by` is the `staff_users` id from the resolved staff session. It is the actor, and it is
-- the reason this table cannot live in the mail journal. There is no `audit_log` row for a change
-- here: `audit_log.account_id` is NOT NULL and this change belongs to no account, so the actor,
-- the time and the operator's note are recorded on the row itself rather than forced into a
-- column that would have to be filled with a lie.
CREATE TABLE IF NOT EXISTS "oauth_provider_config" (
  "provider" text PRIMARY KEY NOT NULL,
  "client_id" text,
  "client_secret_enc" text,
  "client_secret_key_version" integer,
  "tenant" text,
  "redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid REFERENCES "public"."staff_users"("id"),
  "note" text,
  CONSTRAINT "oauth_provider_config_secret_sealed_together"
    CHECK (("client_secret_enc" IS NULL) = ("client_secret_key_version" IS NULL))
);
