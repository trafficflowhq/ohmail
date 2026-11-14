package app.ohmail.shell

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * THE PHONE'S SHELL: one web view filling the screen, showing the shared views from the app's own
 * files, and the border between that page and everything native.
 *
 * The page draws letters, so it is the less trusted side. Five layers hold it, each decided here,
 * natively and at once, with no branch that waits for an answer:
 *  1. Origin. The page is served under `https://appassets.androidplatform.net/shell/` by
 *     [AssetDoor]; nothing else answers.
 *  2. Requests. Every load is intercepted; anything but a listed file is an empty 403, counted.
 *     The network is blocked, files and content are closed, cookies are off, a service worker
 *     reaches nothing, a download fetches nothing, every permission is refused.
 *  3. Navigation. The main frame stays on the start page. A link the person pressed leaves only
 *     as the web view's own navigation with the person's gesture, held here under a one-time
 *     token while the page asks; everything else is cancelled and counted. A main frame seen off
 *     the origin is destroyed and rebuilt at the start page.
 *  4. The bridge. Only the main frame of the shell's origin may post (the platform names both);
 *     every other message is dropped and counted. Native answers with data only, never source.
 *  5. The policy, sent as a header with every file and written in the page as the same meta.
 *
 * Each web view instance has an epoch, minted here. A message of another epoch is dropped, and an
 * epoch's requests die with it. The keeper's kinds are answered on this side and never reach
 * React Native's thread, which on a phone that organizes its own mailbox is the mail engine's.
 */
