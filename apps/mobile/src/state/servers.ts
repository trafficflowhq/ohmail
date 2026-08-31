/**
 * THE SERVER-PROFILE STORE — every pairing this phone holds, in the device keystore.
 *
 * A profile is one pairing: `{origin, flavor, accountId, refreshToken}`. The list persists in
 * **expo-secure-store** (bound in `servers-native.ts`; tests inject a memory KV through the
 * same two-method seam this module actually uses). That storage choice is the posture: the
 * refresh token is a long-lived credential that can open a mailbox, and the keystore —
 * iOS Keychain, Android Keystore-encrypted storage — is readable by this app alone, which is
 * strictly stronger than the browser client's localStorage-behind-CSP. Nothing secret ever
 * leaves this store except into the BearerManager's memory.
 *
 * ── SHAPE ON DISK ────────────────────────────────────────────────────────────────────────────
 *
 * One small value per profile plus one index, rather than one big JSON blob, because
 * expo-secure-store is a keystore, not a database: iOS warns past 2 KB per value, and a device
 * holding several pairings would cross that in one blob. Keys are `<PREFIX>` (the index:
 * `{active, ids}`) and `<PREFIX>.<id>` (one profile each); ids are locally minted, opaque, and
 * keystore-safe (`[A-Za-z0-9]`).
 *
 * ── IDENTITY, AND WHO OWNS NORMALIZATION ─────────────────────────────────────────────────────
 *
 * A profile's identity is `(origin, accountId)` — the SAME pair `mirrorOwnerKey` names mirror
 * databases with (one mirror per (origin, account)), so profile identity and mirror
 * identity can never disagree. Multiple profiles are multiple accounts on one device; what
 * stops mirror bleed between them is the mirror's own `__owner` stamp, not this list —
 * this list only decides which mirror gets OPENED. `add()` therefore requires an
 * ALREADY-NORMALIZED origin (the pairing seam normalizes with the boot module's own
 * `normalizeOrigin` before calling in) and refuses one that is not — a lower-cased,
 * slash-trimmed origin is what keeps "same server typed twice" ONE profile and one mirror.
 *
 * Re-pairing the same (origin, account) UPDATES the standing profile in place — fresh flavor,
 * fresh refresh token, same id — which is exactly the mid-rotation-kill recovery: one
 * scan, and the dead pairing is whole again rather than duplicated.
 *
 * All mutations run through one internal chain: a single JS runtime has no true concurrency,
 * but two interleaved async read-modify-writes of the index would still lose one — the chain
 * makes every mutation see the previous one's writes.
 */

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
  refreshToken: string | null;
}

