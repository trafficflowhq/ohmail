package app.ohmail.hostpinning

import android.content.Context
import android.util.Base64
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import okhttp3.OkHttpClient
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import okhttp3.internal.tls.OkHostnameVerifier

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PINNED HOSTS — how this phone trusts one desktop's own key, and nothing else new
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A desktop running host mode serves its same-network door with a self-signed key it generated
 * once and keeps. No certificate authority will vouch for it — there is no name to vouch for, only
 * whatever address the router handed that machine — so the platform's trust store cannot judge it
 * and the pairing ceremony carries the trust instead: the QR code the person scans holds the
 * door's SPKI fingerprint, and this registry is where that fingerprint lives for as long as the
 * pairing does.
 *
 * ── WHY THIS EXISTS AT ALL, WHICH IS NOT "TO ALLOW SELF-SIGNED CERTIFICATES" ────────────────
 *
 * The same-network door used to be plain HTTP, and a release build of this app cannot open a
 * cleartext socket: `targetSdk` is past 28, so `cleartextTrafficPermitted` defaults to false and
 * the request dies with `UnknownServiceException` before a byte moves. The obvious fix is a
 * `network_security_config.xml` permitting cleartext — and it was rejected, because Android's
 * config grammar has NO CIDR syntax: there is no way to say "private ranges only", so the honest
 * spellings are a blanket exemption (every request this app makes anywhere becomes downgradable)
 * or a list of literal addresses that cannot be written for an address chosen at pairing time.
 *
 * So the transport is TLS and this is the trust decision. Which means this file makes the app's
 * posture STRICTER than a cleartext exemption would have, not looser: mail to a paired desktop is
 * encrypted and authenticated to one specific key, and cleartext stays forbidden app-wide.
 *
 * ── THE TWO HALVES, AND WHY BOTH ARE NEEDED ─────────────────────────────────────────────────
 *
 *  1. **{@link trustManager} decides whether a certificate is acceptable at all.** It accepts a
 *     leaf whose SPKI is a pinned one — bypassing chain, name and date checks, which for a pinned
 *     self-signed key are respectively impossible, meaningless and theatre — and delegates
 *     everything else to the platform's own trust manager. An unpinned self-signed certificate is
 *     therefore refused exactly as it always was.
 *  2. **{@link hostnameVerifier} decides whether that certificate belongs on THIS host.** The
 *     trust manager has only the chain, so on its own it would accept a pinned key presented from
 *     any address. The verifier has the hostname, and it binds them: a pinned host must present
 *     ITS key, and a pinned key must not appear on a host it was not pinned for. Everything else
 *     falls through to OkHttp's own verifier.
 *
 * Splitting it this way is not an implementation detail — a version with only the first half
 * would let any machine on the network that could obtain a copy of the door's certificate answer
 * for it from a different address.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────────────────────
 *
 * The registry is empty at launch and holds exactly the hosts this phone has paired with. Nothing
 * here weakens TLS for any other host: `ohmail.app`, a self-hosted box with a real certificate,
 * and every other connection this app makes are judged by the platform, unchanged.
 */
object PinnedHosts {

  /** `host:port` (host lower-cased) → the base64url SHA-256 of the door's SPKI. */
  private val pins = ConcurrentHashMap<String, String>()

  /* ── THE INSTALL, AND WHY IT IS HERE AND NOT IN THE MODULE ────────────────────────────────
   *
   * `OkHttpClientProvider` CACHES the client it built and `setOkHttpClientFactory` does not clear
   * that cache. So the factory must be in place before anything asks for a client — and a React
   * Native module's own lifecycle hook is NOT early enough: measured on a release build against a
   * real desktop door, the factory was set from `OnCreate` and never once consulted, because the
   * networking module's client already existed. Every paired-desktop handshake then failed the
   * ordinary way, which is safe and completely illegible.
   *
   * So the install lives in this static object and is called from `MainApplication.onCreate`
   * (the `host-pinning-install` config plugin puts it there), which runs before React Native
   * starts at all. The module calls it too, so a composition that loses the plugin still ends up
   * pinning — later, and the counter below is what says which path did it.
   */

  /** Set once the factory is installed. `false` ⇒ the pairing seam refuses to pin. */
  @Volatile
  var installed: Boolean = false
    private set

  /**
   * How many times the factory has actually been ASKED for a client. Zero with `installed` true
   * is the exact state that produced a wrong diagnostic in the field: the trust decision existed
   * and nothing used it. Read from JS by the census, so the difference is a measurement rather
   * than an assumption.
   */
  @Volatile
  var factoryUses: Int = 0
    private set

  /** Idempotent. Safe to call from `MainApplication.onCreate` and from the module. */
  @JvmStatic
  @Synchronized
  fun installInto(context: Context?) {
    if (installed) return
    OkHttpClientProvider.setOkHttpClientFactory(
        object : OkHttpClientFactory {
          override fun createNewNetworkModuleClient(): OkHttpClient {
            factoryUses += 1
            // `reactContext` gives the client React Native's response cache and can be absent
            // this early; its absence costs the CACHE and never the trust decision.
            return (if (context != null) OkHttpClientProvider.createClientBuilder(context)
                    else OkHttpClientProvider.createClientBuilder())
                .sslSocketFactory(socketFactory, trustManager)
                .hostnameVerifier(hostnameVerifier)
                .build()
          }
        },
    )
    installed = true
  }

