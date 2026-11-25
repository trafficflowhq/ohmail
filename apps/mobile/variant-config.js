/**
 * THE APP'S CONFIGURATION AS A FUNCTION OF THE VARIANT.
 *
 * `app.json` stays whole and is the ohmail app's configuration: its tests, the engine's bundler, the phone workflow
 * and the release kit read it there, and its version and build numbers are bumped there only. `app.config.js` hands
 * it here with the variant the build was asked for (`OHMAIL_VARIANT`). Unset, empty or `ohmail` returns it untouched;
 * another row of `variants.json` returns a copy made for that app; any other word is a build error, never a guess.
 *
 * The copy only renames and takes away: every plugin stays listed in `app.json`, where the plugin censuses read it,
 * and a row's `without` names what its app leaves out. Every app inherits the same version and build numbers.
 * Requires the table and nothing else (it runs inside Expo's config loader).
 */
const VARIANTS = require("./variants.json");

/** The variant a build was asked for. Unset, empty or `ohmail` is ohmail; a word outside the table throws. */
function variantIdOf(said) {
  if (said === undefined || said === null || said === "" || said === "ohmail") return "ohmail";
  if (typeof said === "string" && Object.prototype.hasOwnProperty.call(VARIANTS, said)) return said;
  throw new Error(`OHMAIL_VARIANT is "${String(said)}": it is one of ${Object.keys(VARIANTS).join(", ")}, or unset`);
}

/** The row an app's identifier names, or null: the native plugins read the row from the resolved identifier. */
function variantOfAppId(id) {
  const found = Object.entries(VARIANTS).find(([, row]) => row.id === id);
  return found ? { variant: found[0], row: found[1] } : null;
}

const nameOf = (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin);

/** The calendar app's own look: its icons, and its splash, which is its icon's foreground on paper in both schemes. */
const OHCAL_LOOK = {
  icon: "./assets/ohcal/icon-ios.png",
  adaptiveIcon: {
    foregroundImage: "./assets/ohcal/android-icon-foreground.png",
    monochromeImage: "./assets/ohcal/android-icon-monochrome.png",
    backgroundImage: "./assets/ohcal/android-icon-background.png",
  },
  splash: {
    image: "./assets/ohcal/android-icon-foreground.png",
    imageWidth: 200,
    resizeMode: "contain",
    backgroundColor: "#fbfaf9",
  },
  locales: { en: "./locales/ohcal.en.json", de: "./locales/ohcal.de.json" },
};

/** The camera's sentence in the app's own name: the pairing scan is the camera's one use in both apps. */
const cameraSentence = (name) => `${name} uses the camera only to scan a pairing QR code.`;

/** Each listed plugin as this app takes it: left out, given this app's words, or as it stands. */
function pluginFor(plugin, row) {
  const name = nameOf(plugin);
  if (row.without.plugins.includes(name)) return null;
  if (row.app !== "ohcal" || !Array.isArray(plugin)) return plugin;
  const [, options] = plugin;
  switch (name) {
    case "expo-camera":
      return [name, { ...options, cameraPermission: cameraSentence(row.name) }];
    // The calendar attaches no picture to a letter: no photo library purpose at all.
    case "expo-image-picker":
      return [name, { ...options, photosPermission: false, cameraPermission: cameraSentence(row.name) }];
    case "expo-splash-screen":
      return [name, { ...OHCAL_LOOK.splash }];
    default:
      return plugin;
  }
}

/** The configuration of the app `said` names, from ohmail's. ohmail's is returned as it came. */
function resolveVariant(base, said) {
  const variant = variantIdOf(said);
  if (variant === "ohmail") return base;
  const row = VARIANTS[variant];
  const out = structuredClone(base);
  out.name = row.name;
  out.slug = row.scheme;
  out.scheme = row.scheme;
  out.ios = { ...out.ios, bundleIdentifier: row.id };
  out.android = { ...out.android, package: row.id };
  // Confirm the calendar app's collection list against the calendar-only sync audit before submission.
  if (row.iosPrivacyCollectedDataTypes !== undefined) {
    out.ios.privacyManifests.NSPrivacyCollectedDataTypes =
      out.ios.privacyManifests.NSPrivacyCollectedDataTypes.filter(
        (entry) => row.iosPrivacyCollectedDataTypes.includes(entry.NSPrivacyCollectedDataType),
      );
  }
  if (row.app === "ohcal") {
    out.icon = OHCAL_LOOK.icon;
    out.ios.icon = OHCAL_LOOK.icon;
    out.android.adaptiveIcon = { ...OHCAL_LOOK.adaptiveIcon };
    out.locales = { ...OHCAL_LOOK.locales };
  }
  out.plugins = (out.plugins ?? []).map((p) => pluginFor(p, row)).filter((p) => p !== null);
  return out;
}

module.exports = { VARIANTS, variantIdOf, variantOfAppId, resolveVariant };
