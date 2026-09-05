'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { GatewayClient } from '@/lib/gateway';

interface ChatWindowProps {
    client: GatewayClient | null;
    isConnected: boolean;
    sessionKey?: string;
}

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: Date;
}

export default function ChatWindow({ client, isConnected, sessionKey = 'main' }: ChatWindowProps) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [isMinimized, setIsMinimized] = useState(true);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Scroll to bottom when new messages arrive
    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, scrollToBottom]);

    // Subscribe to chat events
    useEffect(() => {
        if (!client) return;

        const unsubscribe = client.onEvent((event, data) => {
            if (event === 'chat' || event === 'chat.message') {
                const msgData = data as { role?: string; content?: string; text?: string };
                const newMessage: ChatMessage = {
                    id: `msg-${Date.now()}`,
                    role: (msgData.role as 'user' | 'assistant' | 'system') || 'assistant',
                    content: msgData.content || msgData.text || String(data),
                    timestamp: new Date(),
                };
                setMessages(prev => [...prev, newMessage]);
                setIsTyping(false);
            } else if (event === 'chat.typing') {
                setIsTyping(true);
            }
        });

        return unsubscribe;
    }, [client]);

    // Send message
    const sendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || !client || !isConnected) return;

        const userMessage: ChatMessage = {
            id: `msg-${Date.now()}`,
            role: 'user',
            content: input,
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsTyping(true);

        try {
            await client.call('chat.send', {
                message: input,
                sessionKey
            });
        } catch (err) {
            const errorMessage: ChatMessage = {
                id: `msg-${Date.now()}-error`,
                role: 'system',
                content: `Error: ${(err as Error).message}`,
                timestamp: new Date(),
            };
            setMessages(prev => [...prev, errorMessage]);
            setIsTyping(false);
        }
    };

    // Clear chat
    const clearChat = () => {
        setMessages([]);
    };

    if (isMinimized) {
        return (
            <button
                onClick={() => setIsMinimized(false)}
                className="fixed bottom-20 lg:bottom-4 right-4 w-14 h-14 bg-gradient-to-br from-blue-600 to-purple-600 rounded-full shadow-lg flex items-center justify-center text-2xl hover:scale-110 transition-transform z-50"
            >
                💬
            </button>
        );
    }

    return (
        <div className="fixed bottom-20 lg:bottom-4 right-4 w-96 max-w-[calc(100vw-2rem)] h-[500px] max-h-[60vh] bg-gray-900/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/10 flex flex-col z-50">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/10">
                <div className="flex items-center gap-2">
                    <span className="text-xl">🦞</span>
                    <span className="font-semibold">Chat</span>
                    <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-gray-500'}`}></span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={clearChat}
                        className="text-gray-400 hover:text-white text-sm px-2 py-1"
                        title="Clear chat"
                    >
                        🗑️
                    </button>
                    <button
                        onClick={() => setIsMinimized(true)}
                        className="text-gray-400 hover:text-white text-xl"
                    >
                        ─
                    </button>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 && (
                    <div className="text-center text-gray-500 text-sm py-8">
                        <p className="text-3xl mb-2">👋</p>
                        <p>Start a conversation with Clawdbot</p>
                    </div>
                )}

                {messages.map(msg => (
                    <div
                        key={msg.id}
                        className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                        <div
                            className={`max-w-[80%] px-4 py-2 rounded-2xl ${msg.role === 'user'
                                    ? 'bg-blue-600 text-white rounded-br-sm'
                                    : msg.role === 'system'
                                        ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                                        : 'bg-white/10 text-gray-200 rounded-bl-sm'
                                }`}
                        >
                            <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                            <p className="text-xs opacity-50 mt-1">
                                {msg.timestamp.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
                            </p>
                        </div>
                    </div>
                ))}

                {isTyping && (
                    <div className="flex justify-start">
                        <div className="bg-white/10 px-4 py-3 rounded-2xl rounded-bl-sm">
                            <div className="flex gap-1">
                                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form onSubmit={sendMessage} className="p-4 border-t border-white/10">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        placeholder={isConnected ? "Type a message..." : "Connect to Gateway first"}
                        disabled={!isConnected}
                        className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
                    />
                    <button
                        type="submit"
                        disabled={!isConnected || !input.trim()}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:opacity-50 rounded-xl transition-colors"
                    >
                        ➤
                    </button>
                </div>
            </form>
        </div>
    );
}
