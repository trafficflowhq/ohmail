package app.ohmail.pull

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OhmailPullModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OhmailPull")
    View(PullView::class) {
      Events("onPullClaim", "onPullMotion", "onPullFinish")
      Prop("enabled") { view: PullView, enabled: Boolean -> view.pullEnabled = enabled }
      Prop("rate") { view: PullView, rate: Float -> view.rate = rate }
      Prop("maximum") { view: PullView, maximum: Float -> view.maximum = maximum }
      Prop("hold") { view: PullView, hold: Float -> view.setHold(hold) }
      Prop("slop") { view: PullView, slop: Float -> view.slop = slop }
    }
  }
}
