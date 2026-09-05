// Nova API Client
// Connects to Nova Dashboard Server for task management

const NOVA_API_URL = process.env.NEXT_PUBLIC_NOVA_API_URL || 'http://localhost:3000'

export interface Task {
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    priority: 'low' | 'normal' | 'high' | 'urgent';
    category: 'file' | 'code' | 'research' | 'system' | 'message' | 'other';
    createdAt: string;
    completedAt?: string;
    result?: string;
    error?: string;
}

export interface NovaStatus {
    timestamp: string;
    workspace: string;
    services: Record<string, string>;
    memoryFiles: string[];
    taskQueue: {
        pending: number;
        completed: number;
        failed: number;
    };
}

export interface Screenshot {
    path: string;
    name: string;
    createdAt: string;
}

// Fetch with error handling
async function fetchNova<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${NOVA_API_URL}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options?.headers,
        },
    })

    if (!response.ok) {
        throw new Error(`Nova API error: ${response.status}`)
    }

    return response.json()
}

// API Functions
export async function getStatus(): Promise<NovaStatus> {
    return fetchNova('/api/status')
}

export async function getTasks(): Promise<Task[]> {
    return fetchNova('/api/tasks')
}

export async function getTask(id: string): Promise<Task> {
    return fetchNova(`/api/tasks/${id}`)
}

export async function createTask(task: Partial<Task>): Promise<Task> {
    return fetchNova('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(task),
    });
}

export async function updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    return fetchNova(`/api/tasks/${id}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
    });
}

export async function approveTask(id: string, message?: string): Promise<Task> {
    return fetchNova(`/api/tasks/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ message }),
    });
}

export async function cancelTask(id: string): Promise<void> {
    return fetchNova(`/api/tasks/${id}`, {
        method: 'DELETE',
    });
}

export async function getScreenshots(): Promise<Screenshot[]> {
    return fetchNova('/api/screenshots');
}

export async function getMemoryFiles(): Promise<string[]> {
    return fetchNova('/api/memory');
}

export async function getMemoryFile(filename: string): Promise<string> {
    return fetchNova(`/api/memory/${encodeURIComponent(filename)}`);
}
