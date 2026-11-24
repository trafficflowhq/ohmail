package app.ohmail.notices

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * THE POSTER: one mail notice the page asked for, drawn only for the pairing that is signed in and worded only from
 * this module's own string resources, in the phone's language.
 *
 * It is handed closed values, as the page's port names them: the pairing, a kind's word, one whole number, and a
 * pairing's two words of closed lists. It has no parameter for a title, a sentence, a sender, a subject, an address,
 * an account, a server, the name a device gave itself, a link, a tag or a channel: what it is handed only CHOOSES
 * among its own sentences, and anything it does not know draws nothing. A notice is read on a locked screen by
 * whoever stands there, so the screen shows the title alone where the person asked the phone to hide what notices
 * say, and the system's own setting decides.
 *
 * New mail is drawn on the wake renderer's own channel, under its own id and tagged as it tags, so a closed app's
 * "New mail" still listed is replaced by the count, never doubled. It logs nothing, opens no connection and reads no
 * file but the kept pairing's.
 */
internal object NoticePoster {
  const val NEW_MAIL_CHANNEL_ID = "app.ohmail.push.new_mail"
  const val NEW_MAIL_ID = 1
  const val SCREENER_CHANNEL_ID = "app.ohmail.notices.screener"
  const val SCREENER_ID = 2
  const val DEVICES_CHANNEL_ID = "app.ohmail.notices.devices"
  const val DEVICES_ID = 3

  /** The largest count a notice says: the bridge's own bound. */
  private const val COUNT_MOST = 9999

  /** One notice's words and where it is drawn, every word a resource of this module. */
  private class Words(val channel: String, val channelName: Int, val id: Int, val title: String, val body: String)

  /** Draw one notice; true once the system was handed it. */
  fun post(
    context: Context, instance: String, kind: String, count: Int, change: String?, device: String?,
    sender: String? = null, subject: String? = null,
  ): Boolean {
    if (!LiveInstanceGate.mayDraw(LiveInstanceStore.kept(context), instance)) return false
    return try {
      val words = wordsOf(context, kind, count, change, device) ?: return false
      val manager = NotificationManagerCompat.from(context)
      if (!manager.areNotificationsEnabled()) return false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.createNotificationChannel(
          NotificationChannel(words.channel, context.getString(words.channelName), NotificationManager.IMPORTANCE_DEFAULT),
        )
      }
      val hidden = NotificationCompat.Builder(context, words.channel)
        .setSmallIcon(android.R.drawable.sym_action_email)
        .setContentTitle(words.title)
      val builder = NotificationCompat.Builder(context, words.channel)
        .setSmallIcon(android.R.drawable.sym_action_email)
        .setContentTitle(sender ?: words.title)
        .setContentText(subject ?: words.body)
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .setAutoCancel(true)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPublicVersion(hidden.build())
      // A tap opens the app by its own launch intent, as the wake renderer's does; nothing of a tap comes from data.
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      if (launch != null) {
        launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        builder.setContentIntent(
          PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
        )
      }
      manager.notify(instance, words.id, builder.build())
      true
    } catch (t: Throwable) {
      false
    }
  }

  /** The words the closed values choose, or null for anything else: then nothing is drawn. */
  private fun wordsOf(context: Context, kind: String, count: Int, change: String?, device: String?): Words? {
    val res = context.resources
    return when (kind) {
      "ohbox" -> {
        if (count !in 1..COUNT_MOST || change != null || device != null) return null
        Words(
          NEW_MAIL_CHANNEL_ID, R.string.ohmail_notice_channel_new_mail, NEW_MAIL_ID,
          res.getString(R.string.ohmail_notice_ohbox_title), res.getQuantityString(R.plurals.ohmail_notice_ohbox_body, count, count),
        )
      }
      "screener" -> {
        if (count !in 1..COUNT_MOST || change != null || device != null) return null
        Words(
          SCREENER_CHANNEL_ID, R.string.ohmail_notice_channel_screener, SCREENER_ID,
          res.getString(R.string.ohmail_notice_screener_title), res.getQuantityString(R.plurals.ohmail_notice_screener_body, count, count),
        )
      }
      "pairing" -> {
        if (count != 0) return null
        val paired = when (change) { "paired" -> true; "revoked" -> false; else -> return null }
        val body = when (device) {
          null -> if (paired) R.string.ohmail_notice_paired_other else R.string.ohmail_notice_revoked_other
          "desktop" -> if (paired) R.string.ohmail_notice_paired_desktop else R.string.ohmail_notice_revoked_desktop
          "phone" -> if (paired) R.string.ohmail_notice_paired_phone else R.string.ohmail_notice_revoked_phone
          "browser" -> if (paired) R.string.ohmail_notice_paired_browser else R.string.ohmail_notice_revoked_browser
          else -> return null
        }
        val title = if (paired) R.string.ohmail_notice_paired_title else R.string.ohmail_notice_revoked_title
        Words(DEVICES_CHANNEL_ID, R.string.ohmail_notice_channel_devices, DEVICES_ID, res.getString(title), res.getString(body))
      }
      else -> null
    }
  }
}
