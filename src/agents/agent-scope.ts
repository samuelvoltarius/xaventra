import type { novaConfig } from "../config/config.js";

export function resolveDefaultAgentId(cfg: novaConfig): string {
  const agents = cfg.agents?.list ?? [];
  return agents.find((agent) => agent.default)?.id ?? agents[0]?.id ?? "main";
}
