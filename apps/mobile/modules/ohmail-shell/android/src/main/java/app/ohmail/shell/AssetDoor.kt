package app.ohmail.shell

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream

const val APP_HOST = "appassets.androidplatform.net"
const val APP_ORIGIN = "https://$APP_HOST"
const val SHELL_PREFIX = "/shell/"
const val START_PATH = "${SHELL_PREFIX}index.html"

/**
 * THE ONLY THING THE SHELL'S WEB VIEW MAY LOAD: the files the build wrote into the app's assets
 * under `shell/`, listed by name in `shell/shell.manifest.json`, served under one https origin.
 * Everything else is answered here, natively, with an empty 403 and counted: another host, another
 * path, a file the manifest does not list, a method other than GET. Nothing is fetched from the
 * network, and the page's policy (the manifest's `csp`) is sent as a header with every file.
 */
class AssetDoor(private val context: Context) {
  private val manifest: JSONObject? by lazy {
    try {
      context.assets.open("shell/shell.manifest.json").use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
    } catch (e: Exception) {
      null
    }
  }

  /** The page's policy as the build wrote it, or null when the build carries no shell. */
  val csp: String? get() = manifest?.optString("csp")?.takeIf { it.isNotEmpty() }

  fun answer(request: WebResourceRequest): WebResourceResponse = answer(request.method, request.url)

  fun answer(method: String, url: Uri): WebResourceResponse {
    val name = fileName(method, url) ?: return refuse()
    val policy = csp ?: return refuse()
    val bytes = try {
      context.assets.open("shell/$name").use { it.readBytes() }
    } catch (e: Exception) {
      return refuse()
    }
    val headers = mapOf(
      "Content-Security-Policy" to "$policy; frame-ancestors 'none'",
      "X-Content-Type-Options" to "nosniff",
      "Referrer-Policy" to "no-referrer",
      "Cache-Control" to "no-store",
    )
    return WebResourceResponse(mimeOf(name), "utf-8", 200, "OK", headers, ByteArrayInputStream(bytes))
  }

  /** The listed file this request names, or null. Read before anything opens a file. */
  private fun fileName(method: String, url: Uri): String? {
    if (method != "GET") return null
    if (url.scheme != "https" || url.host != APP_HOST || url.port != -1) return null
    val path = url.encodedPath ?: return null
    if (!path.startsWith(SHELL_PREFIX)) return null
    val name = path.removePrefix(SHELL_PREFIX)
    if (!NAME.matches(name) || name.split('/').any { it == "." || it == ".." || it.isEmpty() }) return null
    val files = manifest?.optJSONObject("files") ?: return null
    return if (files.has(name)) name else null
  }

  /** Counted as `nonAssetRequests`: 0 in every sealed session. */
  private fun refuse(): WebResourceResponse {
    ShellRuntime.count("nonAssetRequests")
    return WebResourceResponse("text/plain", "utf-8", 403, "Refused", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
  }

  private companion object {
    val NAME = Regex("^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$")
    val TYPES = mapOf(
      "html" to "text/html", "js" to "text/javascript", "css" to "text/css", "json" to "application/json",
      "svg" to "image/svg+xml", "png" to "image/png", "webp" to "image/webp", "woff2" to "font/woff2", "txt" to "text/plain",
    )
    fun mimeOf(name: String): String = TYPES[name.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
  }
}
