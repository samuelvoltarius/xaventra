import { type PluginRegistry } from "../plugins/registry.js";

export function createTestRegistry(channels: PluginRegistry["channels"]): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    channels,
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    cliRegistrars: [],
    services: [],
    diagnostics: [],
  };
}
