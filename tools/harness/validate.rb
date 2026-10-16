#!/usr/bin/env ruby

require "digest"
require "yaml"

root = File.expand_path(ENV.fetch("KUFUCAT_PROJECT_ROOT", File.expand_path("../..", __dir__)))
errors = []

yaml_paths = Dir[File.join(root, "harness/**/*.yaml")] +
  Dir[File.join(root, "workflows/**/*.yaml")] +
  [File.join(root, "assets/registry.yaml"), File.join(root, "tools/REGISTRY.yaml")]

yaml_paths.each do |path|
  begin
    YAML.load_file(path)
  rescue StandardError => e
    errors << "invalid YAML #{path.delete_prefix(root + "/")}: #{e.message}"
  end
end

routes = YAML.load_file(File.join(root, "harness/ROUTES.yaml"))
tools = YAML.load_file(File.join(root, "tools/REGISTRY.yaml")).fetch("tools")
workflows = YAML.load_file(File.join(root, "workflows/INDEX.yaml")).fetch("workflows")
budgets = YAML.load_file(File.join(root, "harness/BUDGET.yaml")).fetch("classes")

routes.fetch("context_sources").each do |id, relative|
  errors << "missing context #{id}: #{relative}" unless File.exist?(File.join(root, relative))
end

routes.fetch("routes").each do |id, route|
  route.fetch("required_context").each do |context_id|
    errors << "unknown context #{id}: #{context_id}" unless routes.fetch("context_sources").key?(context_id)
  end
  route.fetch("allowed_tools").each do |tool_id|
    errors << "unknown tool #{id}: #{tool_id}" unless tools.key?(tool_id)
  end
  workflow_id = route["preferred_workflow"]
  errors << "unknown workflow #{id}: #{workflow_id}" if workflow_id && !workflows.key?(workflow_id)
  errors << "unknown budget #{id}: #{route["budget_class"]}" unless budgets.key?(route["budget_class"])
end

workflows.each do |id, relative|
  errors << "missing workflow #{id}: #{relative}" unless File.exist?(File.join(root, relative))
end

registry = YAML.load_file(File.join(root, "assets/registry.yaml"))
asset_ids = registry.fetch("assets").map { |asset| asset.fetch("id") }
asset_ids.group_by(&:itself).each do |id, copies|
  errors << "duplicate asset id: #{id}" if copies.length > 1
end

registry.fetch("assets").each do |asset|
  relative = asset["master"]
  next unless relative
  path = File.join(root, relative)
  unless File.exist?(path)
    errors << "missing asset #{asset["id"]}: #{relative}"
    next
  end
  expected = asset["sha"]
  next unless expected && File.file?(path)
  actual = Digest::SHA256.file(path).hexdigest
  errors << "asset hash mismatch #{asset["id"]}: expected #{expected}, got #{actual}" unless actual == expected
end

if errors.empty?
  puts "Harness V2 validation PASS"
  puts "YAML files: #{yaml_paths.length}"
  puts "Routes: #{routes.fetch("routes").length}"
  puts "Workflows: #{workflows.length}"
  puts "Assets: #{registry.fetch("assets").length}"
else
  warn errors.join("\n")
  exit 1
end
