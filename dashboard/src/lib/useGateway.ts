'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { getGatewayClient, GatewayClient } from './gateway';

export interface GatewayStatus {
    connected: boolean;
    workspace?: string;
    sessions?: Array<{ key: string; label?: string }>;
    nodes?: Array<{ id: string; name: string; status: string; cpu?: number; temp?: number }>;
}

export interface GatewayTask {
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    priority: string;
    category?: string;
    createdAt: string;
    completedAt?: string;
}

export function useGateway() {
    const [status, setStatus] = useState<GatewayStatus>({ connected: false });
    const [tasks, setTasks] = useState<GatewayTask[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [error, setError] = useState<Error | null>(null);
    const [isConnecting, setIsConnecting] = useState(false);

    const clientRef = useRef<GatewayClient | null>(null);
    const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

    // Connect to Gateway
    const connect = useCallback(async () => {
        if (isConnecting || status.connected) return;

        setIsConnecting(true);
        setError(null);

        try {
            const client = getGatewayClient();
            clientRef.current = client;

            await client.connect();

            // Subscribe to events
            client.onEvent((event, data) => {
                console.log('[Gateway Event]', event, data);

                switch (event) {
                    case 'log':
                        setLogs(prev => [...prev.slice(-99), String(data)]);
                        break;
                    case 'task.created':
                    case 'task.updated':
                    case 'task.completed':
                        fetchTasks();
                        break;
                    case 'status.changed':
                        fetchStatus();
                        break;
                }
            });

            setStatus({ connected: true });

            // Initial fetch
            await Promise.all([fetchStatus(), fetchTasks()]);

        } catch (err) {
            console.error('[Gateway] Connection failed:', err);
            setError(err as Error);
            setStatus({ connected: false });
        } finally {
            setIsConnecting(false);
        }
    }, [isConnecting, status.connected]);

    // Fetch status from Gateway
    const fetchStatus = useCallback(async () => {
        const client = clientRef.current;
        if (!client?.isConnected) return;

        try {
            const result = await client.getStatus() as Record<string, unknown>;
            setStatus(prev => ({
                ...prev,
                connected: true,
                workspace: result.workspace as string,
            }));

            // Fetch sessions
            try {
                const sessions = await client.listSessions() as Array<{ key: string; label?: string }>;
                setStatus(prev => ({ ...prev, sessions }));
            } catch {
                // Sessions might not be available
            }

            // Fetch nodes
            try {
                const nodes = await client.getNodes() as Array<{ id: string; name: string; status: string }>;
                setStatus(prev => ({ ...prev, nodes }));
            } catch {
                // Nodes might not be available
            }

        } catch (err) {
            console.error('[Gateway] Failed to fetch status:', err);
        }
    }, []);

    // Fetch tasks from Gateway
    const fetchTasks = useCallback(async () => {
        const client = clientRef.current;
        if (!client?.isConnected) return;

        try {
            const result = await client.getTaskQueue() as GatewayTask[];
            setTasks(Array.isArray(result) ? result : []);
        } catch (err) {
            console.error('[Gateway] Failed to fetch tasks:', err);
        }
    }, []);

    // Submit a new task
    const submitTask = useCallback(async (description: string, options?: { priority?: string; category?: string }) => {
        const client = clientRef.current;
        if (!client?.isConnected) throw new Error('Not connected');

        const result = await client.submitTask(description, options);
        await fetchTasks();
        return result;
    }, [fetchTasks]);

    // Run agent command
    const runAgent = useCallback(async (prompt: string) => {
        const client = clientRef.current;
        if (!client?.isConnected) throw new Error('Not connected');

        return client.agentRun(prompt);
    }, []);

    // Restart a service
    const restartService = useCallback(async (service: string) => {
        const client = clientRef.current;
        if (!client?.isConnected) throw new Error('Not connected');

        return client.restartService(service);
    }, []);

    // Auto-connect on mount
    useEffect(() => {
        connect();

        // Poll for updates every 10 seconds
        pollIntervalRef.current = setInterval(() => {
            if (clientRef.current?.isConnected) {
                fetchStatus();
                fetchTasks();
            }
        }, 10000);

        return () => {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
            }
            clientRef.current?.disconnect();
        };
    }, [connect, fetchStatus, fetchTasks]);

    return {
        status,
        tasks,
        logs,
        error,
        isConnecting,
        connect,
        submitTask,
        runAgent,
        restartService,
        refresh: () => Promise.all([fetchStatus(), fetchTasks()]),
    };
}
