/**
 * The server-profile store — every pairing this phone holds, in the device keystore. A profile
 * is `{origin, flavor, accountId, refreshToken}`, persisted in expo-secure-store (bound in
 * `servers-native.ts`; tests inject a memory KV through the same seam): the refresh token can
 * open a mailbox, and the keystore is readable by this app alone. One small value per profile
 * plus one index — iOS warns past 2 KB per value. Identity is `(origin, accountId)`, the same
 * pair `mirrorOwnerKey` names mirrors with; `add()` requires an already-normalized origin.
 * Re-pairing the same identity updates the row in place (the mid-rotation-kill recovery). All
 * mutations run through one internal chain, so interleaved read-modify-writes cannot lose the index.
 */

/**
 * An app-authored failure carries a code, not a sentence. Throws carried English prose, and
 * catchers put `String(err)` inside a translated refusal — a German sentence with an English
 * one wedged into it, arriving through the one door a census cannot watch: a value produced at
 * runtime. The diagnostic rule (`test/copy-census.test.ts`) draws the line: the platform's own
 * words (a keystore `SecurityException`, an SQLite failure, an HTTP status) are quoted
 * verbatim; our failures are enumerable, so they get a code and the deck says them. The
 * message stays English beside the code — it is what a developer reads in a stack trace, and
 * what `String(err)` yields if a caller forgets the mapping.
 */
export type StoreFaultCode =
  | "origin_not_normalized" | "account_id_missing"
  | "pairing_not_recorded" | "pairing_still_held" | "pairing_still_listed" | "no_such_profile"
  | "wipe_queue_full" | "wipe_not_recorded" | "wipe_still_owed"
  | "wake_queue_full" | "wake_not_recorded" | "wake_still_owed"
  | "index_unreadable" | "purge_refused" | "index_not_removed"
  /* The engine's own failures. They used to be bare `Error`s with English messages, and
     `faultDetail` embedded those frozen sentences in German refusals — see `engine/boot.ts`. */
  | "mirror_not_deleted" | "sync_held_pre_identity" | "account_mismatch";

export class StoreFault extends Error {
  constructor(readonly code: StoreFaultCode, message: string) {
    super(message);
    this.name = "StoreFault";
  }
}

/** `true` for a failure this app authored, and therefore one the deck has a sentence for. */
export function isStoreFault(err: unknown): err is StoreFault {
  return err instanceof StoreFault;
}

/** The two keystore calls this module needs — expo-secure-store's shape, injectable. */
export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** One pairing. `refreshToken: null` = the pairing ended (a refusal); re-pair to fill it. */
export interface ServerProfile {
  id: string;
  /** Normalized: lower-case scheme+host, no trailing slash — `normalizeOrigin`'s output. */
  origin: string;
  /** What `GET /hello` said this server is: "selfhost", "desktop-host", "managed", "local". */
  flavor: string;
  /** The server-verified account this pairing opens — half of the mirror's owner key. */
  accountId: string;
  /**
   * `null` has two meanings and the origin tells them apart; both are states, neither an
   * error. On a paired origin: the pairing ended — a refusal cleared it, one scan re-pairs.
   * On the standalone origin (`LOCAL_ENGINE_ORIGIN`): there was never a token to hold — the
   * engine in this process mints its own bearer per launch, and the credential a relaunch
   * needs is the password the engine sealed for itself, not anything in this store. A reader
   * that treats the second as the first sends somebody to the QR scanner for a mailbox on the
   * phone they are holding, which is what `app/servers.tsx` reads the origin for.
   */
  refreshToken: string | null;
  /**
   * Where the `/sync` family lives on this server — the origin itself, or `<origin>/api`.
   * Measured at pairing time ({@link import('../net/server-base').resolveApiBase}) rather than
   * derived, because a QR carries no door; a self-host stack serves the API behind `/api`, so
   * a pairing to one used to succeed and then mirror nothing for ever. `null` ⇒ the origin:
   * every profile stored before this field existed is on a door whose API is at its root, so
   * reading absence as the origin is what those installs already do. Not part of the profile's
   * identity — the same account on the same server is the same mailbox whichever path its API
   * answers on, and a re-measured base must not fork the mirror and re-download the mailbox.
   */
  apiBase: string | null;
  /**
   * The door's key, base64url `SHA-256(SubjectPublicKeyInfo)` — for a desktop host on the
   * local network, whose self-signed certificate no authority vouches for and whose trust came
   * from the pairing ceremony. `null` for every origin the platform can verify on its own —
   * not a missing pin but an absent need for one. Persisted with the profile because it must
   * be re-installed on every launch, before the first request: a pin held only in memory would
   * work for the pairing and fail on the next cold start, the worst shape this could have.
   */
  pin: string | null;
}

