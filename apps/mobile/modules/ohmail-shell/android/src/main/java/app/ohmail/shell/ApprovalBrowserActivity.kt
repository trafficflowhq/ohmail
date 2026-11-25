package app.ohmail.shell

import android.app.Activity
import android.os.Bundle
import android.view.MenuItem
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProcessGlobalConfig
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.net.URI

/** No bridge, external intents, or network route outside this sign-in's HTTPS origin. */
class ApprovalBrowserActivity : Activity() {
  private var web: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val start = uri(intent.getStringExtra(URL))
    val cookie = intent.getStringExtra(COOKIE)
    val host = start?.host
    if (start == null || cookie == null || host == null || start.scheme != "https" || start.rawUserInfo != null) {
      end(FAILED)
      return
    }

    val selectedPort = port(start)
    val pinned: (String?) -> Boolean = { value ->
      val next = uri(value)
      next != null && next.scheme == "https" && next.rawUserInfo == null &&
        host.equals(next.host, ignoreCase = true) && port(next) == selectedPort
    }
    try {
      // Proxy override applies to a process's WebViews. This activity has its own process and
      // data directory so the bundled shell keeps its sealed network and its own storage.
      if (!prepareWebView() || !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
        end(FAILED)
        return
      }
      title = start.rawAuthority
      actionBar?.setDisplayHomeAsUpEnabled(true)
      val proxy = ProxyConfig.Builder()
        .addProxyRule("http://127.0.0.1:9")
        .removeImplicitRules()
        .addBypassRule("https://$host:$selectedPort")
        .build()
      ProxyController.getInstance().setProxyOverride(proxy, { runOnUiThread(it) }) {
        if (!isFinishing && !isDestroyed) {
          clearSiteData {
            if (!isFinishing && !isDestroyed) show(start.toString(), cookie, pinned)
          }
        }
      }
    } catch (_: RuntimeException) {
      end(FAILED)
    }
  }

  override fun onOptionsItemSelected(item: MenuItem): Boolean {
    if (item.itemId != android.R.id.home) return super.onOptionsItemSelected(item)
    end(RESULT_CANCELED)
    return true
  }

  private fun show(start: String, cookie: String, pinned: (String?) -> Boolean) {
    val view = WebView(this)
    web = view
    view.visibility = View.INVISIBLE
    view.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      allowFileAccess = false
      allowContentAccess = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      setSupportMultipleWindows(true)
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    view.webChromeClient = object : WebChromeClient() {}
    view.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (pinned(request.url.toString())) return false
        if (request.isForMainFrame) end(WRONG_SERVER)
        return true
      }

      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (pinned(request.url.toString())) return null
        if (request.isForMainFrame) runOnUiThread { end(WRONG_SERVER) }
        return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
      }

      override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
        view.visibility = View.INVISIBLE
        if (!pinned(url)) end(WRONG_SERVER)
      }

      override fun onPageCommitVisible(view: WebView, url: String?) {
        if (pinned(url) && !isFinishing) view.visibility = View.VISIBLE
        else if (!pinned(url)) end(WRONG_SERVER)
      }

      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) end(if (pinned(request.url.toString())) FAILED else WRONG_SERVER)
      }

      override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
        end(FAILED)
        return true
      }
    }
    setContentView(view)
    CookieManager.getInstance().setCookie(start, cookie) { stored ->
      if (!isFinishing && !isDestroyed) {
        if (stored) view.loadUrl(start) else end(FAILED)
      }
    }
  }

  private fun end(result: Int) {
    if (isFinishing || isDestroyed) return
    web?.visibility = View.INVISIBLE
    web?.stopLoading()
    setResult(result)
    finish()
  }

  private fun clearSiteData(done: (() -> Unit)? = null) {
    WebStorage.getInstance().deleteAllData()
    CookieManager.getInstance().removeAllCookies {
      CookieManager.getInstance().flush()
      done?.invoke()
    }
  }

  override fun onDestroy() {
    web?.let {
      it.clearCache(true)
      (it.parent as? android.view.ViewGroup)?.removeView(it)
      it.destroy()
      clearSiteData()
    }
    web = null
    super.onDestroy()
  }

  private fun prepareWebView(): Boolean {
    if (prepared) return true
    if (!WebViewFeature.isStartupFeatureSupported(this, WebViewFeature.STARTUP_FEATURE_SET_DATA_DIRECTORY_SUFFIX)) {
      return false
    }
    ProcessGlobalConfig.apply(ProcessGlobalConfig().setDataDirectorySuffix(this, "approval"))
    prepared = true
    return true
  }

  companion object {
    const val URL = "approvalUrl"
    const val COOKIE = "approvalCookie"
    const val WRONG_SERVER = Activity.RESULT_FIRST_USER
    const val FAILED = Activity.RESULT_FIRST_USER + 1
    private var prepared = false

    private fun uri(value: String?): URI? = try { value?.let(::URI) } catch (_: java.net.URISyntaxException) { null }
    private fun port(url: URI) = if (url.port == -1) 443 else url.port
  }
}
