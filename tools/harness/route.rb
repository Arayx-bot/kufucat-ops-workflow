#!/usr/bin/env ruby

require "json"
require "yaml"

root = File.expand_path(ENV.fetch("KUFUCAT_PROJECT_ROOT", File.expand_path("../..", __dir__)))
route_id = ARGV.fetch(0) do
  warn "usage: ruby tools/harness/route.rb <route_id>"
  exit 2
end

routes = YAML.load_file(File.join(root, "harness/ROUTES.yaml"))
budgets = YAML.load_file(File.join(root, "harness/BUDGET.yaml"))
tools = YAML.load_file(File.join(root, "tools/REGISTRY.yaml"))
workflows = YAML.load_file(File.join(root, "workflows/INDEX.yaml"))

route = routes.fetch("routes").fetch(route_id) do
  warn "unknown route: #{route_id}"
  exit 2
end

context = route.fetch("required_context").map do |context_id|
  [context_id, routes.fetch("context_sources").fetch(context_id)]
end.to_h

allowed_tools = route.fetch("allowed_tools").map do |tool_id|
  [tool_id, tools.fetch("tools").fetch(tool_id)]
end.to_h

workflow_id = route["preferred_workflow"]
workflow = workflow_id ? workflows.fetch("workflows").fetch(workflow_id) : nil
budget_id = route.fetch("budget_class")
budget = budgets.fetch("classes").fetch(budget_id)

puts JSON.pretty_generate(
  "route" => route_id,
  "required_context" => context,
  "allowed_tools" => allowed_tools,
  "preferred_workflow" => workflow,
  "acceptance" => route.fetch("acceptance"),
  "budget_class" => budget_id,
  "budget" => budget
)
