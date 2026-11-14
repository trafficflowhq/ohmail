/**
 * The sample world's adapter: an `EngineAdapter` that serves `getFixtures()` and issues no request.
 * Its own entry (`@ohmail/testing/adapter`) because it needs the engine and the corpus does not.
 */
export { DEMO_NOW, FixturesAdapter, parseFixtureTime, type FixturesAdapterOptions } from "./adapters/fixtures-adapter.js";
