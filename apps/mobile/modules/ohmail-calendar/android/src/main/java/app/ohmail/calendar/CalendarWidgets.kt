package app.ohmail.calendar

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

abstract class CalendarWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    CalendarLive.redrawAdmitted(context)
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    CalendarLive.redrawAdmitted(context)
  }
}

class CalendarWidgetNext : CalendarWidget()
class CalendarWidgetMonth : CalendarWidget()
class CalendarWidgetToday : CalendarWidget()
class CalendarWidgetWeek : CalendarWidget()

internal object CalendarWidgets {
  fun redrawAll(
    context: Context, showTarget: Boolean = true, proposed: CalendarStore.Generation? = null,
  ): Boolean = CalendarStore.locked {
    val manager = AppWidgetManager.getInstance(context) ?: return@locked false
    val target = if (showTarget) proposed ?: CalendarStore.active(context)?.generation else null
    val now = Date()
    var success = true
    for (provider in listOf(CalendarWidgetNext::class.java, CalendarWidgetMonth::class.java,
      CalendarWidgetToday::class.java, CalendarWidgetWeek::class.java)) {
      try {
        for (id in manager.getAppWidgetIds(ComponentName(context, provider))) {
          val view = RemoteViews(context.packageName, R.layout.ohcal_widget_next)
          view.setTextViewText(R.id.ohcal_n_weekday, SimpleDateFormat("EEEE", Locale.getDefault()).format(now))
          view.setTextViewText(R.id.ohcal_n_date, SimpleDateFormat("d", Locale.getDefault()).format(now))
          for (row in listOf(R.id.ohcal_n_r1, R.id.ohcal_n_r2, R.id.ohcal_n_nothing, R.id.ohcal_n_open)) {
            view.setViewVisibility(row, View.GONE)
          }
          val category = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY)
          val tap = if (category == AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN && target != null) open(context, target.id) else null
          view.setOnClickPendingIntent(R.id.ohcal_n, tap)
          manager.updateAppWidget(id, view)
        }
      } catch (e: Exception) {
        success = false
      }
    }
    success
  }

  private fun open(context: Context, generation: String): PendingIntent? {
    val activity = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component ?: return null
    val scheme = if (context.packageName.endsWith(".preview")) "ohcal-preview" else "ohcal"
    val target = Uri.Builder().scheme(scheme).authority("calendar-widget").appendPath(generation).build()
    val launch = Intent(Intent.ACTION_VIEW, target)
      .setComponent(activity)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE)
  }
}
