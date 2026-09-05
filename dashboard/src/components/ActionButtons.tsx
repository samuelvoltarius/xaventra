'use client';

import { useState } from 'react';
import { GatewayClient } from '@/lib/gateway';

interface ActionButtonsProps {
    client: GatewayClient | null;
    isConnected: boolean;
}

interface ActionButton {
    id: string;
    label: string;
    icon: string;
    command: string;
    category: 'system' | 'git' | 'service' | 'custom';
    dangerous?: boolean;
}

const DEFAULT_ACTIONS: ActionButton[] = [
    // Git Commands
    { id: 'git-status', label: 'Git Status', icon: '­ƒôè', command: 'git status', category: 'git' },
    { id: 'git-pull', label: 'Git Pull', icon: 'Ô¼ç´©Å', command: 'git pull', category: 'git' },
    { id: 'git-push', label: 'Git Push', icon: 'Ô¼å´©Å', command: 'git push', category: 'git', dangerous: true },

    // Service Commands
    { id: 'pm2-status', label: 'PM2 Status', icon: '­ƒôï', command: 'pm2 list', category: 'service' },
    { id: 'pm2-restart', label: 'PM2 Restart All', icon: '­ƒöä', command: 'pm2 restart all', category: 'service', dangerous: true },
    { id: 'clawdbot-status', label: 'Clawdbot Status', icon: '­ƒª×', command: 'systemctl status clawdbot', category: 'service' },
    { id: 'clawdbot-restart', label: 'Restart Clawdbot', icon: '­ƒöü', command: 'systemctl restart clawdbot', category: 'service', dangerous: true },

    // System Commands
    { id: 'disk-usage', label: 'Disk Usage', icon: '­ƒÆ¥', command: 'df -h', category: 'system' },
    { id: 'memory', label: 'Memory', icon: '­ƒºá', command: 'free -h', category: 'system' },
    { id: 'uptime', label: 'Uptime', icon: 'ÔÅ▒´©Å', command: 'uptime', category: 'system' },
];

export default function ActionButtons({ client, isConnected }: ActionButtonsProps) {
    const [executing, setExecuting] = useState<string | null>(null);
    const [output, setOutput] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const executeCommand = async (action: ActionButton) => {
        if (!client || !isConnected) {
            setError('Not connected to Gateway');
            return;
        }

        // Confirm dangerous actions
        if (action.dangerous) {
            if (!confirm(`Are you sure you want to execute: ${action.command}?`)) {
                return;
            }
        }

        setExecuting(action.id);
        setOutput(null);
        setError(null);

        try {
            const result = await client.call<{ stdout?: string; stderr?: string; exitCode?: number }>(
                'exec',
                { command: action.command }
            );

            setOutput(result.stdout || result.stderr || 'Command executed successfully');
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setExecuting(null);
        }
    };

    const groupedActions = DEFAULT_ACTIONS.reduce((acc, action) => {
        if (!acc[action.category]) acc[action.category] = [];
        acc[action.category].push(action);
        return acc;
    }, {} as Record<string, ActionButton[]>);

    const categoryLabels: Record<string, string> = {
        git: '­ƒöÇ Git',
        service: 'ÔÜÖ´©Å Services',
        system: '­ƒûÑ´©Å System',
        custom: '­ƒôî Custom',
    };

    return (
        <div className="bg-white/5 rounded-2xl p-4 backdrop-blur-sm border border-white/10">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <span>ÔÜí</span> Quick Actions
            </h2>

            {/* Action Buttons by Category */}
            <div className="space-y-4">
                {Object.entries(groupedActions).map(([category, actions]) => (
                    <div key={category}>
                        <h3 className="text-xs text-gray-500 uppercase mb-2">{categoryLabels[category]}</h3>
                        <div className="grid grid-cols-2 gap-2">
                            {actions.map(action => (
                                <button
                                    key={action.id}
                                    onClick={() => executeCommand(action)}
                                    disabled={!isConnected || executing === action.id}
                                    className={`
                    flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium
                    transition-all duration-200
                    ${action.dangerous
                                            ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30'
                                            : 'bg-white/5 hover:bg-white/10 text-gray-300 border border-white/10'
                                        }
                    disabled:opacity-50 disabled:cursor-not-allowed
                    ${executing === action.id ? 'animate-pulse' : ''}
                  `}
                                >
                                    <span>{action.icon}</span>
                                    <span className="truncate">{action.label}</span>
                                    {executing === action.id && <span className="ml-auto">ÔÅ│</span>}
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            {/* Output Panel */}
            {(output || error) && (
                <div className={`mt-4 p-3 rounded-lg font-mono text-xs ${error ? 'bg-red-500/10 border border-red-500/30' : 'bg-black/30 border border-white/10'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-gray-400">{error ? 'ÔØî Error' : 'Ô£à Output'}</span>
                        <button
                            onClick={() => { setOutput(null); setError(null); }}
                            className="text-gray-500 hover:text-white"
                        >
                            Ô£ò
                        </button>
                    </div>
                    <pre className={`whitespace-pre-wrap ${error ? 'text-red-400' : 'text-green-400'}`}>
                        {error || output}
                    </pre>
                </div>
            )}

            {/* Connection Warning */}
            {!isConnected && (
                <p className="mt-3 text-xs text-yellow-500 text-center">
                    ÔÜá´©Å Connect to Gateway to use actions
                </p>
            )}
        </div>
    );
}
