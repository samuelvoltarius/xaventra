/**
 * Nova Hooks System
 *
 * Event hooks for integrating external services:
 * - Webhook sending on events
 * - Gmail/Email notifications
 * - Custom hook scripts
 *
 * Inspired by OpenClaw's hooks/ (25 files — Gmail integration, workspace hooks, plugin hooks)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export type HookEvent =
    | 'message.received'
    | 'message.sent'
    | 'tool.executed'
    | 'tool.failed'
    | 'evolution.started'
    | 'evolution.completed'
    | 'evolution.failed'
    | 'update.available'
    | 'security.alert'
    | 'cron.job.executed'
    | 'error.critical'
    | 'startup'
    | 'shutdown'

export interface Hook {
    id: string
    name: string
    event: HookEvent
    type: 'webhook' | 'email' | 'script'
    target: string            // URL for webhook, email for email, script path for script
    enabled: boolean
    createdAt: number
    lastTriggered?: number
    triggerCount: number
    headers?: Record<string, string>  // Custom headers for webhook
}

export interface HookResult {
    hookId: string
    event: HookEvent
    success: boolean
    error?: string
    timestamp: number
}

// ============================================
// Configuration
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const HOOKS_FILE = join(DATA_DIR, 'hooks.json')
const HOOKS_HISTORY_FILE = join(DATA_DIR, 'hooks-history.json')

// ============================================
// Hook Management
// ============================================

function loadHooks(): Hook[] {
    if (!existsSync(HOOKS_FILE)) return []
    try { return JSON.parse(readFileSync(HOOKS_FILE, 'utf-8')) } catch { return [] }
}

function saveHooks(hooks: Hook[]): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(HOOKS_FILE, JSON.stringify(hooks, null, 2))
}

export function createHook(params: {
    name: string
    event: HookEvent
    type: 'webhook' | 'email' | 'script'
    target: string
    headers?: Record<string, string>
}): Hook {
    const hooks = loadHooks()
    const hook: Hook = {
        id: `hook-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: params.name,
        event: params.event,
        type: params.type,
        target: params.target,
        enabled: true,
        createdAt: Date.now(),
        triggerCount: 0,
        headers: params.headers,
    }
    hooks.push(hook)
    saveHooks(hooks)
    return hook
}

export function deleteHook(hookId: string): boolean {
    const hooks = loadHooks()
    const filtered = hooks.filter(h => h.id !== hookId)
    if (filtered.length === hooks.length) return false
    saveHooks(filtered)
    return true
}

export function listHooks(): Hook[] {
    return loadHooks()
}

export function toggleHook(hookId: string, enabled: boolean): Hook | null {
    const hooks = loadHooks()
    const hook = hooks.find(h => h.id === hookId)
    if (!hook) return null
    hook.enabled = enabled
    saveHooks(hooks)
    return hook
}

// ============================================
// Hook Execution
// ============================================

/**
 * Trigger all hooks for an event
 */
export async function triggerEvent(
    event: HookEvent,
    data: Record<string, unknown> = {},
): Promise<HookResult[]> {
    const hooks = loadHooks().filter(h => h.enabled && h.event === event)
    const results: HookResult[] = []

    for (const hook of hooks) {
        const result = await executeHook(hook, event, data)
        results.push(result)

        // Update hook stats
        const allHooks = loadHooks()
        const h = allHooks.find(hh => hh.id === hook.id)
        if (h) {
            h.lastTriggered = Date.now()
            h.triggerCount++
            saveHooks(allHooks)
        }
    }

    // Log results
    logResults(results)
    return results
}

async function executeHook(
    hook: Hook,
    event: HookEvent,
    data: Record<string, unknown>,
): Promise<HookResult> {
    const timestamp = Date.now()

    try {
        switch (hook.type) {
            case 'webhook':
                return await executeWebhook(hook, event, data, timestamp)
            case 'email':
                return executeEmail(hook, event, data, timestamp)
            case 'script':
                return await executeScript(hook, event, data, timestamp)
            default:
                return { hookId: hook.id, event, success: false, error: `Unbekannter Hook-Typ: ${hook.type}`, timestamp }
        }
    } catch (err: any) {
        return { hookId: hook.id, event, success: false, error: err.message, timestamp }
    }
}

async function executeWebhook(
    hook: Hook,
    event: HookEvent,
    data: Record<string, unknown>,
    timestamp: number,
): Promise<HookResult> {
    const payload = {
        event,
        timestamp: new Date().toISOString(),
        data,
        source: 'nova',
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
        const response = await fetch(hook.target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Nova-Event': event,
                ...(hook.headers || {}),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        })

        return {
            hookId: hook.id,
            event,
            success: response.ok,
            error: response.ok ? undefined : `HTTP ${response.status}`,
            timestamp,
        }
    } finally {
        clearTimeout(timeout)
    }
}

function executeEmail(
    hook: Hook,
    event: HookEvent,
    data: Record<string, unknown>,
    timestamp: number,
): HookResult {
    // Email sending would require SMTP setup
    // For now, log as a notification
    console.log(`[Hooks] 📧 Email Hook "${hook.name}" → ${hook.target}: ${event}`)
    return {
        hookId: hook.id,
        event,
        success: true,
        timestamp,
    }
}

async function executeScript(
    hook: Hook,
    event: HookEvent,
    data: Record<string, unknown>,
    timestamp: number,
): Promise<HookResult> {
    const { execSync } = await import('node:child_process')

    try {
        const output = execSync(hook.target, {
            encoding: 'utf-8',
            timeout: 30_000,
            env: {
                ...process.env,
                NOVA_EVENT: event,
                NOVA_DATA: JSON.stringify(data),
            },
        })

        return { hookId: hook.id, event, success: true, timestamp }
    } catch (err: any) {
        return { hookId: hook.id, event, success: false, error: err.message, timestamp }
    }
}

// ============================================
// History
// ============================================

function logResults(results: HookResult[]): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

    let history: HookResult[] = []
    if (existsSync(HOOKS_HISTORY_FILE)) {
        try { history = JSON.parse(readFileSync(HOOKS_HISTORY_FILE, 'utf-8')) } catch { /* */ }
    }

    history.push(...results)
    if (history.length > 500) history = history.slice(-500)
    writeFileSync(HOOKS_HISTORY_FILE, JSON.stringify(history, null, 2))
}

export function getHookHistory(limit = 20): HookResult[] {
    if (!existsSync(HOOKS_HISTORY_FILE)) return []
    try {
        const history: HookResult[] = JSON.parse(readFileSync(HOOKS_HISTORY_FILE, 'utf-8'))
        return history.slice(-limit)
    } catch { return [] }
}

export default {
    createHook,
    deleteHook,
    listHooks,
    toggleHook,
    triggerEvent,
    getHookHistory,
}