/** The persisted index — which profiles exist, which one the app boots, and what is owed. */
interface Index {
  active: string | null;
  ids: string[];
  /**
   * FORGETS THAT ARE OWED — the durable half of "forget", and it names BOTH stores.
   *
   * A forget removes a credential from the keystore and mail from a SQLite file. Those are two
   * stores, and a kill between them used to leave the mail behind for ever, because the profile
   * carrying the origin and account that NAME the mirror was already gone. So the intent is
   * written here BEFORE either store is touched, and cleared only once the deletion has been
   * read back as landed — the same "persist the decision first, execute it second" rule the
   * durability class arrived at, applied to a take-back instead of an action.
   *
   * **Each entry carries the PROFILE ID as well as the mirror key, and that pairing is
   * load-bearing.** An owner key alone made the crash boundary this exists for RESURRECT the
   * thing being forgotten: a kill after the intent was written and before
   * `remove(profileId)` left the profile standing and still ACTIVE, so the next launch
   * dutifully deleted the mirror, cleared the debt, then reconnected the pairing and drained
   * the whole mailbox back onto the phone. A forget interrupted at its documented crash point
   * came back as a paired server with the mail in it. With the id here, the launch drain
   * removes the credential FIRST and the profile can never be booted.
   *
   * `id` may be empty for an entry written before this field existed, or for a wipe owed
   * against a mirror whose profile row was already gone; the drain treats that as "mail only".
   *
   * Bounded ({@link MAX_PENDING_WIPES}) because this rides one expo-secure-store value and iOS
   * warns past 2 KB. **Overflow REFUSES the new forget; it never evicts an old one.** Dropping
   * the oldest was the obvious bound and it was this class's own defect: an unpaid debt is the
   * ONLY remaining name of a mirror still on disk, so evicting it strands that mail for ever —
   * while the screen had already promised the app would try again at startup. A refusal is
   * visible and recoverable; a silent eviction is neither.
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
 * ONE WAKE ROW THIS PHONE OWES A SERVER — the durable half of "stop waking me for that account".
 *
 * A registration is a row on the server, and taking it down is a request that can be refused.
 * Two paths hit that: a profile SWITCH (the outgoing server's row must go before the next one
 * is made, because this build shares one distributor endpoint across every profile), and a
 * registration SUPERSEDED mid-flight (the request already committed a row on a server the app
 * has since left). Both used to fire the delete and discard both the id and the verdict — so a
 * refusal left a row nothing could ever name again, dialling an endpoint that is still live and
 * therefore never produces the 404/410 the server prunes on.
 *
 * Its OWN keystore value rather than a field on the index: iOS warns past 2 KB per value, the
 * index already carries the profiles and the wipe queue, and these entries are written on a
 * path that must never make an unrelated index write fail.
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
  add(input: { origin: string; flavor: string; accountId: string; refreshToken: string }): Promise<ServerProfile> {
    return this.enqueue(async () => {
      if (input.origin !== input.origin.trim().replace(/\/+$/, "").toLowerCase()) {
        throw new Error(`profile origin must arrive normalized: "${input.origin}"`);
      }
      if (!input.accountId.trim()) throw new Error("a profile needs the server-verified account id");
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
      };
      // ── THE INDEX LEARNS THE ID BEFORE THE CREDENTIAL EXISTS ─────────────────────────────
      //
      // These two writes used to be the other way round, and the gap between them could create
      // a credential NOTHING NAMES: a kill after the profile value landed and before the index
      // did left `ohmail.servers.v1.<id>` holding a live refresh token with `<id>` in no list —
      // so the fresh-install purge, which walks `idx.ids`, never even asked for it, removed the
      // index, and let the generation be stamped as purged. Its "every key was read back" is
      // vacuous for a key it cannot name.
      //
      // Reversed, the same kill leaves an id in the list with no value behind it, which every
      // reader here already handles by construction: `list()` drops rows whose value is gone,
      // `active()` answers null, and `purgeAll` names it and removes nothing. An index entry
      // that over-names is recoverable; a credential that nothing names is not.
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
        throw new Error(`this phone could not record the pairing "${profile.id}" before storing it`);
      }
      await this.writeProfile(profile);
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
        throw new Error(`this phone still holds the pairing "${id}" — the keystore refused to forget it`);
      }
      const idx = await this.readIndex();
      await this.writeIndex({
        ...idx,
        active: idx.active === id ? null : idx.active,
        ids: idx.ids.filter((i) => i !== id),
      });
      if ((await this.readIndex()).ids.includes(id)) {
        throw new Error(`this phone still lists the pairing "${id}" — the keystore refused to forget it`);
      }
    });
  }

  /** Switch which profile the app boots. Unknown id ⇒ refused, the index untouched. */
  setActive(id: string): Promise<void> {
    return this.enqueue(async () => {
      const idx = await this.readIndex();
      if (!idx.ids.includes(id)) throw new Error(`no server profile "${id}" on this phone`);
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
      if (!held && owed.length >= MAX_PENDING_WIPES) throw new Error(WIPE_QUEUE_FULL);
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
        throw new Error(`this phone could not record that "${ownerKey}" is owed a deletion`);
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
        throw new Error(`this phone still records a deletion owed for "${ownerKey}"`);
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
      if (owed.length >= MAX_PENDING_WAKE_DROPS) throw new Error(WAKE_QUEUE_FULL);
      await this.kv.set(WAKE_DROPS_KEY, JSON.stringify([...owed, { profileId, subscriptionId }]));
      // READ BACK, for {@link Index.wipes}'s reason one queue over: a keystore `set` that
      // resolved without storing would leave the caller free to fire a delete whose only
      // retryable record does not exist.
      if (!(await this.pendingWakeDrops()).some((d) => d.subscriptionId === subscriptionId)) {
        throw new Error(`this phone could not record that wake registration "${subscriptionId}" is owed a removal`);
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
        throw new Error(`this phone still records a wake removal owed for "${subscriptionId}"`);
      }
    });
  }

  /**
   * REMOVE EVERY PAIRING THIS PHONE HOLDS — the first-launch purge (`install-marker.ts`).
   *
   * iOS Keychain items survive an app delete and are readable again by the same bundle id, so
   * a reinstall used to open the mailbox with no ceremony.
   *
   * ── EVERY KEY IS READ BACK, AND THE INDEX IS THE LAST THING TO GO ────────────────────────
   *
   * This was written best-effort per key — "one stubborn value must not keep the rest alive" —
   * and that reasoning had the take-back class's own defect inside it. A `remove` that refused
   * was swallowed, the INDEX was deleted anyway, and the caller stamped the install as purged:
   * a live refresh token would have survived the purge that claimed it, permanently stranded
   * under a key nothing lists any more and never retried. So the loop tries every key (that
   * part was right — a refusal on one must not skip the others), reads each one back, and
   * THROWS if any survives, before the index is touched. The index is what names them; while a
   * value is still there, its name is the only way back to it.
   */
  purgeAll(): Promise<void> {
    return this.enqueue(async () => {
      // AN UNREADABLE INDEX IS NOT AN EMPTY ONE, and here the difference is the whole verdict.
      // `readIndex` answers empty for a corrupt value — correct for readers, who lose a list —
      // but this walk would then find nothing to remove, report a completed purge, and leave
      // every indexed credential in the keystore under keys it never asked about. The caller
      // turns this into `purge-refused`, which retries at every launch.
      if (await this.indexUnreadable()) {
        throw new Error("this phone's pairing index could not be read, so it cannot be purged");
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
        throw new Error(
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
        throw new Error("the keystore refused to remove the pairing index");
      }
    });
  }
}
