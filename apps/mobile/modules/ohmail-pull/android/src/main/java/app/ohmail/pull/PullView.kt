package app.ohmail.pull

import android.annotation.SuppressLint
import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import com.facebook.react.uimanager.events.NativeGestureUtil
import android.widget.ScrollView
import androidx.core.widget.NestedScrollView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.abs

/** Lets an eligible downward drag take over from the native scroll view and its row. */
class PullView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var pullEnabled = false
  var slop = 0f
  var rate = 0f
  var maximum = 0f
  private var hold = 0f
  private var latestDistance = 0f
  private val density = resources.displayMetrics.density
  private var sequence = 0
  private val onPullClaim by EventDispatcher()
  private val onPullMotion by EventDispatcher { _: Map<String, Any> -> sequence.toShort() }
  private val onPullFinish by EventDispatcher()
  private var scroll: View? = null
  private var x = 0f
  private var y = 0f
  private var claimed = false
  private var discard = false

  // Fabric measures and positions every React child. Only size this host view.
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

  @SuppressLint("MissingSuperCall")
  override fun requestLayout() = Unit

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    val action = event.actionMasked
    if (action == MotionEvent.ACTION_DOWN) {
      claimed = false
      discard = false
      sequence++
      x = event.x
      y = event.y
      scroll = if (pullEnabled) findScroll(this)?.takeUnless { it.canScrollVertically(-1) } else null
      return super.dispatchTouchEvent(event) || scroll != null
    }

    if (discard) return true
    val list = scroll ?: return super.dispatchTouchEvent(event)
    val dx = (event.x - x) / density
    val distance = (event.y - y) / density
    val interrupted = !pullEnabled || event.pointerCount != 1 || action == MotionEvent.ACTION_CANCEL
    if (interrupted || action == MotionEvent.ACTION_UP) {
      scroll = null
      if (!claimed) return super.dispatchTouchEvent(event)
      claimed = false
      discard = interrupted
      NativeGestureUtil.notifyNativeGestureEnded(this, event)
      parent?.requestDisallowInterceptTouchEvent(false)
      onPullFinish(mapOf("distance" to distance, "cancelled" to interrupted))
      return true
    }

    if (action == MotionEvent.ACTION_MOVE) {
      if (!claimed) {
        if (list.canScrollVertically(-1)) {
          scroll = null
          return super.dispatchTouchEvent(event)
        }
        if (distance <= slop || distance <= abs(dx)) {
          if (maxOf(abs(dx), abs(distance)) > slop) scroll = null
          return super.dispatchTouchEvent(event)
        }
        claimed = true
        // A ScrollView can already have crossed its own slop. Its request to
        // disallow interception does not prevent this parent seeing dispatch.
        val cancel = MotionEvent.obtain(event)
        cancel.action = MotionEvent.ACTION_CANCEL
        try {
          super.dispatchTouchEvent(cancel)
        } finally {
          cancel.recycle()
        }
        NativeGestureUtil.notifyNativeGestureStarted(this, event)
        parent?.requestDisallowInterceptTouchEvent(true)
        onPullClaim(emptyMap())
      }
      latestDistance = distance
      emitMotion()
      return true
    }
    return claimed || super.dispatchTouchEvent(event)
  }

  fun setHold(value: Float) {
    hold = value
    // The check can finish while the finger is still down, even between moves.
    if (claimed) emitMotion()
  }

  private fun emitMotion() {
    val offset = ((latestDistance - slop).coerceAtLeast(0f) * rate).coerceAtMost(maximum)
    onPullMotion(mapOf("offset" to maxOf(offset, hold)))
  }

  private fun findScroll(view: View): View? {
    if (view is ScrollView || view is NestedScrollView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        findScroll(view.getChildAt(i))?.let { return it }
      }
    }
    return null
  }
}
