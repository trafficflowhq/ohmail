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

/** The persisted index — which profiles exist and which one the app boots. */
interface Index {
  active: string | null;
  ids: string[];
}

const PREFIX = "ohmail.servers.v1";

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

  private async readIndex(): Promise<Index> {
    const raw = await this.kv.get(PREFIX);
    if (raw === null) return { active: null, ids: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<Index>;
      return {
        active: typeof parsed.active === "string" ? parsed.active : null,
        ids: Array.isArray(parsed.ids) ? parsed.ids.filter((i): i is string => typeof i === "string") : [],
      };
    } catch {
      // An unreadable index loses the LIST, never a mirror: profiles re-pair with one scan
      // each, and the stranded per-profile values are overwritten by their next add().
      return { active: null, ids: [] };
    }
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
      await this.writeProfile(profile);
      await this.kv.set(PREFIX, JSON.stringify({
        active: profile.id,
        ids: existing ? idx.ids : [...idx.ids, profile.id],
      } satisfies Index));
      return profile;
    });
  }

  /** Forget a pairing on this phone. (The server's Devices list is the server-side take-back.) */
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const idx = await this.readIndex();
      await this.kv.remove(`${PREFIX}.${id}`);
      await this.kv.set(PREFIX, JSON.stringify({
        active: idx.active === id ? null : idx.active,
        ids: idx.ids.filter((i) => i !== id),
      } satisfies Index));
    });
  }

  /** Switch which profile the app boots. Unknown id ⇒ refused, the index untouched. */
  setActive(id: string): Promise<void> {
    return this.enqueue(async () => {
      const idx = await this.readIndex();
      if (!idx.ids.includes(id)) throw new Error(`no server profile "${id}" on this phone`);
      await this.kv.set(PREFIX, JSON.stringify({ active: id, ids: idx.ids } satisfies Index));
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
}
