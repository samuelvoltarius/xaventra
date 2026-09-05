'use client';

import { useState } from 'react';

interface TaskFormProps {
    onSubmit: (task: { description: string; priority: string; category: string }) => void;
    isLoading?: boolean;
}

export default function TaskForm({ onSubmit, isLoading }: TaskFormProps) {
    const [description, setDescription] = useState('');
    const [priority, setPriority] = useState('normal');
    const [category, setCategory] = useState('other');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!description.trim()) return;
        onSubmit({ description, priority, category });
        setDescription('');
    };

    return (
        <form onSubmit={handleSubmit} className="bg-white/5 rounded-2xl p-6 backdrop-blur-sm border border-white/10">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <span className="text-2xl">📝</span> New Task
            </h2>

            {/* Description */}
            <div className="mb-4">
                <label className="block text-sm text-gray-400 mb-2">Description</label>
                <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What should the agent do?"
                    className="w-full bg-black/30 border border-white/10 rounded-xl p-4 text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500 transition-colors"
                    rows={3}
                />
            </div>

            {/* Priority & Category */}
            <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                    <label className="block text-sm text-gray-400 mb-2">Priority</label>
                    <select
                        value={priority}
                        onChange={(e) => setPriority(e.target.value)}
                        className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-white focus:outline-none focus:border-blue-500"
                    >
                        <option value="low">🟢 Low</option>
                        <option value="normal">🔵 Normal</option>
                        <option value="high">🟠 High</option>
                        <option value="urgent">🔴 Urgent</option>
                    </select>
                </div>
                <div>
                    <label className="block text-sm text-gray-400 mb-2">Category</label>
                    <select
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className="w-full bg-black/30 border border-white/10 rounded-xl p-3 text-white focus:outline-none focus:border-blue-500"
                    >
                        <option value="code">💻 Code</option>
                        <option value="file">📁 File</option>
                        <option value="research">🔍 Research</option>
                        <option value="system">⚙️ System</option>
                        <option value="message">💬 Message</option>
                        <option value="other">📌 Other</option>
                    </select>
                </div>
            </div>

            {/* Submit */}
            <button
                type="submit"
                disabled={isLoading || !description.trim()}
                className="w-full py-3 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 rounded-xl font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {isLoading ? '⏳ Sending...' : '🚀 Create Task'}
            </button>
        </form>
    );
}
