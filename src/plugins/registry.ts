import type { ChannelPlugin } from "../channels/plugins/types.js";

export type PluginRegistry = {
  plugins: unknown[];
  tools: unknown[];
  channels: Array<{
    pluginId: string;
    plugin: ChannelPlugin;
    source: string;
  }>;
  providers: unknown[];
  gatewayHandlers: Record<string, unknown>;
  httpHandlers: unknown[];
  cliRegistrars: unknown[];
  services: unknown[];
  diagnostics: unknown[];
};

export function createEmptyPluginRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    cliRegistrars: [],
    services: [],
    diagnostics: [],
  };
}
