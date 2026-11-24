Pod::Spec.new do |s|
  s.name           = 'OhmailCalendar'
  s.version        = '0.1.0'
  s.summary        = 'The calendar on the iPhone outside the app: its record, its alerts and its widget'
  s.description    = 'Keeps the page record read closed, sets the alerts ahead, and clears both at sign-out.'
  s.author         = 'ohmail'
  s.homepage       = 'https://ohmail.app'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,swift}'
end
