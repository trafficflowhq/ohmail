Pod::Spec.new do |s|
  s.name           = 'OhmailBackupExclusion'
  s.version        = '0.1.0'
  s.summary        = 'Keeps the on-device mail mirror out of the platform backup'
  s.description    = 'Sets and reads back the backup-exclusion resource key on the mirror directory.'
  s.author         = 'ohmail'
  s.homepage       = 'https://ohmail.app'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files   = '**/*.{h,m,swift}'
end
