import { HttpAdapter, OhmailEngine, SearchIndex, type EntityReader } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/** Drive the real wire encoder with the request transport supplied by the test. */
export function testHttpAdapter(options: ConstructorParameters<typeof HttpAdapter>[0]) {
  return new HttpAdapter(options);
}

/** The sample mailbox with the same engine and full-copy policy as the mounted app. */
export function fixtureMailEngine(): OhmailEngine {
  return new OhmailEngine({ adapter: new FixturesAdapter(), storePolicy: { mode: "full" } });
}

export function fixtureSearchIndex(reader: EntityReader) {
  return SearchIndex.build(reader);
}

export { feedPartition, THREAD_READ_HOLD_MS, waterlineIdOf } from "@ohmail/client-engine";
