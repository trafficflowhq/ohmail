const {
  createRunOncePlugin, withAndroidManifest, withEntitlementsPlist, withInfoPlist, AndroidConfig,
} = require("expo/config-plugins");
const { VARIANTS, variantOfAppId } = require("../variant-config");

/**
 * THE SWITCH BETWEEN THE TWO APPS, AS EACH APP DECLARES IT. Read from the app's own row of `variants.json`, found by
 * the identifier the resolved configuration names.
 *
 * Android: a permission of level "signature" that both apps of a pair declare and use, so the system grants it only
 * between apps signed with one key, without asking anyone; the door the other app opens is an alias of the main
 * activity that only a holder of that permission may start, with no intent filter (nothing reaches it by a link or an
 * action, only a call that names it); `<queries>` names the sibling and the store's own app, the only packages this
 * app may see; the sibling's identifier is written for the native module to read; the switch's provider answers the
 * sibling's one question at the row's authority, exported under the pair's permission (the system checks it for the
 * provider's reads and writes, which answer nothing; its one call checks its caller itself). No verified link is
 * declared.
 *
 * iPhone: where the switch's link lands, for the native module to read (this app's host and path, and the sibling's);
 * the associated domain only where the row says so or the simulator rig asks (`OHMAIL_IOS_ASSOCIATED=1`). Absent, no
 * entitlement is added and today's signing holds.
 */
/** The alias, relative to the app's own namespace: `<identifier>.SwitchOpen` in each app. */
const ALIAS = ".SwitchOpen";
const SIBLING_META = "switch.sibling";
const PLAY_STORE = "com.android.vending";
/** The provider's class, in the switch module's own package. */
const PROVIDER = "app.ohmail.appswitch.SwitchProvider";

function rowOf(id) {
  const found = variantOfAppId(id);
  if (found === null) throw new Error(`app-switch: the app's identifier "${id}" is in no row of variants.json`);
  return found.row;
}

const named = (list, name) => (list ?? []).some((e) => e?.$?.["android:name"] === name);

/** The manifest with the switch's lines for `row`, each written once. */
function switchManifest(manifest, row) {
  const sibling = VARIANTS[row.sibling];
  const root = manifest.manifest;
  root.permission = root.permission ?? [];
  if (!named(root.permission, row.permission)) {
    root.permission.push({ $: { "android:name": row.permission, "android:protectionLevel": "signature" } });
  }
  root["uses-permission"] = root["uses-permission"] ?? [];
  if (!named(root["uses-permission"], row.permission)) root["uses-permission"].push({ $: { "android:name": row.permission } });
  root.queries = root.queries ?? [];
  const seen = root.queries.flatMap((q) => q.package ?? []);
  const packages = [sibling.id, PLAY_STORE].filter((p) => !named(seen, p)).map((p) => ({ $: { "android:name": p } }));
  if (packages.length > 0) root.queries.push({ package: packages });
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, SIBLING_META, sibling.id);
  app["activity-alias"] = app["activity-alias"] ?? [];
  if (!named(app["activity-alias"], ALIAS)) {
    app["activity-alias"].push({
      $: {
        "android:name": ALIAS,
        "android:targetActivity": ".MainActivity",
        "android:exported": "true",
        "android:permission": row.permission,
      },
    });
  }
  app.provider = app.provider ?? [];
  if (!named(app.provider, PROVIDER)) {
    app.provider.push({
      $: {
        "android:name": PROVIDER,
        "android:authorities": row.authority,
        "android:exported": "true",
        "android:permission": row.permission,
      },
    });
  }
  return manifest;
}

/** Info.plist with where the switch's link lands, this app's and the sibling's. */
function switchInfoPlist(plist, row) {
  const sibling = VARIANTS[row.sibling];
  plist.OhmailSwitch = {
    ownHost: row.links.host, ownPath: row.links.path, siblingHost: sibling.links.host, siblingPath: sibling.links.path,
  };
  return plist;
}

/** The entitlements with this app's associated domain, only where it is asked for. */
function switchEntitlements(entitlements, row, env = process.env) {
  if (!row.iosAssociatedDomains && env.OHMAIL_IOS_ASSOCIATED !== "1") return entitlements;
  const key = "com.apple.developer.associated-domains";
  const domain = `applinks:${row.links.host}`;
  const domains = entitlements[key] ?? [];
  if (!domains.includes(domain)) entitlements[key] = [...domains, domain];
  return entitlements;
}

function withAppSwitch(config) {
  config = withAndroidManifest(config, (c) => {
    c.modResults = switchManifest(c.modResults, rowOf(c.android?.package));
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults = switchInfoPlist(c.modResults, rowOf(c.ios?.bundleIdentifier));
    return c;
  });
  return withEntitlementsPlist(config, (c) => {
    c.modResults = switchEntitlements(c.modResults, rowOf(c.ios?.bundleIdentifier));
    return c;
  });
}

module.exports = createRunOncePlugin(withAppSwitch, "app-switch", "1.0.0");
module.exports.ALIAS = ALIAS;
module.exports.PROVIDER = PROVIDER;
module.exports.switchEntitlements = switchEntitlements;
