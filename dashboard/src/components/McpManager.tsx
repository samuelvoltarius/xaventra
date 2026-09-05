'use client';

import { useState, useEffect } from 'react';
import { GatewayClient } from '@/lib/gateway';

interface McpManagerProps {
    client: GatewayClient | null;
    isConnected: boolean;
}

interface McpServer {
    name: string;
    status: 'running' | 'stopped' | 'error';
    description?: string;
    tools?: string[];
}

// Default MCP servers that might be available
const KNOWN_MCP_SERVERS: Partial<McpServer>[] = [
    { name: 'filesystem', description: 'File system access' },
    { name: 'brave-search', description: 'Web search via Brave' },
    { name: 'google-maps', description: 'Location & Maps' },
    { name: 'github', description: 'GitHub integration' },
    { name: 'slack', description: 'Slack messaging' },
    { name: 'postgres', description: 'PostgreSQL database' },
    { name: 'puppeteer', description: 'Browser automation' },
];

export default function McpManager({ client, isConnected }: McpManagerProps) {
    const [servers, setServers] = useState<McpServer[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState<string | null>(null);

    // Fetch MCP server list
    const fetchServers = async () => {
        if (!client || !isConnected) return;

        setLoading(true);
        setError(null);

        try {
            const result = await client.call<McpServer[]>('mcp.list');
            setServers(Array.isArray(result) ? result : []);
        } catch (err) {
            setError((err as Error).message);
            // Show known servers as "unknown" status
            setServers(KNOWN_MCP_SERVERS.map(s => ({
                ...s,
                name: s.name || '',
                status: 'stopped' as const,
            })));
        } finally {
            setLoading(false);
        }
    };

    // Initial fetch
    useEffect(() => {
        if (isConnected) {
            fetchServers();
        }
    }, [isConnected]);

    // Start MCP server
    const startServer = async (name: string) => {
        if (!client || !isConnected) return;

        setActionLoading(name);

        try {
            await client.call('mcp.start', { name });
            await fetchServers();
        } catch (err) {
            setError(`Failed to start ${name}: ${(err as Error).message}`);
        } finally {
            setActionLoading(null);
        }
    };

    // Stop MCP server
    const stopServer = async (name: string) => {
        if (!client || !isConnected) return;

        setActionLoading(name);

        try {
            await client.call('mcp.stop', { name });
            await fetchServers();
        } catch (err) {
            setError(`Failed to stop ${name}: ${(err as Error).message}`);
        } finally {
            setActionLoading(null);
        }
    };

    const statusColors = {
        running: 'bg-green-500/20 text-green-400 border-green-500/50',
        stopped: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
        error: 'bg-red-500/20 text-red-400 border-red-500/50',
    };

    const statusIcons = {
        running: '🟢',
        stopped: '⚪',
        error: '🔴',
    };

    return (
        <div className="bg-white/5 rounded-2xl p-6 backdrop-blur-sm border border-white/10">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                    <span>🔌</span> MCP Plugins
                </h2>
                <button
                    onClick={fetchServers}
                    disabled={!isConnected || loading}
                    className="text-sm px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
                >
                    {loading ? '⏳' : '🔄'} Refresh
                </button>
            </div>

            {/* Error Banner */}
            {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4">
                    <p className="text-sm text-red-400">{error}</p>
                    <button
                        onClick={() => setError(null)}
                        className="text-xs text-red-300 underline mt-1"
                    >
                        Dismiss
                    </button>
                </div>
            )}

            {/* Not Connected Warning */}
            {!isConnected && (
                <div className="text-center py-8 text-gray-500">
                    <p className="text-3xl mb-2">🔌</p>
                    <p>Connect to Gateway to manage MCP plugins</p>
                </div>
            )}

            {/* Server List */}
            {isConnected && (
                <div className="space-y-3">
                    {servers.length === 0 && !loading && (
                        <p className="text-gray-500 text-center py-4">No MCP servers found</p>
                    )}

                    {loading && (
                        <div className="text-center py-4">
                            <span className="animate-spin inline-block">⏳</span>
                            <span className="ml-2 text-gray-400">Loading...</span>
                        </div>
                    )}

                    {servers.map(server => (
                        <div
                            key={server.name}
                            className={`flex items-center justify-between p-4 rounded-xl border ${statusColors[server.status]}`}
                        >
                            <div className="flex items-center gap-3">
                                <span className="text-xl">{statusIcons[server.status]}</span>
                                <div>
                                    <p className="font-medium">{server.name}</p>
                                    {server.description && (
                                        <p className="text-xs text-gray-400">{server.description}</p>
                                    )}
                                    {server.tools && server.tools.length > 0 && (
                                        <p className="text-xs text-gray-500 mt-1">
                                            {server.tools.length} tools
                                        </p>
                                    )}
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                {server.status === 'running' ? (
                                    <button
                                        onClick={() => stopServer(server.name)}
                                        disabled={actionLoading === server.name}
                                        className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                                    >
                                        {actionLoading === server.name ? '⏳' : '⏹️'} Stop
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => startServer(server.name)}
                                        disabled={actionLoading === server.name}
                                        className="px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                                    >
                                        {actionLoading === server.name ? '⏳' : '▶️'} Start
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
