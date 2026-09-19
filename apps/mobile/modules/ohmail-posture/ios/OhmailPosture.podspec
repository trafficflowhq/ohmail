Pod::Spec.new do |s|
  s.name           = 'OhmailPosture'
  s.version        = '0.1.0'
  s.summary        = 'Fold and posture reading for ohmail'
  s.description    = 'Maps the platform fold APIs to the posture model the layout reads.'
  s.author         = 'ohmail'
  s.homepage       = 'https://ohmail.app'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,swift}'
end
