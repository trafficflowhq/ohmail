package app.ohmail.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.annotation.MainThread
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** What outlives one view: the keeper's one thread and file handles, the shell's counts, the views alive now. */
object ShellRuntime {
  private var keeper: Keeper? = null
  private val counts = ConcurrentHashMap<String, AtomicLong>()
  private val views = java.util.Collections.newSetFromMap(java.util.WeakHashMap<ShellView, Boolean>())

  @Synchronized fun keeper(context: Context): Keeper = keeper ?: Keeper(context.applicationContext).also { keeper = it }

  fun attach(view: ShellView) = synchronized(views) { views.add(view) }
  fun detach(view: ShellView) = synchronized(views) { views.remove(view) }
  fun live(): List<ShellView> = synchronized(views) { views.toList() }

  fun count(name: String) {
    counts.getOrPut(name) { AtomicLong(0) }.incrementAndGet()
  }

  private var sealed = false
  private val sealing = ArrayList<() -> Unit>()

  /**
   * EVERY WEB VIEW OF THE APP SENDS ITS NETWORK TO A PROXY NOTHING ANSWERS, set once before the shell's first page
   * loads; `then` runs once it applies (on the main thread). The page loads only the files the asset door answers,
   * which never reach the network, so nothing it needs goes through the proxy; what the network block does not stop
   * (a preconnect a page's markup asks for) goes nowhere, the phone's own loopback and link-local addresses too (no
   * implicit bypass). Port 9 on the loopback is one no app on the phone can open.
   */
  @MainThread fun sealNetwork(then: () -> Unit) {
    if (sealed) return then()
    sealing.add(then)
    if (sealing.size > 1) return
    val main = Handler(Looper.getMainLooper())
    ProxyController.getInstance().setProxyOverride(
      ProxyConfig.Builder().addProxyRule(DEAD_PROXY).removeImplicitRules().build(),
      { main.post(it) },
      {
        sealed = true
        val waiting = sealing.toList()
        sealing.clear()
        for (w in waiting) w()
      },
    )
  }

  private const val DEAD_PROXY = "http://127.0.0.1:9"

  /** Numbers only, by name: what the diagnostics may carry. */
  fun snapshot(): Map<String, Long> = counts.mapValues { it.value.get() }
}

/**
 * The shell's module: the view, and what the native side of the app asks of the shell outside a
 * view (whether this phone's web view can carry it, the counts, the keeper's take-back).
 */
class ShellModule : Module() {
  private val context: Context get() = requireNotNull(appContext.reactContext) { "no context" }

