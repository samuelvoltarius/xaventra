'use client';

import { useState, useEffect } from 'react';
import { GatewayClient } from '@/lib/gateway';

interface Agent {
    id: string;
    name: string;
    status: 'running' | 'stopped' | 'error';
    isDefault: boolean;
    heartbeat?: {
        enabled: boolean;
        interval: string;
        lastBeat?: string;
    };
}

interface AgentControlProps {
    client: GatewayClient;
    isConnected: boolean;
}

export default function AgentControl({ client, isConnected }: AgentControlProps) {
    const [agents, setAgents] = useState<Agent[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [actionInProgress, setActionInProgress] = useState<string | null>(null);

    // Load agents
    useEffect(() => {
        loadAgents();
    }, [isConnected]);

    const loadAgents = async () => {
        setIsLoading(true);

        if (isConnected) {
            try {
                const status = await client.getStatus() as { agents?: Agent[] };
                if (status?.agents) {
                    setAgents(status.agents);
                }
            } catch {
                // Demo data
                setDemoAgents();
            }
        } else {
            setDemoAgents();
        }

        setIsLoading(false);
    };

    const setDemoAgents = () => {
        setAgents([
            { id: 'brutus', name: 'Brutus', status: 'running', isDefault: true, heartbeat: { enabled: true, interval: '5m' } },
            { id: 'prc', name: 'PRC Support', status: 'stopped', isDefault: false, heartbeat: { enabled: false, interval: '10m' } },
        ]);
    };

    const handleAction = async (agentId: string, action: 'start' | 'stop' | 'restart') => {
        setActionInProgress(agentId);

        try {
            if (isConnected) {
                await client.call(`agent.${action}`, { agentId });
            }

            // Update local state
            setAgents(prev => prev.map(agent =>
                agent.id === agentId
                    ? { ...agent, status: action === 'stop' ? 'stopped' : 'running' }
                    : agent
            ));
        } catch (err) {
            console.error(`Failed to ${action} agent:`, err);
        }

        setActionInProgress(null);
    };

    const statusColors = {
        running: 'bg-green-500/20 text-green-400 border-green-500/50',
        stopped: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
        error: 'bg-red-500/20 text-red-400 border-red-500/50',
    };

    return (
        <div className="bg-white/5 rounded-2xl backdrop-blur-sm border border-white/10 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                    🤖 Agent Control
                    <span className={`text-xs px-2 py-0.5 rounded-full ${isConnected ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                        }`}>
                        {agents.filter(a => a.status === 'running').length}/{agents.length} active
                    </span>
                </h2>

                <button
                    onClick={loadAgents}
                    disabled={isLoading}
                    className="px-3 py-1 rounded-lg text-sm bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                >
                    🔄 Refresh
                </button>
            </div>

            {/* Agents Grid */}
            <div className="p-4 space-y-3">
                {isLoading ? (
                    <div className="text-center py-8 text-gray-500">Loading agents...</div>
                ) : agents.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">No agents configured</div>
                ) : (
                    agents.map(agent => (
                        <div
                            key={agent.id}
                            className={`rounded-xl border p-4 ${statusColors[agent.status]}`}
                        >
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">{agent.name}</span>
                                        {agent.isDefault && (
                                            <span className="text-xs px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">
                                                ⭐ Default
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-1">
                                        ID: {agent.id}
                                        {agent.heartbeat?.enabled && (
                                            <> • Heartbeat: {agent.heartbeat.interval}</>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    <span className={`px-2 py-1 text-xs rounded-lg ${agent.status === 'running' ? 'bg-green-500/30' : 'bg-gray-500/30'
                                        }`}>
                                        {agent.status}
                                    </span>

                                    {agent.status === 'running' ? (
                                        <>
                                            <button
                                                onClick={() => handleAction(agent.id, 'restart')}
                                                disabled={actionInProgress === agent.id}
                                                className="px-3 py-1 text-sm bg-yellow-500/20 text-yellow-400 rounded-lg hover:bg-yellow-500/30 disabled:opacity-50"
                                            >
                                                🔄
                                            </button>
                                            <button
                                                onClick={() => handleAction(agent.id, 'stop')}
                                                disabled={actionInProgress === agent.id}
                                                className="px-3 py-1 text-sm bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 disabled:opacity-50"
                                            >
                                                ⏹️
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            onClick={() => handleAction(agent.id, 'start')}
                                            disabled={actionInProgress === agent.id}
                                            className="px-3 py-1 text-sm bg-green-500/20 text-green-400 rounded-lg hover:bg-green-500/30 disabled:opacity-50"
                                        >
                                            ▶️ Start
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