/** The persisted index — which profiles exist, which one the app boots, and what is owed. */
interface Index {
  active: string | null;
  ids: string[];
  /**
   * Forgets that are owed — the durable half of "forget", naming both stores. A forget removes
   * a credential from the keystore and mail from a SQLite file; a kill between them used to
   * leave the mail behind for ever, the profile naming the mirror already gone. So the intent
   * is written before either store is touched, cleared once the deletion reads back. Each
   * entry carries the profile id as well as the mirror key: with only an owner key, a kill
   * before `remove(profileId)` left the profile active, and the next launch deleted the
   * mirror, cleared the debt, then reconnected and drained the mailbox back. An empty `id`
   * means "mail only". Bounded ({@link MAX_PENDING_WIPES}); overflow refuses, never evicts.
   */
  wipes?: PendingWipe[];
}

/** One owed forget: the credential to remove, and the mirror to delete. See {@link Index.wipes}. */
export interface PendingWipe {
  /** The profile row still to be removed, or "" when there is none left to remove. */
  id: string;
  /** `mirrorOwnerKey(origin, accountId)` — the database to delete and read back. */
  owner: string;
}

const PREFIX = "ohmail.servers.v1";

/**
 * See {@link Index.wipes}: the index is one small keystore value and must stay one — iOS warns
 * past 2 KB per value, which is why profiles are one key each rather than a blob.
 *
 * Twelve rather than sixteen, and the number is measured rather than chosen: `servers.test.ts`
 * fills the queue beside several profiles and asserts the whole index value stays under 2 KB.
 * Reaching it at all means twelve forgets in a row whose mail could not be deleted, which is a
 * device problem, not a usage pattern — and it is REFUSED out loud rather than absorbed.
 */
const MAX_PENDING_WIPES = 12;

/** What {@link ServerProfileStore.markPendingWipe} throws when the queue is full. See above. */
export const WIPE_QUEUE_FULL =
  "this phone already has more unfinished deletions than it can record";

/**
 * One wake row this phone owes a server — the durable half of "stop waking me for that
 * account". A registration is a row on the server, and taking it down can be refused. Two
 * paths hit that: a profile switch (the outgoing server's row must go before the next one is
 * made — one distributor endpoint is shared across profiles), and a registration superseded
 * mid-flight. Both used to fire the delete and discard id and verdict, so a refusal left a
 * row nothing could ever name again, dialling an endpoint still live and never producing the
 * 404/410 the server prunes on. Its own keystore value rather than an index field: iOS warns
 * past 2 KB, and these entries must never make an unrelated index write fail.
 */
export interface PendingWakeDrop {
  /** Whose credential can retry it — the row is deleted on that profile's own server. */
  profileId: string;
  /** The server's id for the registration. */
  subscriptionId: string;
}

const WAKE_DROPS_KEY = `${PREFIX}.wakes`;

/** Sized for its own 2 KB value, not the index's. ~60 bytes per entry. */
const MAX_PENDING_WAKE_DROPS = 24;

/** What {@link ServerProfileStore.markPendingWakeDrop} throws when that queue is full. */
export const WAKE_QUEUE_FULL =
  "this phone already has more unfinished wake removals than it can record";

