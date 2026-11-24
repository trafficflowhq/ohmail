const { withAndroidManifest, createRunOncePlugin } = require("expo/config-plugins");

/**
 * THE APP INSTALLS ON DEVICES WITHOUT A PORTRAIT SCREEN.
 *
 * The app follows the device in every orientation (`"orientation": "default"`). The barcode
 * scanner's library (play-services-code-scanner, through expo-camera) ships an invisible delegate
 * activity locked to portrait, and Google Play reads any portrait-locked activity as requiring
 * `android.hardware.screen.portrait`, which hides the app from some tablets, desktops and
 * Android XR devices. The lock itself is the library's choice and stays; the app declares both
 * screen orientations optional, and the Gradle merge keeps this declaration over the implied one.
 */
const FEATURES = ["android.hardware.screen.portrait", "android.hardware.screen.landscape"];

function declareOrientationsOptional(manifest) {
  const features = (manifest.manifest["uses-feature"] ??= []);
  for (const name of FEATURES) {
    const found = features.find((f) => f.$["android:name"] === name);
    if (found) found.$["android:required"] = "false";
    else features.push({ $: { "android:name": name, "android:required": "false" } });
  }
  return manifest;
}

function withOptionalScreenOrientation(config) {
  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = declareOrientationsOptional(cfg.modResults);
    return cfg;
  });
}

module.exports = createRunOncePlugin(withOptionalScreenOrientation, "ohmail-optional-screen-orientation", "1.0.0");
