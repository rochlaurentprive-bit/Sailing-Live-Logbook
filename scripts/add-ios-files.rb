# Ajoute les fichiers Swift copiés par patch-ios.js au projet Xcode (cible « App »).
# Utilise le gem « xcodeproj » (installé avec CocoaPods sur les machines macOS de GitHub).
require 'xcodeproj'

proj = Xcodeproj::Project.open(File.join(__dir__, '..', 'ios', 'App', 'App.xcodeproj'))
target = proj.targets.find { |t| t.name == 'App' } or abort('cible App introuvable')
group = proj.main_group.find_subpath('App', true)
%w[BoatLinkPlugin.swift MainViewController.swift].each do |f|
  if group.files.any? { |x| x.path == f }
    puts "déjà présent : #{f}"
    next
  end
  ref = group.new_file(f)
  target.add_file_references([ref])
  puts "ajouté : #{f}"
end
proj.save