  override fun definition() = ModuleDefinition {
    Name("OhmailShell")

    Function("webViewCheck") { WebViewCheck.read(context).toMap() }

    Function("stats") { ShellRuntime.snapshot() }

    /** Where a scope's keeper and the web view's data live: what the backup claim measures. */
    Function("storagePaths") { scope: String ->
      mapOf(
        "keeper" to ShellRuntime.keeper(context).pathOf(scope),
        "webData" to java.io.File(context.applicationInfo.dataDir, "app_webview").path,
      )
    }

    AsyncFunction("keeperScopes") { ShellRuntime.keeper(context).let { k -> runOn(k, { k.scopes() }, emptyList()) } }

    AsyncFunction("keeperForget") { scope: String -> ShellRuntime.keeper(context).let { k -> runOn(k, { k.forget(scope) }, false) } }

    /** A word written by the native side itself: the old copy's intents, handed across once. */
    AsyncFunction("keeperKeep") { scope: String, key: String, value: String? ->
      ShellRuntime.keeper(context).let { k -> runOn(k, { k.keep(scope, key, value) }, false) }
    }

    AsyncFunction("keeperKeptWords") { scope: String ->
      ShellRuntime.keeper(context).let { k -> runOn(k, { k.kept(scope)?.map { listOf(it.first, it.second) } }, null) }
    }

    AsyncFunction("keeperKeepRows") { scope: String, rows: List<Map<String, String>> ->
      val puts = rows.map { Keeper.Row(it["type"] ?: "", it["id"] ?: "", it["json"] ?: "") }
      ShellRuntime.keeper(context).let { k -> runOn(k, { k.keepRows(scope, puts, emptyList()) }, false) }
    }

    AsyncFunction("keeperKeptRows") { scope: String ->
      ShellRuntime.keeper(context).let { k ->
        runOn(k, { k.keptRows(scope)?.map { mapOf("type" to it.type, "id" to it.id, "json" to it.json) } }, null)
      }
    }

    /**
     * Every scope's copy in the web view's storage, and its cookies, deleted. Every live view is taken down first, so
     * no page holds the storage while it goes, and made again after: each starts over from its keeper. Answers what
     * the storage then reads of the shell's origin (listed, and the bytes it counts there), polled until it reads
     * empty or the deadline passes; the take-back judges it. The storage goes on listing an origin it emptied.
     */
    AsyncFunction("clearWebData") { promise: Promise ->
      // No web view on this phone: the shell never made one, so it kept nothing there.
      if (!WebViewCheck.read(context).installed) return@AsyncFunction promise.resolve(reading(false, 0L))
      val live = ShellRuntime.live()
      for (view in live) view.destroyWeb()
      WebStorage.getInstance().deleteAllData()
      val cookies = CookieManager.getInstance()
      cookies.removeAllCookies {
        cookies.flush()
        readBack(SystemClock.elapsedRealtime() + CLEAR_READ_BACK_MS) { listed, usage ->
          if (listed && usage != 0L) ShellRuntime.count("webDataRemains")
          for (view in live) view.rebuild()
          promise.resolve(reading(listed, usage))
        }
      }
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)

    AsyncFunction("setFamilies") { prefixes: List<String> ->
      ShellRuntime.keeper(context).families = prefixes.filter { it.isNotEmpty() }
      true
    }

    View(ShellView::class) {
      Events("onMessage", "onEpoch", "onLinkAsk", "onMailto", "onRefused")

      Prop("scope") { view: ShellView, scope: String? -> view.setScope(scope) }

      Prop("door") { view: ShellView, door: Boolean? -> view.setDoor(door == true) }

      AsyncFunction("post") { view: ShellView, epoch: String, json: String -> view.post(epoch, json) }

      AsyncFunction("openHeld") { view: ShellView, token: String -> view.openHeld(token) }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)

      OnViewDestroys { view: ShellView -> view.dispose() }
    }
  }

  /**
   * Asks the storage what it holds under the shell's origin, until it lists none or counts no bytes there, or the
   * deadline passes; hands on the last reading. `usage` is null where the storage named the origin without a count.
   */
  private fun readBack(deadline: Long, done: (Boolean, Long?) -> Unit) {
    WebStorage.getInstance().getOrigins { origins ->
      val all = origins as? Map<*, *>
      val name = all?.keys?.firstOrNull { it.toString().trimEnd('/') == APP_ORIGIN }
      val held = name?.let { all[it] }
      val usage = (held as? WebStorage.Origin)?.usage
      when {
        held == null -> done(false, 0L)
        usage == 0L || SystemClock.elapsedRealtime() >= deadline -> done(true, usage)
        else -> Handler(Looper.getMainLooper()).postDelayed({ readBack(deadline, done) }, CLEAR_RETRY_MS)
      }
    }
  }

  private fun reading(listed: Boolean, usage: Long?): Map<String, Any?> = mapOf("listed" to listed, "usage" to usage)

  private companion object {
    const val CLEAR_READ_BACK_MS = 3_000L
    const val CLEAR_RETRY_MS = 100L
  }

  /** The keeper's work, on the keeper's thread, awaited by the caller. */
  private fun <T> runOn(k: Keeper, work: () -> T, failed: T): T {
    val latch = java.util.concurrent.CountDownLatch(1)
    var out = failed
    k.run(work, failed) { out = it; latch.countDown() }
    latch.await()
    return out
  }
}
