package app.ohmail.notices

import android.app.NotificationManager
import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * THE PHONE'S NOTICES ON ANDROID, native's side: exactly what the page's port names (`src/notices/notices-port.ts`),
 * two functions, and no event and no constant besides.
 *
 *  · `setLive` keeps which pairing is signed in, or none, in the file the wake's renderer reads, and then takes back
 *    every notice this app shows for any other pairing: signing out or switching closes what was shown;
 *  · `post` draws one mail notice from closed values, for the kept pairing alone ({@link NoticePoster}).
 *
 * Nothing of it is built for the iPhone, where no mail notice is drawn. It logs nothing.
 */
class OhmailNoticesModule : Module() {
  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  /** Close what is shown for any pairing but the kept one, one notice at a time; a failure changes nothing else. */
  private fun takeBack(ctx: Context, was: String?, now: String?) {
    try {
      val manager = ctx.getSystemService(NotificationManager::class.java) ?: return
      val shown = manager.activeNotifications.map { Pair<String?, Int>(it.tag, it.id) }
      for ((tag, id) in NoticeTakeBack.closing(shown, was, now)) manager.cancel(tag, id)
    } catch (t: Throwable) {
      // Nothing to recover, and nothing to log.
    }
  }

  override fun definition() = ModuleDefinition {
    Name("OhmailNotices")

    AsyncFunction("setLive") { instance: String? ->
      val ctx = context ?: return@AsyncFunction false
      val was = LiveInstanceStore.kept(ctx)
      val ok = LiveInstanceStore.keep(ctx, instance)
      takeBack(ctx, was, LiveInstanceStore.kept(ctx))
      ok
    }

    AsyncFunction("postDetails") { instance: String, sender: String, subject: String ->
      val ctx = context ?: return@AsyncFunction false
      if (sender.length !in 1..160 || subject.length !in 1..160 ||
        sender.any { it.isISOControl() } || subject.any { it.isISOControl() }) return@AsyncFunction false
      NoticePoster.post(ctx, instance, "ohbox", 1, null, null, sender, subject)
    }

    AsyncFunction("post") { instance: String, kind: String, count: Int, change: String?, device: String? ->
      val ctx = context ?: return@AsyncFunction false
      NoticePoster.post(ctx, instance, kind, count, change, device)
    }
  }
}
