'use client';

import { useState, useEffect } from 'react';

interface MemoryFile {
    name: string;
    size: number;
    modified: string;
}

interface MemoryBrowserProps {
    isConnected: boolean;
}

export default function MemoryBrowser({ isConnected }: MemoryBrowserProps) {
    const [files, setFiles] = useState<MemoryFile[]>([]);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [content, setContent] = useState<string>('');
    const [isEditing, setIsEditing] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    // Load file list
    useEffect(() => {
        loadFiles();
    }, []);

    const loadFiles = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/memory');
            if (res.ok) {
                const data = await res.json();
                setFiles(Array.isArray(data) ? data.map((name: string) => ({
                    name,
                    size: 0,
                    modified: new Date().toISOString(),
                })) : []);
            }
        } catch {
            // Demo data
            setFiles([
                { name: 'qm-logs.md', size: 2048, modified: new Date().toISOString() },
                { name: 'project-notes.md', size: 4096, modified: new Date().toISOString() },
                { name: 'network-devices.md', size: 1024, modified: new Date().toISOString() },
            ]);
        }
        setIsLoading(false);
    };

    const loadFile = async (filename: string) => {
        setSelectedFile(filename);
        setIsLoading(true);
        try {
            const res = await fetch(`/api/memory/${encodeURIComponent(filename)}`);
            if (res.ok) {
                const text = await res.text();
                setContent(text);
            }
        } catch {
            setContent(`# ${filename}\n\nContent could not be loaded.`);
        }
        setIsEditing(false);
        setIsLoading(false);
    };

    const saveFile = async () => {
        if (!selectedFile) return;

        setIsLoading(true);
        try {
            await fetch(`/api/memory/${encodeURIComponent(selectedFile)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'text/plain' },
                body: content,
            });
            setIsEditing(false);
        } catch (err) {
            console.error('Failed to save:', err);
        }
        setIsLoading(false);
    };

    const filteredFiles = files.filter(f =>
        f.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="bg-white/5 rounded-2xl backdrop-blur-sm border border-white/10 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                    📁 Memory Browser
                </h2>

                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="bg-black/30 border border-white/10 rounded-lg px-3 py-1 text-sm w-32"
                    />
                    <button
                        onClick={loadFiles}
                        className="px-3 py-1 rounded-lg text-sm bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                    >
                        🔄
                    </button>
                </div>
            </div>

            <div className="flex h-80">
                {/* File List */}
                <div className="w-48 border-r border-white/10 overflow-y-auto">
                    {filteredFiles.map(file => (
                        <button
                            key={file.name}
                            onClick={() => loadFile(file.name)}
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-white/5 transition-colors ${selectedFile === file.name ? 'bg-blue-500/20 text-blue-400' : 'text-gray-300'
                                }`}
                        >
                            📄 {file.name}
                        </button>
                    ))}

                    {filteredFiles.length === 0 && (
                        <div className="text-gray-500 text-sm text-center py-4">
                            No files found
                        </div>
                    )}
                </div>

                {/* Content Area */}
                <div className="flex-1 flex flex-col">
                    {selectedFile ? (
                        <>
                            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-black/20">
                                <span className="text-sm text-gray-400">{selectedFile}</span>
                                <div className="flex gap-2">
                                    {isEditing ? (
                                        <>
                                            <button
                                                onClick={saveFile}
                                                disabled={isLoading}
                                                className="px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30"
                                            >
                                                💾 Save
                                            </button>
                                            <button
                                                onClick={() => setIsEditing(false)}
                                                className="px-2 py-1 text-xs bg-gray-500/20 text-gray-400 rounded hover:bg-gray-500/30"
                                            >
                                                Cancel
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            onClick={() => setIsEditing(true)}
                                            className="px-2 py-1 text-xs bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30"
                                        >
                                            ✏️ Edit
                                        </button>
                                    )}
                                </div>
                            </div>

                            {isEditing ? (
                                <textarea
                                    value={content}
                                    onChange={(e) => setContent(e.target.value)}
                                    className="flex-1 bg-black/30 p-3 font-mono text-sm text-gray-300 resize-none focus:outline-none"
                                />
                            ) : (
                                <pre className="flex-1 bg-black/30 p-3 font-mono text-sm text-gray-300 overflow-auto whitespace-pre-wrap">
                                    {isLoading ? 'Loading...' : content}
                                </pre>
                            )}
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-gray-500">
                            Select a file to view
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
