Pod::Spec.new do |s|
  s.name           = 'OhmailSwitch'
  s.version        = '0.1.0'
  s.summary        = 'The switch between the two ohmail apps'
  s.description    = 'Which app this is, and the link that opens the other one at a place.'
  s.author         = 'ohmail'
  s.homepage       = 'https://ohmail.app'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,swift}'
end