  private fun key(host: String, port: Int): String = "${host.lowercase()}:$port"

  fun set(host: String, port: Int, spki: String) {
    pins[key(host, port)] = spki
  }

  fun clear(host: String, port: Int) {
    pins.remove(key(host, port))
  }

  fun clearAll() {
    pins.clear()
  }

  fun count(): Int = pins.size

  /** Every pin recorded for a host, across ports — the verifier's question. */
  private fun pinsForHost(host: String): List<String> {
    val prefix = "${host.lowercase()}:"
    return pins.entries.filter { it.key.startsWith(prefix) }.map { it.value }
  }

  private fun isPinnedKey(spki: String): Boolean = pins.containsValue(spki)

  /**
   * base64url, unpadded, of SHA-256 over the certificate's SubjectPublicKeyInfo.
   *
   * `PublicKey.getEncoded()` returns the X.509 SubjectPublicKeyInfo DER, which is byte-for-byte
   * what the desktop hashes (`spkiFingerprint`, node's `export({ type: "spki", format: "der" })`).
   * The two sides agreeing on WHICH bytes are hashed is the whole of the pin's correctness, so it
   * is stated here rather than assumed.
   */
  fun spkiOf(cert: X509Certificate): String =
      Base64.encodeToString(
          MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded),
          Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
      )

  /** The platform's own trust manager — what everything unpinned is still judged by. */
  private val platform: X509ExtendedTrustManager by lazy {
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    tmf.init(null as java.security.KeyStore?)
    tmf.trustManagers.filterIsInstance<X509ExtendedTrustManager>().firstOrNull()
        ?: throw IllegalStateException("no platform X509ExtendedTrustManager")
  }

  /**
   * `X509ExtendedTrustManager` and not the plain interface, deliberately: when a trust manager is
   * not the extended kind, the platform WRAPS it and performs its own hostname checks inside the
   * wrapper — which would refuse the door's certificate on the name, before the pin is ever
   * consulted, and look exactly like a broken pin.
   */
  val trustManager: X509ExtendedTrustManager by lazy {
    object : X509ExtendedTrustManager() {
      private fun judge(chain: Array<out X509Certificate>?, fallback: () -> Unit) {
        val leaf = chain?.firstOrNull()
        if (leaf != null && isPinnedKey(spkiOf(leaf))) return
        fallback()
      }

      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) =
          judge(chain) { platform.checkServerTrusted(chain, authType) }

      override fun checkServerTrusted(
          chain: Array<out X509Certificate>?,
          authType: String?,
          socket: Socket?,
      ) = judge(chain) { platform.checkServerTrusted(chain, authType, socket) }

      override fun checkServerTrusted(
          chain: Array<out X509Certificate>?,
          authType: String?,
          engine: SSLEngine?,
      ) = judge(chain) { platform.checkServerTrusted(chain, authType, engine) }

      // A CLIENT certificate is never pinned — this app presents none, and a pinned SERVER key
      // must not become a way to accept a client. Straight through to the platform, all three.
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
          platform.checkClientTrusted(chain, authType)

      override fun checkClientTrusted(
          chain: Array<out X509Certificate>?,
          authType: String?,
          socket: Socket?,
      ) = platform.checkClientTrusted(chain, authType, socket)

      override fun checkClientTrusted(
          chain: Array<out X509Certificate>?,
          authType: String?,
          engine: SSLEngine?,
      ) = platform.checkClientTrusted(chain, authType, engine)

      override fun getAcceptedIssuers(): Array<X509Certificate> = platform.acceptedIssuers
    }
  }

  val socketFactory: SSLSocketFactory by lazy {
    SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), null) }.socketFactory
  }

  /**
   * THE HOST BINDING. Three cases, in this order, and the middle one is the one a reviewer should
   * look at hardest:
   *
   *  · **the host is pinned** — its key decides, and the certificate's NAME is not consulted. The
   *    door's certificate deliberately asserts no name (it cannot: the address is DHCP's), so
   *    requiring one would refuse every correct pairing.
   *  · **a pinned key on a host that is not pinned for it** — REFUSED. Without this, a machine
   *    that obtained a copy of some door's certificate could answer for any address, because the
   *    trust manager above accepts the key wherever it appears.
   *  · **everything else** — OkHttp's own verifier, untouched.
   */
  val hostnameVerifier: HostnameVerifier = HostnameVerifier { hostname, session ->
    val leaf = runCatching { session.peerCertificates.firstOrNull() as? X509Certificate }.getOrNull()
    val spki = leaf?.let { spkiOf(it) }
    val expected = pinsForHost(hostname)
    when {
      expected.isNotEmpty() -> spki != null && expected.contains(spki)
      spki != null && isPinnedKey(spki) -> false
      else -> OkHostnameVerifier.verify(hostname, session)
    }
  }
}
