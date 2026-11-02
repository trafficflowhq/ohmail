import { eq, and, inArray, sql } from "drizzle-orm";
import type { Tx } from "./change-log.js";
import { listAddresses } from "./schema-mail.js";
import { dialect } from "./dialect/index.js";

/** Addresses per statement: under every store's bound-parameter limit. */
export const LIST_ADDRESS_CHUNK = 500;

/**
 * The list addresses one account records from List-Post before a new one needs a person's consent
 * to it (a person-written allow rule, or a contact that is not inferred): the header is the
 * sender's to write, so a forged one must not grow the table without bound.
 */
export const LIST_ADDRESSES_PER_ACCOUNT_MAX = 1000;

/**
 * THE ACCOUNT'S LIST ADDRESSES (mail 0150), each with the brands a person's press consented under
 * it: every row, or only those `among` names (lower-cased by the caller). The device store hands
 * the JSON column back as text, so both shapes are read.
 */
export async function readListAddresses(
  tx: Tx, accountId: string, among?: readonly string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const columns = { address: listAddresses.address, brands: listAddresses.consentedBrands };
  const keep = (rows: { address: string; brands: unknown }[]) => {
    for (const r of rows) out.set(r.address, new Set(listBrandsOf(r.brands)));
  };
  if (among === undefined) {
    keep(await tx.select(columns).from(listAddresses).where(eq(listAddresses.accountId, accountId)));
    return out;
  }
  const keys = [...new Set(among)];
  for (let at = 0; at < keys.length; at += LIST_ADDRESS_CHUNK) {
    keep(await tx.select(columns).from(listAddresses).where(and(
      eq(listAddresses.accountId, accountId), inArray(listAddresses.address, keys.slice(at, at + LIST_ADDRESS_CHUNK)),
    )));
  }
  return out;
}

/** A stored `consented_brands` value as strings: a JSON array on the server, JSON text on a device. */
export function listBrandsOf(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? v.filter((b): b is string => typeof b === "string" && b !== "") : [];
}

/**
 * THE LIST ROW, LOCKED for the rest of the transaction (a device store has one writer and no row
 * lock): a press takes it before its first delta, the order ingest keeps, and writes the brands it
 * moved later. False when no list named the address.
 */
export async function lockListAddress(tx: Tx, accountId: string, address: string): Promise<boolean> {
  const d = dialect(tx);
  const rows = await d.exec(tx, sql`select 1 from ${listAddresses}
    where ${listAddresses.accountId} = ${d.castUuid(accountId)} and ${listAddresses.address} = ${address} ${d.lockClause()}`);
  return rows.length > 0;
}

/**
 * A PERSON'S PRESS CONSENTS THESE BRANDS UNDER A LIST ADDRESS, and nothing else writes one. UPDATE
 * only: an address no list named keeps no row. The caller holds the account's rule-key lock, which
 * the reset holds too, so the read and the write cannot lose a brand. False when no row exists.
 */
export async function consentListBrands(
  tx: Tx, accountId: string, address: string, brands: readonly string[],
): Promise<boolean> {
  const held = (await readListAddresses(tx, accountId, [address])).get(address);
  if (held === undefined) return false;
  const next = [...new Set([...held, ...brands.filter((b) => b !== "")])].sort();
  if (next.length === held.size) return true;
  await tx.update(listAddresses).set({ consentedBrands: next })
    .where(and(eq(listAddresses.accountId, accountId), eq(listAddresses.address, address)));
  return true;
}

/** A consent reset: every brand forgotten, every row kept. The list fact is the mailbox's. */
export async function forgetListConsents(tx: Tx, accountId: string): Promise<void> {
  await tx.update(listAddresses).set({ consentedBrands: [] }).where(eq(listAddresses.accountId, accountId));
}
