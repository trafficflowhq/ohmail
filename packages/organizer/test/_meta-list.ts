import type { MetaRecordsList, RawMetaMessage } from "@trafficflow/core/adapters/organizer-lease";

/** A fake folder's records as the one door answers them: the records, the count and the bytes. */
export function listedOf(records: RawMetaMessage[]): MetaRecordsList {
  return { records, count: records.length, bytes: records.reduce((n, r) => n + Buffer.byteLength(r.raw, "utf8"), 0) };
}
