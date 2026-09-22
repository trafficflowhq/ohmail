Pod::Spec.new do |s|
  s.name           = 'OhmailEngineLogSink'
  s.version        = '0.1.0'
  s.summary        = "The engine's log lines reach the system log on a shipped build"
  s.description    = 'Writes one finished, already-redacted JSON line to os_log under app.ohmail.engine.'
  s.author         = 'ohmail'
  s.homepage       = 'https://ohmail.app'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,swift}'
end