@SuppressLint("ViewConstructor")
class ShellView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onMessage by EventDispatcher<Map<String, Any?>>()
  private val onEpoch by EventDispatcher<Map<String, Any?>>()
  private val onLinkAsk by EventDispatcher<Map<String, Any?>>()
  private val onMailto by EventDispatcher<Map<String, Any?>>()
  private val onRefused by EventDispatcher<Map<String, Any?>>()

  private val main = Handler(Looper.getMainLooper())
  private val door = AssetDoor(context)
  private val keeper = ShellRuntime.keeper(context)
  private val random = SecureRandom()
  private val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  private var web: WebView? = null
  private var epoch = ""
  private var proxy: JavaScriptReplyProxy? = null
  private var scope: String? = null
  private var held: Held? = null
  private val ends = ArrayDeque<Long>()
  private val pieces = HashMap<Long, StringBuilder>()

  private data class Held(val token: String, val epoch: String, val uri: Uri, val at: Long)

  /*
   * React Native places this view and never lays out what is added inside it afterwards, so a web view
   * added once the scope arrives would stay 0 by 0: a blank screen. Expo's switch lays it out on each add.
   */
  override val shouldUseAndroidLayout: Boolean = true

  init {
    ShellRuntime.attach(this)
  }

  /** The view itself goes: its web view, and its place among the live views. */
  fun dispose() {
    destroyWeb()
    ShellRuntime.detach(this)
  }

  /** A new web view at the start page, a new epoch: the page starts over from its keeper. */
  fun rebuild() {
    destroyWeb()
    val live = scope
    if (live != null && Keeper.SCOPE.matches(live)) build()
  }

  // ── what React Native sets ────────────────────────────────────────────────────────────────────────

  /** The live scope. A change of scope is a new page: never an in-place remount. */
  fun setScope(next: String?) {
    if (next == scope) return
    scope = next
    destroyWeb()
    if (next != null && Keeper.SCOPE.matches(next)) build()
  }

  // ── the web view ──────────────────────────────────────────────────────────────────────────────────

  private fun build() {
    val reading = WebViewCheck.read(context)
    if (!reading.usable) {
      onRefused(mapOf("why" to "webview") + reading.toMap())
      return
    }
    if (door.csp == null) {
      onRefused(mapOf("why" to "noShell"))
      return
    }
    // The network goes nowhere before the first page loads (`ShellRuntime.sealNetwork`); a scope that changed meanwhile builds its own.
    val asked = scope
    ShellRuntime.sealNetwork {
      if (scope == asked && web == null && asked != null && Keeper.SCOPE.matches(asked)) make()
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun make() {
    WebView.setWebContentsDebuggingEnabled(debuggable)
    val w = WebView(context)
    w.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      blockNetworkLoads = true
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      setGeolocationEnabled(false)
      // On, so a press inside a letter's frame (whose sandbox forbids moving the page) reaches `onCreateWindow`.
      setSupportMultipleWindows(true)
      javaScriptCanOpenWindowsAutomatically = false
      mediaPlaybackRequiresUserGesture = true
      setSupportZoom(false)
      if (Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = false
    }
    CookieManager.getInstance().setAcceptCookie(false)
    CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
    sealServiceWorkers()
    w.webViewClient = Client()
    w.webChromeClient = Chrome()
    w.setDownloadListener { _, _, _, _, _ -> ShellRuntime.count("downloads") }
    /* Before any script of the page's: no peer connection in the page's frame, which no proxy carries and no policy
       stops. A child frame a page taken over makes itself (about:blank, srcdoc) is not reached: the residual. */
    WebViewCompat.addDocumentStartJavaScript(w, UNWIRED, setOf(APP_ORIGIN))
    epoch = mint(16)
    proxy = null
    pieces.clear()
    val thisEpoch = epoch
    WebViewCompat.addWebMessageListener(w, BRIDGE_NAME, setOf(APP_ORIGIN)) { _, message, origin, isMainFrame, reply ->
      receive(thisEpoch, message, origin, isMainFrame, reply)
    }
    addView(w, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    web = w
    onEpoch(mapOf("epoch" to epoch))
    w.loadUrl("$APP_ORIGIN$START_PATH?epoch=$epoch")
  }

  private fun sealServiceWorkers() {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) return
    val sw = ServiceWorkerControllerCompat.getInstance()
    sw.setServiceWorkerClient(object : ServiceWorkerClientCompat() {
      override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse = door.answer("SW", request.url)
    })
    sw.serviceWorkerWebSettings.apply {
      blockNetworkLoads = true
      allowFileAccess = false
      allowContentAccess = false
    }
  }

  fun destroyWeb() {
    held = null
    proxy = null
    pieces.clear()
    epoch = ""
    web?.let {
      removeView(it)
      it.destroy()
    }
    web = null
  }

  /** The platform's rule for a web view whose process ended: remove it, destroy it, make a new one. */
  private fun processEnded(crashed: Boolean) {
    val ended = epoch
    destroyWeb()
    ShellRuntime.count(if (crashed) "rendererCrashed" else "rendererKilled")
    val now = SystemClock.elapsedRealtime()
    ends.addLast(now)
    while (ends.isNotEmpty() && now - ends.first() > END_WINDOW_MS) ends.removeFirst()
    if (ends.size > ENDS_BEFORE_SENTENCE) {
      onRefused(mapOf("why" to "ended", "epoch" to ended))
      return
    }
    if (scope != null) build()
  }

  // ── the bridge ────────────────────────────────────────────────────────────────────────────────────

  private fun receive(at: String, message: WebMessageCompat, origin: Uri, isMainFrame: Boolean, reply: JavaScriptReplyProxy) {
    if (!isMainFrame || origin.toString() != APP_ORIGIN || at != epoch || epoch.isEmpty()) {
      ShellRuntime.count("bridgeDropped")
      return
    }
    val text = message.data ?: return ShellRuntime.count("bridgeDropped")
    val head = try { JSONObject(text) } catch (e: Exception) { return ShellRuntime.count("bridgeDropped") }
    if (head.optString("epoch") != epoch) return ShellRuntime.count("bridgeDropped")
    proxy = reply
    when (head.optString("kind")) {
      "piece" -> takePiece(head)
      "joined" -> join(head, origin, isMainFrame)
      else -> route(text, head, origin, isMainFrame)
    }
  }

  private fun takePiece(head: JSONObject) {
    val id = head.optLong("id", -1)
    val chunk = head.optString("chunk", "")
    val buf = pieces.getOrPut(id) { StringBuilder() }
    if (id < 0 || buf.length + chunk.length > JOINED_MAX) {
      pieces.remove(id)
      return ShellRuntime.count("bridgeDropped")
    }
    buf.append(chunk)
  }

  private fun join(head: JSONObject, origin: Uri, isMainFrame: Boolean) {
    val whole = pieces.remove(head.optLong("id", -1))?.toString() ?: return ShellRuntime.count("bridgeDropped")
    val inner = try { JSONObject(whole) } catch (e: Exception) { return ShellRuntime.count("bridgeDropped") }
    if (inner.optLong("id", -2) != head.optLong("id", -1) || inner.optString("epoch") != epoch) return ShellRuntime.count("bridgeDropped")
    route(whole, inner, origin, isMainFrame)
  }

  private fun route(text: String, head: JSONObject, origin: Uri, isMainFrame: Boolean) {
    when (head.optString("kind")) {
      "keep", "kept", "keepRows", "keptRows" -> keep(head, epoch)
      else -> onMessage(mapOf("epoch" to epoch, "origin" to origin.toString(), "mainFrame" to isMainFrame, "data" to text))
    }
  }

  /** Data to the page of `at`, never source text. A message for an epoch that ended is dropped. */
  fun post(at: String, json: String) {
    main.post {
      val p = proxy
      if (at.isEmpty() || at != epoch || p == null) return@post ShellRuntime.count("postDropped")
      p.postMessage(json)
    }
  }

  private fun answer(at: String, id: Long, body: JSONObject) {
    body.put("id", id).put("epoch", at)
    post(at, body.toString())
  }

  private fun refused(at: String, id: Long, why: String) = answer(at, id, JSONObject().put("ok", false).put("refused", why))

  /**
   * The keeper's four kinds, answered here and never on React Native's thread. The partition is
   * the live scope, whatever the page names; a row write under another scope is refused. A word's
   * refusal is remembered under the live scope, and `kept` names the live scope's refusals alone.
   */
  private fun keep(m: JSONObject, at: String) {
    val id = m.optLong("id", -1)
    val live = scope ?: return refused(at, id, "notReady")
    when (m.optString("kind")) {
      "keep" -> {
        val key = m.opt("key") as? String ?: return refused(at, id, "malformed")
        val value = when (val v = m.opt("value")) { JSONObject.NULL -> null; is String -> v; else -> return refused(at, id, "malformed") }
        keeper.run({ keeper.keep(live, key, value) }, false) { ok ->
          if (!ok) ShellRuntime.count("keeperRefused")
          answer(at, id, JSONObject().put("ok", true).put("kept", ok))
        }
      }
      "kept" -> keeper.run({ keeper.kept(live)?.let { it to keeper.refused(live) } }, null) { reading ->
        if (reading == null) return@run refused(at, id, "notKept")
        val words = JSONArray()
        for ((k, v) in reading.first) words.put(JSONArray().put(k).put(v))
        val names = JSONArray()
        for ((k, digest) in reading.second) names.put(JSONArray().put(k).put(digest ?: JSONObject.NULL))
        answer(at, id, JSONObject().put("ok", true).put("words", words).put("refused", names))
      }
      "keepRows" -> {
        if (m.optString("scope") != live) return refused(at, id, "foreignScope")
        val puts = rowsOf(m.optJSONArray("puts")) ?: return refused(at, id, "malformed")
        val deletes = pairsOf(m.optJSONArray("deletes")) ?: return refused(at, id, "malformed")
        keeper.run({ keeper.keepRows(live, puts, deletes) }, false) { ok ->
          if (!ok) ShellRuntime.count("keeperRefused")
          answer(at, id, JSONObject().put("ok", true).put("kept", ok))
        }
      }
      "keptRows" -> {
        if (m.optString("scope") != live) return refused(at, id, "foreignScope")
        keeper.run({ keeper.keptRows(live) }, null) { rows ->
          if (rows == null) return@run refused(at, id, "notKept")
          val out = JSONArray()
          for (r in rows) out.put(JSONObject().put("type", r.type).put("id", r.id).put("json", r.json))
          answer(at, id, JSONObject().put("ok", true).put("rows", out))
        }
      }
    }
  }

  // ── links out ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * A press the person made on a link: the web view's own top-level request, marked by the web view
   * as a gesture. Held under a token while the page asks; one at a time; it dies with the epoch or
   * after a minute. Everything else that would leave the start page is cancelled and counted.
   */
  private fun navigation(request: WebResourceRequest): Boolean {
    if (!request.isForMainFrame) {
      ShellRuntime.count("frameNavigationCancelled")
      return true
    }
    if (!request.hasGesture()) {
      ShellRuntime.count("navigationCancelled")
      return true
    }
    pressed(request.url)
    return true
  }

  /** A link the person pressed: a letter to write goes to the page's composer; an address to leave for is held and asked. */
  private fun pressed(uri: Uri) {
    val scheme = uri.scheme?.lowercase()
    if (scheme == "mailto") {
      // A letter to write: the page's own composer takes it, parsed once on the native side.
      onMailto(mapOf("epoch" to epoch, "url" to uri.toString()))
      return
    }
    if (scheme !in LEAVES || uri.host == APP_HOST || (scheme == "tel" && !TEL.matches(uri.schemeSpecificPart ?: ""))) {
      ShellRuntime.count("navigationCancelled")
      return
    }
    val token = mint(16)
    held = Held(token, epoch, uri, SystemClock.elapsedRealtime())
    onLinkAsk(mapOf("epoch" to epoch, "token" to token, "url" to uri.toString()))
  }

  /**
   * A NEW WINDOW THE PERSON'S PRESS ASKED FOR: how a link inside a letter's frame leaves, since the frame's sandbox
   * forbids moving the page. It is handed a web view that loads nothing (no script, no network, every request
   * refused), only to be told the address the press named; that address goes to the same hold and ask, and the
   * view is destroyed. A window asked for without a press is refused and counted.
   */
  private fun newWindow(isUserGesture: Boolean, resultMsg: android.os.Message?): Boolean {
    val transport = resultMsg?.obj as? WebView.WebViewTransport
    if (!isUserGesture || transport == null || web == null) {
      ShellRuntime.count("windowRefused")
      return false
    }
    val named = WebView(context)
    var gone = false
    val drop = {
      if (!gone) {
        gone = true
        named.destroy()
      }
    }
    named.settings.apply {
      javaScriptEnabled = false
      blockNetworkLoads = true
      allowFileAccess = false
      allowContentAccess = false
      setSupportMultipleWindows(false)
    }
    named.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
        door.answer("WINDOW", request.url)

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (!gone) pressed(request.url)
        main.post(drop)
        return true
      }
    }
    transport.webView = named
    resultMsg.sendToTarget()
    // A window that names no address (a form, a blank one) is dropped all the same.
    main.postDelayed(drop, WINDOW_MS)
    return true
  }

  /** Opens what is held under `token`, once. Anything else opens nothing. */
  fun openHeld(token: String): Boolean {
    val h = held ?: return false
    held = null
    if (h.token != token || h.epoch != epoch || SystemClock.elapsedRealtime() - h.at > HELD_MS) return false
    val intent = if (h.uri.scheme == "tel") Intent(Intent.ACTION_DIAL, h.uri) else Intent(Intent.ACTION_VIEW, h.uri)
    intent.addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
      context.startActivity(intent)
      true
    } catch (e: ActivityNotFoundException) {
      false
    }
  }

  private inner class Client : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse = door.answer(request)

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = navigation(request)

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
      val u = url?.let { Uri.parse(it) }
      if (u == null || u.scheme != "https" || u.host != APP_HOST || u.path != START_PATH) {
        ShellRuntime.count("offOrigin")
        main.post {
          destroyWeb()
          if (scope != null) build()
        }
      }
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      if (view !== web) return true
      processEnded(detail.didCrash())
      return true
    }
  }

  private inner class Chrome : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest) {
      ShellRuntime.count("permissionDenied")
      request.deny()
    }

    override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) {
      ShellRuntime.count("permissionDenied")
      callback.invoke(origin, false, false)
    }

    override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?): Boolean =
      if (view !== web) {
        ShellRuntime.count("windowRefused")
        false
      } else {
        newWindow(isUserGesture, resultMsg)
      }

    override fun onShowFileChooser(
      view: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?,
    ): Boolean {
      callback?.onReceiveValue(null)
      return true
    }

    /** Counted by level, never forwarded: a console line may carry a letter's words. */
    override fun onConsoleMessage(m: ConsoleMessage): Boolean {
      ShellRuntime.count("console." + m.messageLevel().name.lowercase())
      return true
    }
  }

  private fun mint(bytes: Int): String {
    val b = ByteArray(bytes)
    random.nextBytes(b)
    return b.joinToString("") { "%02x".format(it) }
  }

  private fun rowsOf(a: JSONArray?): List<Keeper.Row>? {
    if (a == null) return null
    return (0 until a.length()).map { i ->
      val r = a.optJSONObject(i) ?: return null
      val type = r.opt("type") as? String ?: return null
      val id = r.opt("id") as? String ?: return null
      val json = r.opt("json") as? String ?: return null
      Keeper.Row(type, id, json)
    }
  }

  private fun pairsOf(a: JSONArray?): List<Pair<String, String>>? {
    if (a == null) return null
    return (0 until a.length()).map { i ->
      val p = a.optJSONArray(i) ?: return null
      val first = p.opt(0) as? String ?: return null
      val second = p.opt(1) as? String ?: return null
      first to second
    }
  }

  private companion object {
    const val BRIDGE_NAME = "ohmailShell"
    const val END_WINDOW_MS = 60_000L
    const val ENDS_BEFORE_SENTENCE = 3
    const val HELD_MS = 60_000L
    const val JOINED_MAX = 96 * 1024 * 1024
    /** How long a window a press asked for may take to name its address. */
    const val WINDOW_MS = 5_000L
    val LEAVES = setOf("https", "http", "tel")
    val TEL = Regex("^[0-9+ ()./-]{1,32}$")
    /** Run in each document the shell's origin loads, before its own script: the peer connection's constructors are gone. */
    const val UNWIRED =
      "(function(){for(var n of ['RTCPeerConnection','webkitRTCPeerConnection']){" +
        "try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch(e){}}})();"
  }
}
