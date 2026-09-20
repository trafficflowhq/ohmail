const { withAppDelegate, withInfoPlist, createRunOncePlugin } = require("expo/config-plugins");

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE WINDOW BELONGS TO THE SCENE — iOS 27 traps an app that still makes its own
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Expo SDK 57's template hands every app the classic AppDelegate: `didFinishLaunching` builds
 * `UIWindow(frame: UIScreen.main.bounds)` and starts React Native inside it. Compiled against the
 * iOS 27 SDK that is fatal — UIKit stops at scene creation in
 * `__UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` and the app never draws.
 * Compiled against iOS 26 it launches, but into a legacy compatibility window: on an iPhone Duo
 * the app is given 375x667 pt scaled up to the display instead of its real 466x678 pt closed face,
 * so every layout decision downstream is made about a canvas the device does not have.
 *
 * Neither react-native 0.86.2 nor expo 57.0.9 adopts scenes — no SceneDelegate and no
 * `UIApplicationSceneManifest` anywhere in either package; expo's own AppDelegate still carries a
 * "TODO: Configuring and Discarding Scenes". So this plugin supplies both: the manifest, naming one
 * application-role configuration, and a `SceneDelegate` appended to the generated AppDelegate.
 * The scene owns the window and starts React Native through
 * `RCTReactNativeFactory.startReactNative(withModuleName:in:launchOptions:)`, which already takes
 * the window from its caller — so nothing about how the app boots changes, only who makes it.
 *
 * ── WHAT UIKIT STOPS CALLING ─────────────────────────────────────────────────────────────────
 *
 * Adopting scenes moves URL opens and user activities off the app delegate, so the scene forwards
 * both back to it or every deep link and universal link silently stops arriving. A COLD link also
 * stops appearing in `launchOptions` — which is exactly where `RCTLinkingManager.getInitialURL`
 * reads it — so the scene puts it back before starting the bundle and then delivers it the warm way
 * as well, which is what UIKit does for an app that has not adopted scenes. The four app-lifecycle
 * callbacks are forwarded on the same principle: at SDK 57 no installed subscriber implements them
 * and React Native's AppState rides `UIApplicationDidBecomeActiveNotification` and its siblings,
 * but the forward keeps the app delegate's contract instead of betting on that staying true.
 *
 * Android is untouched by construction: both mods below are iOS-only.
 */

/** The scene delegate's Objective-C name. The Info.plist and the Swift class must spell it alike. */
const SCENE_DELEGATE_CLASS = "SceneDelegate";

/** Makes the AppDelegate mod idempotent, and greppable in the generated project. */
const MARKER = "// ohmail: the window belongs to the scene — see plugins/with-ios-scene-lifecycle.js";

/** One window, one scene: this app has never had a second one and must not gain one by default. */
const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      {
        UISceneConfigurationName: "Default Configuration",
        UISceneDelegateClassName: SCENE_DELEGATE_CLASS,
      },
    ],
  },
};

/* The template's own lines, anchored exactly. Indentation is tolerated; the shape is not. */
const CLASSIC_WINDOW =
  /[ \t]*#if os\(iOS\) \|\| os\(tvOS\)\n[ \t]*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n[ \t]*factory\.startReactNative\(\n[ \t]*withModuleName: "main",\n[ \t]*in: window,\n[ \t]*launchOptions: launchOptions\)\n[ \t]*#endif\n/;

const WINDOW_PROPERTY = /^[ \t]*var window: UIWindow\?[ \t]*\n/m;

/* The app delegate keeps the launch options for the scene, which connects after it returns. */
const KEEP_LAUNCH_OPTIONS = `    ${MARKER}\n    sceneLaunchOptions = launchOptions\n`;
const LAUNCH_OPTIONS_PROPERTY = "  var sceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?\n";

const SCENE_DELEGATE = `
${MARKER}
@objc(${SCENE_DELEGATE_CLASS})
class ${SCENE_DELEGATE_CLASS}: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = self.appDelegate,
          let factory = appDelegate.reactNativeFactory else {
      return
    }

    // A cold link arrives in the connection options, never in launchOptions, and getInitialURL
    // reads launchOptions — so put it back before the bundle starts, then deliver it warm as well,
    // which is what UIKit does for an app that has not adopted scenes.
    var launchOptions = appDelegate.sceneLaunchOptions ?? [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }
    if let activity = connectionOptions.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        "UIApplicationLaunchOptionsUserActivityKey": activity,
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType
      ]
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)

    self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    for activity in connectionOptions.userActivities {
      self.scene(scene, continue: activity)
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = self.appDelegate else {
      return
    }
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = self.appDelegate else {
      return
    }
    _ = appDelegate.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }
}
`;

/** The manifest, written whole so a half-written one from an older run cannot survive a rerun. */
function addSceneManifest(infoPlist) {
  return { ...infoPlist, UIApplicationSceneManifest: SCENE_MANIFEST };
}

/**
 * Move the window from the app delegate to a scene delegate. REFUSES rather than applying
 * nothing: a silent no-op here ships an app that traps at launch on the current SDK, and the
 * template changing shape is the one way that becomes possible.
 */
function adoptSceneLifecycle(contents) {
  if (contents.includes(MARKER)) return contents;
  if (!CLASSIC_WINDOW.test(contents)) {
    throw new Error(
      "with-ios-scene-lifecycle: the template's `window = UIWindow(frame: UIScreen.main.bounds)` " +
        "block is not in AppDelegate.swift. Expo's template changed shape — re-read it and move " +
        "the window by hand rather than shipping a build that traps at launch on iOS 27.",
    );
  }
  if (!WINDOW_PROPERTY.test(contents)) {
    throw new Error(
      "with-ios-scene-lifecycle: AppDelegate.swift declares no `var window: UIWindow?`. The app " +
        "delegate must not keep the window once scenes are adopted; re-read the template.",
    );
  }
  return `${contents
    .replace(CLASSIC_WINDOW, KEEP_LAUNCH_OPTIONS)
    .replace(WINDOW_PROPERTY, LAUNCH_OPTIONS_PROPERTY)}${SCENE_DELEGATE}`;
}

const withIosSceneLifecycle = (config) => {
  let next = withInfoPlist(config, (cfg) => {
    cfg.modResults = addSceneManifest(cfg.modResults);
    return cfg;
  });
  next = withAppDelegate(next, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error(
        `with-ios-scene-lifecycle: AppDelegate is ${cfg.modResults.language}, not Swift. The ` +
          "scene delegate below is Swift; port it rather than leaving the window on the app delegate.",
      );
    }
    cfg.modResults.contents = adoptSceneLifecycle(cfg.modResults.contents);
    return cfg;
  });
  return next;
};

module.exports = createRunOncePlugin(withIosSceneLifecycle, "ohmail-ios-scene-lifecycle", "1.0.0");
module.exports.SCENE_DELEGATE_CLASS = SCENE_DELEGATE_CLASS;
module.exports.SCENE_MANIFEST = SCENE_MANIFEST;
module.exports.MARKER = MARKER;
module.exports.addSceneManifest = addSceneManifest;
module.exports.adoptSceneLifecycle = adoptSceneLifecycle;
