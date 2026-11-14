Pod::Spec.new do |s|
  s.name           = 'OhmailShell'
  s.version        = '0.1.0'
  s.summary        = 'The phone shell: one web view showing the shared views from the app bundle'
  s.description    = 'Serves the shell page under its own scheme, seals the web view, carries the bridge and keeps a person\'s words natively.'
  s.author         = 'ohmail'
  s.homepage       = 'https://ohmail.app'
  s.license        = { :type => 'AGPL-3.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.library        = 'sqlite3'
  s.source_files   = '**/*.{h,m,swift}'
end
