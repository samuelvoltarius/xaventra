'use client';

import { useState, useEffect, useRef } from 'react';

interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
}

interface LogsPanelProps {
    isConnected: boolean;
    maxLogs?: number;
}

const levelColors = {
    info: 'text-blue-400',
    warn: 'text-yellow-400',
    error: 'text-red-400',
    debug: 'text-gray-400',
};

export default function LogsPanel({ isConnected, maxLogs = 100 }: LogsPanelProps) {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
    const [autoScroll, setAutoScroll] = useState(true);
    const [isPaused, setIsPaused] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Simulated live logs (in production, connect to WebSocket)
    useEffect(() => {
        if (isPaused) return;

        const interval = setInterval(() => {
            // Demo log entries - in production this would come from Gateway WebSocket
            const demoLogs: LogEntry[] = [
                { timestamp: new Date().toISOString(), level: 'info', message: 'System health check passed' },
                { timestamp: new Date().toISOString(), level: 'debug', message: 'Gateway heartbeat received' },
            ];

            // Only add demo logs if connected
            if (isConnected) {
                setLogs(prev => [...prev.slice(-maxLogs + 1), demoLogs[Math.floor(Math.random() * demoLogs.length)]]);
            }
        }, 5000);

        return () => clearInterval(interval);
    }, [isConnected, isPaused, maxLogs]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (autoScroll && containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [logs, autoScroll]);

    const filteredLogs = logs.filter(log =>
        filter === 'all' || log.level === filter
    );

    const handleClear = () => setLogs([]);

    return (
        <div className="bg-white/5 rounded-2xl backdrop-blur-sm border border-white/10 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                    📜 Live Logs
                    <span className={`text-xs px-2 py-0.5 rounded-full ${isConnected ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                        }`}>
                        {isConnected ? 'Connected' : 'Offline'}
                    </span>
                </h2>

                <div className="flex items-center gap-2">
                    {/* Filter */}
                    <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value as typeof filter)}
                        className="bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-sm"
                    >
                        <option value="all">All</option>
                        <option value="info">Info</option>
                        <option value="warn">Warn</option>
                        <option value="error">Error</option>
                    </select>

                    {/* Auto-scroll toggle */}
                    <button
                        onClick={() => setAutoScroll(!autoScroll)}
                        className={`px-2 py-1 rounded-lg text-sm ${autoScroll ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'
                            }`}
                    >
                        ⬇️ Auto
                    </button>

                    {/* Pause toggle */}
                    <button
                        onClick={() => setIsPaused(!isPaused)}
                        className={`px-2 py-1 rounded-lg text-sm ${isPaused ? 'bg-yellow-500/20 text-yellow-400' : 'bg-green-500/20 text-green-400'
                            }`}
                    >
                        {isPaused ? '▶️' : '⏸️'}
                    </button>

                    {/* Clear */}
                    <button
                        onClick={handleClear}
                        className="px-2 py-1 rounded-lg text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30"
                    >
                        🗑️
                    </button>
                </div>
            </div>

            {/* Logs Container */}
            <div
                ref={containerRef}
                className="h-64 overflow-y-auto font-mono text-sm p-4 bg-black/30"
            >
                {filteredLogs.length === 0 ? (
                    <div className="text-gray-500 text-center py-8">
                        No logs yet...
                    </div>
                ) : (
                    filteredLogs.map((log, i) => (
                        <div key={i} className="py-0.5 hover:bg-white/5 rounded px-1">
                            <span className="text-gray-500">
                                {new Date(log.timestamp).toLocaleTimeString('de-DE')}
                            </span>
                            {' '}
                            <span className={levelColors[log.level as keyof typeof levelColors] || 'text-white'}>
                                [{log.level.toUpperCase()}]
                            </span>
                            {' '}
                            <span className="text-gray-300">{log.message}</span>
                        </div>
                    ))
                )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-white/10 text-xs text-gray-500">
                {filteredLogs.length} entries
                {filter !== 'all' && ` (filtered: ${filter})`}
            </div>
        </div>
    );
}
