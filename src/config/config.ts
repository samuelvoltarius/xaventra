export type novaConfig = {
  agents?: {
    list?: Array<{ id: string; default?: boolean; workspace?: string }>;
  };
  bindings?: Array<{
    agentId: string;
    match?: {
      channel?: string;
      accountId?: string;
      peer?: { kind?: string; id?: string };
      guildId?: string;
      teamId?: string;
    };
  }>;
  session?: {
    dmScope?: "main" | "per-peer" | "per-channel-peer";
    identityLinks?: Record<string, string[]>;
  };
  channels?: Record<string, any>;
};