/**
 * One persisted wipe entry, defensively. A malformed member is DROPPED rather than throwing —
 * an unreadable index must lose the list and never the app (the same rule `readIndex` states) —
 * and the bare-string shape an earlier build wrote is read as "mail only, no profile left".
 */
function readWipe(raw: unknown): PendingWipe[] {
  if (typeof raw === "string") return raw === "" ? [] : [{ id: "", owner: raw }];
  if (typeof raw !== "object" || raw === null) return [];
  const w = raw as Partial<PendingWipe>;
  if (typeof w.owner !== "string" || w.owner === "") return [];
  return [{ id: typeof w.id === "string" ? w.id : "", owner: w.owner }];
}

/** Keystore-safe, unique-per-device id. Not a credential — collision-resistance suffices. */
function mintId(): string {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
}

export class ServerProfileStore {
  private readonly kv: SecureKV;
  private readonly newId: () => string;
  /** The mutation chain — every write waits for the previous one's index to be on disk. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(kv: SecureKV, opts: { newId?: () => string } = {}) {
    this.kv = kv;
    this.newId = opts.newId ?? mintId;
  }

  /**
   * Was the index there but UNREADABLE? `readIndex` answers an empty index for both "absent" and
   * "corrupt", which is right for every ordinary reader — a lost list costs one scan each — and
   * catastrophic for {@link purgeAll}, where "there is nothing to purge" and "I cannot tell what
   * to purge" have opposite correct actions, and the second one leaves live credentials behind a
   * verdict that says they are gone.
   */
  private async indexUnreadable(): Promise<boolean> {
    const raw = await this.kv.get(PREFIX);
    if (raw === null) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed !== "object" || parsed === null;
    } catch {
      return true;
    }
  }

  private async readIndex(): Promise<Index> {
    const raw = await this.kv.get(PREFIX);
    if (raw === null) return { active: null, ids: [], wipes: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<Index>;
      return {
        active: typeof parsed.active === "string" ? parsed.active : null,
        ids: Array.isArray(parsed.ids) ? parsed.ids.filter((i): i is string => typeof i === "string") : [],
        wipes: Array.isArray(parsed.wipes) ? parsed.wipes.flatMap(readWipe) : [],
      };
    } catch {
      // An unreadable index loses the LIST, never a mirror: profiles re-pair with one scan
      // each, and the stranded per-profile values are overwritten by their next add().
      return { active: null, ids: [], wipes: [] };
    }
  }

  /**
   * The ONE place the index is written, so no caller can drop a field it did not know about.
   * `wipes` was added after `add`, `remove` and `setActive` were each writing their own object
   * literal, and every one of those literals would have silently erased an owed deletion.
   */
  private async writeIndex(idx: Index): Promise<void> {
    await this.kv.set(PREFIX, JSON.stringify({
      active: idx.active,
      ids: idx.ids,
      // NO TRUNCATION HERE. The cap is enforced at `markPendingWipe`, where it can REFUSE;
      // a silent `slice` in the common writer would drop an unpaid debt on any write at all —
      // including one that had nothing to do with the queue.
      wipes: idx.wipes ?? [],
    } satisfies Index));
  }

  /**
   * Is this profile owed a forget? Read at LAUNCH, before anything boots: an entry naming a
   * profile means the person pressed Forget and the process died before the credential went.
   */
  async isOwedForget(profileId: string): Promise<boolean> {
    return (await this.readIndex()).wipes?.some((w) => w.id === profileId) === true;
  }

  private async readProfile(id: string): Promise<ServerProfile | null> {
    const raw = await this.kv.get(`${PREFIX}.${id}`);
    if (raw === null) return null;
    try {
      const p = JSON.parse(raw) as Partial<ServerProfile>;
      if (
        typeof p.origin !== "string" || typeof p.accountId !== "string" ||
        typeof p.flavor !== "string"
      ) return null;
      return {
        id,
        origin: p.origin,
        flavor: p.flavor,
        accountId: p.accountId,
        refreshToken: typeof p.refreshToken === "string" ? p.refreshToken : null,
        // Absent in rows written before pinning existed, and absent for every origin that never
        // needed one — the same `null`, and correctly so: the pairing seam decides whether an
        // origin REQUIRES a pin from the origin's own shape, not from whether a row carries one.
        pin: typeof p.pin === "string" ? p.pin : null,
        // Absent in every row written before the base was measured, and an EMPTY string is read as
        // absent too — a base of "" would compose `/sync` as a relative path and fetch would throw
        // on it. See {@link ServerProfile.apiBase}: absent means the origin.
        apiBase: typeof p.apiBase === "string" && p.apiBase.trim() !== "" ? p.apiBase.trim() : null,
      };
    } catch {
      return null;
    }
  }

  private async writeProfile(p: ServerProfile): Promise<void> {
    const { id, ...body } = p;
    await this.kv.set(`${PREFIX}.${id}`, JSON.stringify(body));
  }

  /** Serialize a mutation behind every earlier one. Failures don't poison the chain. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Every profile, index order. Rows whose value is gone or unreadable are dropped, not thrown. */
  async list(): Promise<ServerProfile[]> {
    const idx = await this.readIndex();
    const rows = await Promise.all(idx.ids.map((id) => this.readProfile(id)));
    return rows.filter((r): r is ServerProfile => r !== null);
  }

  /** The profile the app boots, or null (nothing paired / first launch). */
  async active(): Promise<ServerProfile | null> {
    const idx = await this.readIndex();
    return idx.active === null ? null : this.readProfile(idx.active);
  }

  /**
   * Add a pairing and make it active. Same (origin, accountId) ⇒ the standing profile is
   * UPDATED in place (fresh flavor + refresh token, same id) — a re-pair, never a duplicate.
   * The origin must arrive normalized (the header's contract with the pairing seam).
   */
  add(input: {
    origin: string; flavor: string; accountId: string; refreshToken: string;
    /** See {@link ServerProfile.pin}. Omitted is `null` — an origin that needs no pin. */
    pin?: string | null;
    /** See {@link ServerProfile.apiBase}. Omitted is `null` — the API is at the origin. */
    apiBase?: string | null;
  }): Promise<ServerProfile> {
    return this.enqueue(async () => {
      if (input.origin !== input.origin.trim().replace(/\/+$/, "").toLowerCase()) {
        throw new StoreFault("origin_not_normalized", `profile origin must arrive normalized: "${input.origin}"`);
      }
      if (!input.accountId.trim()) throw new StoreFault("account_id_missing", "a profile needs the server-verified account id");
      const idx = await this.readIndex();
      const existing = (await Promise.all(idx.ids.map((id) => this.readProfile(id)))).find(
        (p) => p !== null && p.origin === input.origin && p.accountId === input.accountId,
      );
      const profile: ServerProfile = {
        id: existing ? existing.id : this.newId(),
        origin: input.origin,
        flavor: input.flavor,
        accountId: input.accountId,
        refreshToken: input.refreshToken,
        // A RE-PAIR REPLACES THE PIN rather than keeping the old one. That is the rotation
        // story: a desktop that was reinstalled presents a new key, and the only way this phone
        // ever accepts it is the person scanning a fresh code from that machine.
        pin: input.pin ?? null,
        // A RE-PAIR REPLACES THE BASE for the pin's reason one field down: the pairing seam has
        // just MEASURED where this server's API answers, and that measurement is newer than
        // whatever the standing row holds. An operator who moved their stack behind a proxy is
        // the case, and one scan is the whole remedy.
        apiBase: input.apiBase ?? null,
      };
      // The index learns the id before the credential exists. The other order could create a
      // credential nothing names: a kill after the profile value landed and before the index
      // did left a live refresh token under a key in no list — the fresh-install purge walks
      // `idx.ids`, so it never asked for it, and its "every key was read back" is vacuous for
      // a key it cannot name. Reversed, the same kill leaves an id with no value behind it,
      // which every reader already handles: `list()` drops such rows, `active()` answers null,
      // `purgeAll` removes nothing. An index entry that over-names is recoverable; a
      // credential that nothing names is not.
      await this.writeIndex({
        ...idx,
        active: profile.id,
        ids: existing ? idx.ids : [...idx.ids, profile.id],
      });
      // AND THE ORDER IS ONLY WORTH ANYTHING IF THE FIRST WRITE LANDED. A `set` that resolved
      // without storing puts us straight back in the state the reordering exists to prevent: the
      // credential written next under a key no list names, invisible to the purge that walks the
      // list. Read it back BEFORE the secret is written, not after.
      if (!(await this.readIndex()).ids.includes(profile.id)) {
        throw new StoreFault("pairing_not_recorded", `this phone could not record the pairing "${profile.id}" before storing it`);
      }
      await this.writeProfile(profile);
      return profile;
    });
  }

  /**
   * Add the row for a mailbox this phone itself organizes — the one deliberate credential-less
   * row. {@link add} requires a refresh token because a pairing without one cannot open
   * anything, right for every origin on a network. This row is the other kind: no server, no
   * token — a relaunch opens the mailbox with the password the engine sealed under its own key
   * ring (see {@link ServerProfile.refreshToken}). Everything else is `add`'s ceremony
   * verbatim: same `(origin, accountId)` identity, index before value, the read-back that
   * refuses an unrecorded row. `add` is not reused with a nullable token — widening it would
   * let any caller store a pairing that can never connect.
   */
  addStandalone(input: { origin: string; flavor: string; accountId: string }): Promise<ServerProfile> {
    return this.enqueue(async () => {
      if (input.origin !== input.origin.trim().replace(/\/+$/, "").toLowerCase()) {
        throw new StoreFault("origin_not_normalized", `profile origin must arrive normalized: "${input.origin}"`);
      }
      if (!input.accountId.trim()) throw new StoreFault("account_id_missing", "a profile needs the server-verified account id");
      const idx = await this.readIndex();
      const existing = (await Promise.all(idx.ids.map((id) => this.readProfile(id)))).find(
        (p) => p !== null && p.origin === input.origin && p.accountId === input.accountId,
      );
      const profile: ServerProfile = {
        id: existing ? existing.id : this.newId(),
        origin: input.origin,
        flavor: input.flavor,
        accountId: input.accountId,
        refreshToken: null,
        /* NO PIN AND NO BASE. There is no certificate to pin — nothing leaves the device — and the
           API answers at the origin, which is what an absent base already means. */
        pin: null,
        apiBase: null,
      };
      await this.writeIndex({
        ...idx,
        active: profile.id,
        ids: existing ? idx.ids : [...idx.ids, profile.id],
      });
      if (!(await this.readIndex()).ids.includes(profile.id)) {
        throw new StoreFault("pairing_not_recorded", `this phone could not record the pairing "${profile.id}" before storing it`);
      }
      await this.writeProfile(profile);
      /* READ BACK. `add`'s read-back is the index's, because the value it writes next is a secret
         it must not write under a name nothing lists. This row holds no secret, and the failure it
         has to catch is the other one: a keystore that took the write and kept nothing leaves the
         app live on a mailbox the next launch cannot find, with nothing saying so. */
      if ((await this.readProfile(profile.id)) === null) {
        throw new StoreFault("pairing_not_recorded", `this phone could not store the mailbox it organizes ("${profile.id}")`);
      }
      return profile;
    });
  }

  /** Forget a pairing on this phone. (The server's Devices list is the server-side take-back.) */
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      // ── THE CREDENTIAL FIRST, READ BACK, AND ONLY THEN THE INDEX ─────────────────────────
      //
      // A keystore `remove` that REFUSED is indistinguishable from one that worked until
      // somebody asks, and what survives it is a refresh token — the one residue of a forget
      // that can still open the mailbox. Dropping the id from the index first would make that
      // refusal INVISIBLE in the worst way: the server would vanish from the picker while its
      // credential stayed readable under a key nothing lists any more. So the value goes, the
      // value is read back, and the row leaves the list only once it is really gone.
      await this.kv.remove(`${PREFIX}.${id}`);
      // `kv.get`, not `readProfile`: that maps "absent" and "present but unreadable" to the same
      // `null`, so a malformed value surviving a refused remove read as an empty keystore — and
      // the id then left the index, which is the only durable name those credential-bearing
      // bytes had. Whether the value PARSES is not the question a removal asks.
      if ((await this.kv.get(`${PREFIX}.${id}`)) !== null) {
        throw new StoreFault("pairing_still_held", `this phone still holds the pairing "${id}" — the keystore refused to forget it`);
      }
      const idx = await this.readIndex();
      await this.writeIndex({
        ...idx,
        active: idx.active === id ? null : idx.active,
        ids: idx.ids.filter((i) => i !== id),
      });
      if ((await this.readIndex()).ids.includes(id)) {
        throw new StoreFault("pairing_still_listed", `this phone still lists the pairing "${id}" — the keystore refused to forget it`);
      }
    });
  }

  /** Switch which profile the app boots. Unknown id ⇒ refused, the index untouched. */
  setActive(id: string): Promise<void> {
    return this.enqueue(async () => {
      const idx = await this.readIndex();
      if (!idx.ids.includes(id)) throw new StoreFault("no_such_profile", `no server profile "${id}" on this phone`);
      await this.writeIndex({ ...idx, active: id });
    });
  }

  /** The BearerManager vault's write half — every successful rotation lands here. */
  saveRefreshToken(id: string, refreshToken: string): Promise<void> {
    return this.enqueue(async () => {
      const p = await this.readProfile(id);
      if (p === null) return; // forgotten mid-rotation — nothing to persist into
      await this.writeProfile({ ...p, refreshToken });
    });
  }

  /**
   * RECORD WHERE THIS SERVER'S API ANSWERS — the repair path for a row stored before the base was
   * measured (`net/pairing.ts#buildSession`). See {@link ServerProfile.apiBase}.
   *
   * {@link saveRefreshToken}'s exact shape, including its missing-row NO-OP and for the same
   * reason: a profile forgotten while the probe was in flight has nothing to persist into, and
   * writing one here would resurrect a pairing somebody asked to forget — the shape the pending-wipe
   * queue exists to prevent.
   */
  setApiBase(id: string, apiBase: string): Promise<void> {
    return this.enqueue(async () => {
      const p = await this.readProfile(id);
      if (p === null) return;
      await this.writeProfile({ ...p, apiBase });
    });
  }

  /**
   * The vault's take-back — a refresh REFUSAL (the server judged the token) clears the
   * credential but KEEPS the profile row, so the picker can say "pairing ended — scan again"
   * instead of the server silently vanishing from the list.
   */
  clearRefreshToken(id: string): Promise<void> {
    return this.enqueue(async () => {
      const p = await this.readProfile(id);
      if (p === null) return;
      await this.writeProfile({ ...p, refreshToken: null });
    });
  }

  /* ── the owed deletions (see {@link Index.wipes}) ─────────────────────────────────────── */

  /** Forgets this phone still owes, oldest first — the order a launch pays them in. */
  async pendingWipes(): Promise<PendingWipe[]> {
    return [...((await this.readIndex()).wipes ?? [])];
  }

  /**
   * Record that a forget is owed — the FIRST act, before the credential is removed and before
   * the database is touched. Idempotent on the mirror key; a re-marked entry keeps its place in
   * the queue rather than jumping it, but DOES adopt a profile id it did not have (a second
   * forget of a re-paired server must remove the new row too).
   */
  markPendingWipe(profileId: string, ownerKey: string): Promise<void> {
    return this.enqueue(async () => {
      const idx = await this.readIndex();
      const owed = idx.wipes ?? [];
      const held = owed.find((w) => w.owner === ownerKey);
      if (!held && owed.length >= MAX_PENDING_WIPES) throw new StoreFault("wipe_queue_full", WIPE_QUEUE_FULL);
      if (held) {
        if (held.id === profileId || profileId === "") return;
        await this.writeIndex({
          ...idx,
          wipes: owed.map((w) => (w.owner === ownerKey ? { id: profileId, owner: ownerKey } : w)),
        });
      } else {
        await this.writeIndex({ ...idx, wipes: [...owed, { id: profileId, owner: ownerKey }] });
      }
      // ── AND THE INTENT IS READ BACK, BEFORE ANYTHING IS DESTROYED ──────────────────────
      //
      // "Persist the decision first" is only worth anything if the persistence is checked. A
      // keystore `set` that resolved without storing left this queue EMPTY while the forget went
      // on to remove the credential and then promise, on screen, that the app would try the
      // deletion again at the next launch — and nothing could, because the entry naming the
      // mirror was never there. The caller refuses the whole forget on this throw, with the
      // credential still in place, which is the recoverable state.
      const back = (await this.readIndex()).wipes ?? [];
      if (!back.some((w) => w.owner === ownerKey && (profileId === "" || w.id === profileId))) {
        throw new StoreFault("wipe_not_recorded", `this phone could not record that "${ownerKey}" is owed a deletion`);
      }
    });
  }

  /**
   * The forget landed and was read back at both stores. Clearing is the LAST act, so a kill
   * anywhere before it leaves the debt owed and the next launch finishes it.
   */
  clearPendingWipe(ownerKey: string): Promise<void> {
    return this.enqueue(async () => {
      const idx = await this.readIndex();
      const owed = idx.wipes ?? [];
      if (!owed.some((w) => w.owner === ownerKey)) return;
      await this.writeIndex({ ...idx, wipes: owed.filter((w) => w.owner !== ownerKey) });
      // READ BACK, for the same reason the mark does — and the failure here is the nastier of
      // the two. A clear that resolved without storing leaves a STALE debt against an owner key
      // whose mirror is already gone: the forget reports success, the person re-pairs the same
      // server, and the next launch's drain collects the old debt against the NEW mirror and
      // deletes the mailbox they just re-authorized. The debt outliving its purpose is worse
      // than the debt never being written.
      if ((await this.readIndex()).wipes?.some((w) => w.owner === ownerKey) === true) {
        throw new StoreFault("wipe_still_owed", `this phone still records a deletion owed for "${ownerKey}"`);
      }
    });
  }

  /* ── the owed WAKE-ROW deletions (see {@link PendingWakeDrop}) ────────────────────────── */

  /** Wake rows this phone still owes a server. Oldest first — the order a launch pays them in. */
  async pendingWakeDrops(): Promise<PendingWakeDrop[]> {
    const raw = await this.kv.get(WAKE_DROPS_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((d): PendingWakeDrop[] => {
        if (typeof d !== "object" || d === null) return [];
        const w = d as Partial<PendingWakeDrop>;
        if (typeof w.profileId !== "string" || typeof w.subscriptionId !== "string") return [];
        if (w.profileId === "" || w.subscriptionId === "") return [];
        return [{ profileId: w.profileId, subscriptionId: w.subscriptionId }];
      });
    } catch {
      return [];
    }
  }

  /**
   * Record a wake row this phone failed to take down. Idempotent on the subscription id.
   *
   * A FULL QUEUE REFUSES rather than evicting, for {@link Index.wipes}'s reason one surface
   * over: an entry is the only remaining record of a row a server is still dialling, so
   * dropping the oldest would strand it permanently and silently. Reaching the cap means many
   * consecutive failures against unreachable servers, which is a device or network condition
   * and not a usage pattern.
   */
  markPendingWakeDrop(profileId: string, subscriptionId: string): Promise<void> {
    return this.enqueue(async () => {
      const owed = await this.pendingWakeDrops();
      if (owed.some((d) => d.subscriptionId === subscriptionId)) return;
      if (owed.length >= MAX_PENDING_WAKE_DROPS) throw new StoreFault("wake_queue_full", WAKE_QUEUE_FULL);
      await this.kv.set(WAKE_DROPS_KEY, JSON.stringify([...owed, { profileId, subscriptionId }]));
      // READ BACK, for {@link Index.wipes}'s reason one queue over: a keystore `set` that
      // resolved without storing would leave the caller free to fire a delete whose only
      // retryable record does not exist.
      if (!(await this.pendingWakeDrops()).some((d) => d.subscriptionId === subscriptionId)) {
        throw new StoreFault("wake_not_recorded", `this phone could not record that wake registration "${subscriptionId}" is owed a removal`);
      }
    });
  }

  /** The server confirmed the row is gone (2xx, or 404 — absent is the whole ask). */
  clearPendingWakeDrop(subscriptionId: string): Promise<void> {
    return this.enqueue(async () => {
      const owed = await this.pendingWakeDrops();
      const left = owed.filter((d) => d.subscriptionId !== subscriptionId);
      if (left.length === owed.length) return;
      if (left.length === 0) await this.kv.remove(WAKE_DROPS_KEY);
      else await this.kv.set(WAKE_DROPS_KEY, JSON.stringify(left));
      // Read back, on `clearPendingWipe`'s rule: a stale debt is retried against a server that
      // no longer owes anything, and on a re-registered endpoint that is a live row being taken
      // down under the profile now using it.
      if ((await this.pendingWakeDrops()).some((d) => d.subscriptionId === subscriptionId)) {
        throw new StoreFault("wake_still_owed", `this phone still records a wake removal owed for "${subscriptionId}"`);
      }
    });
  }

  /**
   * Remove every pairing this phone holds — the first-launch purge (`install-marker.ts`). iOS
   * Keychain items survive an app delete and are readable again by the same bundle id, so a
   * reinstall used to open the mailbox with no ceremony. Every key is read back, and the index
   * is the last thing to go: a best-effort loop swallowed a refused `remove`, deleted the
   * index anyway, and stamped the install as purged — a live refresh token stranded under a
   * key nothing lists, never retried. The loop tries every key (a refusal on one must not skip
   * the others), reads each back, and throws if any survives, before the index is touched:
   * while a value is still there, its name is the only way back to it.
   */
  purgeAll(): Promise<void> {
    return this.enqueue(async () => {
      // AN UNREADABLE INDEX IS NOT AN EMPTY ONE, and here the difference is the whole verdict.
      // `readIndex` answers empty for a corrupt value — correct for readers, who lose a list —
      // but this walk would then find nothing to remove, report a completed purge, and leave
      // every indexed credential in the keystore under keys it never asked about. The caller
      // turns this into `purge-refused`, which retries at every launch.
      if (await this.indexUnreadable()) {
        throw new StoreFault("index_unreadable", "this phone's pairing index could not be read, so it cannot be purged");
      }
      const idx = await this.readIndex();
      const survivors: string[] = [];
      for (const id of idx.ids) {
        try {
          await this.kv.remove(`${PREFIX}.${id}`);
        } catch {
          /* the read-back below is the judge, not this catch */
        }
        // `kv.get` and not `readProfile`: an unparseable value reads as `null` there, and for a
        // purge "still present" is the question, not "still valid".
        if ((await this.kv.get(`${PREFIX}.${id}`)) !== null) survivors.push(id);
      }
      if (survivors.length > 0) {
        throw new StoreFault("purge_refused",
          `the keystore refused to purge ${survivors.length} pairing(s) (${survivors.join(", ")}) — ` +
            `their credentials are still on this phone`,
        );
      }
      // The wake queue goes too: its entries name profiles that are being purged, so a retry
      // after this could only ever present a credential that no longer exists.
      try {
        await this.kv.remove(WAKE_DROPS_KEY);
      } catch {
        /* the index below is what makes the purge real; this is tidying */
      }
      await this.kv.remove(PREFIX);
      if ((await this.kv.get(PREFIX)) !== null) {
        throw new StoreFault("index_not_removed", "the keystore refused to remove the pairing index");
      }
    });
  }
}
