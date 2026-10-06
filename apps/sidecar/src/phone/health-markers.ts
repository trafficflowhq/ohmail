/**
 * THE MAIL TIER'S SCHEMA MARKERS, NOT IN THIS BUILD — substituted for `./health-markers.js` where
 * `packages/api` `routes/health` imports it.
 *
 * `health.ts` reads the tier only on its Postgres arm, after the device-store arm has returned, and
 * a phone holds no Postgres handle. So a call here is a defect, and it fails by name: an empty tier
 * would census zero markers as complete and answer `schemaOk: true`. One export on purpose — a
 * list read by name from `health.ts` is then a build error here, not a quiet zero on a device.
 */
export function mailTierMarkers(): never {
  throw new Error(
    "the phone engine carries no Postgres schema markers: mailTierMarkers() was called, and only " +
      "a device store exists here",
  );
}
