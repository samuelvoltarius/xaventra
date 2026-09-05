import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

let activeRegistry: PluginRegistry | null = createEmptyPluginRegistry();

export function setActivePluginRegistry(registry: PluginRegistry | null): void {
  activeRegistry = registry;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return activeRegistry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!activeRegistry) {
    throw new Error("Plugin registry is not initialized.");
  }
  return activeRegistry;
}
