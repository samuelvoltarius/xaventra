export type AgentBinding = {
  agentId: string;
  match?: {
    channel?: string;
    accountId?: string;
    peer?: { kind?: string; id?: string };
    guildId?: string;
    teamId?: string;
  };
};
