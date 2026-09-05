'use client';

import type { NovaStatus } from '@/lib/brutus';

interface StatusWidgetProps {
    status: NovaStatus | null;
    isLoading?: boolean;
    error?: Error | null;
}

export default function StatusWidget({ status, isLoading, error }: StatusWidgetProps) {
    if (isLoading) {
        return (
            <div className="bg-white/5 rounded-2xl p-6 backdrop-blur-sm border border-white/10 animate-pulse">
                <div className="h-6 bg-white/10 rounded w-1/3 mb-4"></div>
                <div className="h-4 bg-white/10 rounded w-2/3"></div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-red-500/10 rounded-2xl p-6 backdrop-blur-sm border border-red-500/30">
                <h2 className="text-xl font-semibold text-red-400 flex items-center gap-2">
                    <span>⚠️</span> Connection Error
                </h2>
                <p className="text-gray-400 mt-2 text-sm">{error.message}</p>
            </div>
        );
    }

    if (!status) return null;

    const isOnline = status.services?.clawdbot === 'running';

    return (
        <div className="bg-white/5 rounded-2xl p-6 backdrop-blur-sm border border-white/10">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold flex items-center gap-2">
                    <span className="text-2xl">🦞</span> System Status
                </h2>
                <span className={`px-3 py-1 rounded-full text-sm ${isOnline ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                    }`}>
                    {isOnline ? '● Online' : '○ Offline'}
                </span>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="bg-black/20 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-yellow-400">{status.taskQueue.pending}</p>
                    <p className="text-xs text-gray-400">Pending</p>
                </div>
                <div className="bg-black/20 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-green-400">{status.taskQueue.completed}</p>
                    <p className="text-xs text-gray-400">Completed</p>
                </div>
                <div className="bg-black/20 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-red-400">{status.taskQueue.failed}</p>
                    <p className="text-xs text-gray-400">Failed</p>
                </div>
            </div>

            {/* Services */}
            <div className="text-sm text-gray-400">
                <p className="flex items-center gap-2">
                    <span className={isOnline ? 'text-green-400' : 'text-red-400'}>●</span>
                    Clawdbot: {status.services?.clawdbot || 'unknown'}
                </p>
                <p className="mt-1 text-xs">
                    Workspace: <span className="text-gray-300">{status.workspace}</span>
                </p>
                <p className="mt-1 text-xs">
                    Memory Files: <span className="text-gray-300">{status.memoryFiles?.length || 0}</span>
                </p>
            </div>
        </div>
    );
}
