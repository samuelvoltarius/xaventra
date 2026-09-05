'use client';

import { useState } from 'react';
import { Task } from '@/lib/brutus';

interface TaskCardProps {
    task: Task;
    onApprove?: (id: string) => void;
    onCancel?: (id: string) => void;
}

const statusColors = {
    pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
    in_progress: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
    completed: 'bg-green-500/20 text-green-400 border-green-500/50',
    failed: 'bg-red-500/20 text-red-400 border-red-500/50',
};

const priorityBadges = {
    low: 'bg-gray-600 text-gray-300',
    normal: 'bg-blue-600 text-blue-100',
    high: 'bg-orange-600 text-orange-100',
    urgent: 'bg-red-600 text-red-100 animate-pulse',
};

export default function TaskCard({ task, onApprove, onCancel }: TaskCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    return (
        <div
            className={`rounded-xl border p-4 backdrop-blur-sm transition-all duration-200 hover:scale-[1.02] ${statusColors[task.status]}`}
        >
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span className={`px-2 py-0.5 text-xs rounded-full ${priorityBadges[task.priority]}`}>
                            {task.priority}
                        </span>
                        <span className="text-xs text-gray-400">{task.category}</span>
                    </div>
                    <p className="font-medium truncate">{task.description}</p>
                    <p className="text-xs text-gray-500 mt-1">
                        {new Date(task.createdAt).toLocaleString('de-DE')}
                    </p>
                </div>

                {/* Status Badge */}
                <span className="px-3 py-1 text-sm rounded-lg bg-black/20 whitespace-nowrap">
                    {task.status.replace('_', ' ')}
                </span>
            </div>

            {/* Expandable Details */}
            {isExpanded && (
                <div className="mt-4 pt-4 border-t border-white/10">
                    <p className="text-sm text-gray-300 mb-3">{task.description}</p>
                    {task.result && (
                        <div className="bg-black/30 rounded-lg p-3 text-sm">
                            <span className="text-gray-400">Result:</span>
                            <p className="text-green-400 mt-1">{task.result}</p>
                        </div>
                    )}
                    {task.error && (
                        <div className="bg-red-900/30 rounded-lg p-3 text-sm">
                            <span className="text-gray-400">Error:</span>
                            <p className="text-red-400 mt-1">{task.error}</p>
                        </div>
                    )}
                </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/10">
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                    {isExpanded ? '▲ Less' : '▼ More'}
                </button>

                <div className="flex gap-2">
                    {task.status === 'pending' && onApprove && (
                        <button
                            onClick={() => onApprove(task.id)}
                            className="px-4 py-1.5 bg-green-600 hover:bg-green-500 rounded-lg text-sm font-medium transition-colors"
                        >
                            ✓ Approve
                        </button>
                    )}
                    {task.status === 'pending' && onCancel && (
                        <button
                            onClick={() => onCancel(task.id)}
                            className="px-4 py-1.5 bg-red-600/50 hover:bg-red-600 rounded-lg text-sm font-medium transition-colors"
                        >
                            ✕ Cancel
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
