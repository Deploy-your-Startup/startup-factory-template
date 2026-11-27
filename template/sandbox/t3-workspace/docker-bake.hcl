// Run from the Factory root so this target uses its locked Startup CLI.
variable "WORKSPACE_IMAGE" {
  default = "factory-t3-pilot:0.1.13-factory.1"
}
target "tools" {
  context = "."
  dockerfile = "sandbox/factory-tools/kit.dockerfile"
}
target "default" {
  context = "sandbox/t3-workspace"
  contexts = { factory-tools = "target:tools" }
  tags = [WORKSPACE_IMAGE]
}
