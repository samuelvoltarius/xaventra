// API Route: /api/tasks
// Local storage based task management (for standalone mode)

import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || '/tmp/clawdbot-dashboard';
const TASKS_FILE = join(DATA_DIR, 'tasks.json');

interface Task {
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    priority: 'low' | 'normal' | 'high' | 'urgent';
    category: string;
    createdAt: string;
    completedAt?: string;
    result?: string;
}

async function ensureDataDir() {
    try {
        await mkdir(DATA_DIR, { recursive: true });
    } catch {
        // Directory exists
    }
}

async function loadTasks(): Promise<Task[]> {
    try {
        await ensureDataDir();
        const data = await readFile(TASKS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

async function saveTasks(tasks: Task[]) {
    await ensureDataDir();
    await writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

// GET /api/tasks - List all tasks
export async function GET() {
    const tasks = await loadTasks();
    return NextResponse.json(tasks);
}

// POST /api/tasks - Create new task
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const tasks = await loadTasks();

        const newTask: Task = {
            id: `TASK-${Date.now()}`,
            description: body.description,
            status: 'pending',
            priority: body.priority || 'normal',
            category: body.category || 'other',
            createdAt: new Date().toISOString(),
        };

        tasks.unshift(newTask);
        await saveTasks(tasks);

        return NextResponse.json(newTask, { status: 201 });
    } catch (error) {
        console.error('Failed to create task:', error);
        return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }
}
