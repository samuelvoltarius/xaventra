// API Route: /api/tasks/[id]
// Single task operations with local storage

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

// GET /api/tasks/[id] - Get single task
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const tasks = await loadTasks();
    const task = tasks.find(t => t.id === id);

    if (!task) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json(task);
}

// PUT /api/tasks/[id] - Update task
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await request.json();
    const tasks = await loadTasks();
    const index = tasks.findIndex(t => t.id === id);

    if (index === -1) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    tasks[index] = {
        ...tasks[index],
        ...body,
        completedAt: body.status === 'completed' ? new Date().toISOString() : tasks[index].completedAt,
    };

    await saveTasks(tasks);
    return NextResponse.json(tasks[index]);
}

// DELETE /api/tasks/[id] - Delete task
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const tasks = await loadTasks();
    const filtered = tasks.filter(t => t.id !== id);

    await saveTasks(filtered);
    return NextResponse.json({ success: true });
}
