export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

export function parseAgentSessionKey(sessionKey: string | undefined | null): ParsedAgentSessionKey | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw.startsWith("agent:")) return null;
  const [, agentId, ...rest] = raw.split(":");
  if (!agentId || rest.length === 0) return null;
  return { agentId, rest: rest.join(":") };
}

export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  return (sessionKey ?? "").startsWith("acp:");
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  return parseAgentSessionKey(sessionKey)?.agentId !== "main";
}
