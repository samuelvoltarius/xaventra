/**
 * Nova Distributed Learning Hub
 * 
 * Multiple Nova instances share their learnings with each other!
 * - Push: When Nova learns something, share it with others
 * - Pull: Periodically fetch what other Novas have learned
 * 
 * PRIVACY: ONLY learning topics and facts are shared
 * NEVER: User data, credentials, IPs, personal info
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Configuration
// ============================================

// Load Supabase config from nova.config.json (REQUIRED — no hardcoded fallbacks)
function loadLearningHubConfig(): { url: string, key: string } {
    const configPath = join(process.cwd(), 'nova.config.json')
    try {
        if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            if (config.supabase?.learningUrl && config.supabase?.learningKey) {
                return { url: config.supabase.learningUrl, key: config.supabase.learningKey }
            }
        }
    } catch { /* config read error */ }
    // Check env vars as last resort (no hardcoded secrets!)
    if (process.env.NOVA_LEARNING_SUPABASE_URL && process.env.NOVA_LEARNING_SUPABASE_KEY) {
        return { url: process.env.NOVA_LEARNING_SUPABASE_URL, key: process.env.NOVA_LEARNING_SUPABASE_KEY }
    }
    console.warn('[LearningHub] ⚠️ No Supabase config found in nova.config.json (supabase.learningUrl/learningKey) — learning sync disabled')
    return { url: '', key: '' }
}
const { url: SUPABASE_URL, key: SUPABASE_ANON_KEY } = loadLearningHubConfig()
const REMOTE_LEARNING_ENABLED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

// Generate unique instance ID per Nova installation
const INSTANCE_ID_FILE = join(process.cwd(), '.nova-data', 'instance-id.txt')

function getInstanceId(): string {
    try {
        if (existsSync(INSTANCE_ID_FILE)) {
            return readFileSync(INSTANCE_ID_FILE, 'utf-8').trim()
        }
        const id = `nova-${randomUUID().slice(0, 8)}`
        writeFileSync(INSTANCE_ID_FILE, id)
        return id
    } catch {
        return `nova-${Date.now()}`
    }
}

const INSTANCE_ID = getInstanceId()

// ============================================
// Types
// ============================================

interface SharedLearning {
    id?: string
    topic: string
    facts: string[]
    source_instance: string
    success_count: number
    fail_count: number
    created_at?: string
    updated_at?: string
}

// ============================================
// Supabase Client (lightweight, no dependencies)
// ============================================

async function supabaseRequest<T>(
    table: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    query?: string,
    retryCount = 0
): Promise<{ data: T | null; error: string | null }> {
    const MAX_RETRIES = 3
    const RETRY_DELAY = 2000

    try {
        const url = `${SUPABASE_URL}/${table}${query ? `?${query}` : ''}`

        const headers: Record<string, string> = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
        }

        const response = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        })

        if (!response.ok) {
            const text = await response.text()

            // Retry on 503 (schema cache) errors
            if (response.status === 503 && retryCount < MAX_RETRIES) {
                console.log(`[LearningHub] 🔄 Schema cache not ready, retrying in ${RETRY_DELAY}ms... (${retryCount + 1}/${MAX_RETRIES})`)
                await new Promise(r => setTimeout(r, RETRY_DELAY))
                return supabaseRequest(table, method, body, query, retryCount + 1)
            }

            return { data: null, error: `HTTP ${response.status}: ${text}` }
        }

        const data = method === 'GET' || method === 'POST' ? await response.json() : null
        return { data: data as T, error: null }
    } catch (err) {
        // Retry on network errors too
        if (retryCount < MAX_RETRIES) {
            console.log(`[LearningHub] 🔄 Network error, retrying... (${retryCount + 1}/${MAX_RETRIES})`)
            await new Promise(r => setTimeout(r, RETRY_DELAY))
            return supabaseRequest(table, method, body, query, retryCount + 1)
        }
        return { data: null, error: String(err) }
    }
}

// ============================================
// Local Fallback Store (when Supabase not configured)
// ============================================

const LOCAL_KNOWLEDGE_FILE = join(process.cwd(), '.nova-data', 'shared-knowledge.json')

function loadLocalKnowledge(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    try {
        if (existsSync(LOCAL_KNOWLEDGE_FILE)) {
            const data = JSON.parse(readFileSync(LOCAL_KNOWLEDGE_FILE, 'utf-8'))
            for (const [topic, facts] of Object.entries(data)) {
                map.set(topic, facts as string[])
            }
        }
    } catch { /* ignore */ }
    return map
}

function saveLocalKnowledge(topic: string, facts: string[]): void {
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const existing: Record<string, string[]> = {}
        try {
            if (existsSync(LOCAL_KNOWLEDGE_FILE)) {
                Object.assign(existing, JSON.parse(readFileSync(LOCAL_KNOWLEDGE_FILE, 'utf-8')))
            }
        } catch { /* ignore */ }
        const currentFacts = existing[topic] || []
        existing[topic] = [...new Set([...currentFacts, ...facts])].slice(0, 20)
        writeFileSync(LOCAL_KNOWLEDGE_FILE, JSON.stringify(existing, null, 2))
    } catch (err) {
        console.debug('[LearningHub] Local save failed:', err)
    }
}

// ============================================
// Push Knowledge (Share with others)
// ============================================

export async function shareKnowledge(topic: string, facts: string[]): Promise<boolean> {
    // Filter out any sensitive data before sharing
    const safeFacts = facts
        .map(f => sanitizeForSharing(f))
        .filter(f => f.length > 10)  // Only meaningful facts

    if (safeFacts.length === 0) {
        console.log('[LearningHub] 🚫 No safe facts to share')
        return false
    }

    // Always persist locally (works without Supabase)
    saveLocalKnowledge(sanitizeForSharing(topic), safeFacts)

    if (!REMOTE_LEARNING_ENABLED) {
        console.log('[LearningHub] Stored locally; remote learning sync is not configured')
        return true
    }

    const learning: SharedLearning = {
        topic: sanitizeForSharing(topic),
        facts: safeFacts,
        source_instance: INSTANCE_ID,
        success_count: 1,
        fail_count: 0,
    }

    console.log(`[LearningHub] 📤 Sharing knowledge: ${topic.slice(0, 50)}...`)

    // Check if topic already exists
    const existing = await supabaseRequest<SharedLearning[]>(
        'nova_learnings',
        'GET',
        undefined,
        `topic=eq.${encodeURIComponent(topic)}&select=*`
    )

    if (existing.data && existing.data.length > 0) {
        // Topic exists - merge facts
        const existingFacts = existing.data[0].facts || []
        const mergedFacts = [...new Set([...existingFacts, ...safeFacts])].slice(0, 20)

        const result = await supabaseRequest(
            'nova_learnings',
            'PATCH',
            {
                facts: mergedFacts,
                success_count: (existing.data[0].success_count || 0) + 1,
                updated_at: new Date().toISOString(),
            },
            `topic=eq.${encodeURIComponent(topic)}`
        )

        if (result.error) {
            console.log(`[LearningHub] ❌ Share failed: ${result.error}`)
            return false
        }

        console.log(`[LearningHub] ✅ Merged ${safeFacts.length} facts into existing topic`)
        return true
    } else {
        // New topic - insert
        const result = await supabaseRequest<SharedLearning[]>(
            'nova_learnings',
            'POST',
            learning
        )

        if (result.error) {
            console.log(`[LearningHub] ❌ Share failed: ${result.error}`)
            return false
        }

        console.log(`[LearningHub] ✅ Shared new topic with ${safeFacts.length} facts`)
        return true
    }
}

// ============================================
// Pull Knowledge (Learn from others)
// ============================================

export async function fetchSharedKnowledge(): Promise<Map<string, string[]>> {
    if (!REMOTE_LEARNING_ENABLED) return loadLocalKnowledge()
    console.log('[LearningHub] 📥 Fetching shared knowledge from other Novas...')

    const result = await supabaseRequest<SharedLearning[]>(
        'nova_learnings',
        'GET',
        undefined,
        'select=topic,facts,success_count&order=success_count.desc&limit=50'
    )

    const knowledge = new Map<string, string[]>()

    if (result.error) {
        console.log(`[LearningHub] ❌ Fetch failed: ${result.error}`)
    } else if (result.data) {
        for (const learning of result.data) {
            if (learning.topic && learning.facts) {
                knowledge.set(learning.topic, learning.facts)
            }
        }
        console.log(`[LearningHub] ✅ Received ${knowledge.size} topics from the collective`)
    }

    // Merge local fallback knowledge
    const localKnowledge = loadLocalKnowledge()
    for (const [topic, facts] of localKnowledge.entries()) {
        if (!knowledge.has(topic)) {
            knowledge.set(topic, facts)
        }
    }

    return knowledge
}

// ============================================
// Report Success/Failure (Improve rankings)
// ============================================

export async function reportLearningOutcome(topic: string, success: boolean): Promise<void> {
    if (!REMOTE_LEARNING_ENABLED) return
    const field = success ? 'success_count' : 'fail_count'

    // Get current count
    const existing = await supabaseRequest<SharedLearning[]>(
        'nova_learnings',
        'GET',
        undefined,
        `topic=eq.${encodeURIComponent(topic)}&select=${field}`
    )

    if (existing.data && existing.data.length > 0) {
        const currentCount = (existing.data[0] as any)[field] || 0

        await supabaseRequest(
            'nova_learnings',
            'PATCH',
            { [field]: currentCount + 1 },
            `topic=eq.${encodeURIComponent(topic)}`
        )

        console.log(`[LearningHub] 📊 Reported ${success ? 'success' : 'failure'} for: ${topic.slice(0, 40)}`)
    }
}

// ============================================
// Get Stats
// ============================================

export async function getHubStats(): Promise<{ totalTopics: number; totalFacts: number; topContributors: string[] }> {
    if (!REMOTE_LEARNING_ENABLED) {
        const local = loadLocalKnowledge()
        return { totalTopics: local.size, totalFacts: [...local.values()].reduce((sum, facts) => sum + facts.length, 0), topContributors: [] }
    }
    const result = await supabaseRequest<SharedLearning[]>(
        'nova_learnings',
        'GET',
        undefined,
        'select=topic,facts,source_instance'
    )

    if (result.error || !result.data) {
        return { totalTopics: 0, totalFacts: 0, topContributors: [] }
    }

    const contributors = new Map<string, number>()
    let totalFacts = 0

    for (const learning of result.data) {
        totalFacts += learning.facts?.length || 0
        const count = contributors.get(learning.source_instance) || 0
        contributors.set(learning.source_instance, count + 1)
    }

    const topContributors = [...contributors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id]) => id)

    return {
        totalTopics: result.data.length,
        totalFacts,
        topContributors,
    }
}

// ============================================
// Privacy Sanitization
// ============================================

function sanitizeForSharing(text: string): string {
    return text
        // Remove IP addresses
        .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[IP]')
        // Remove file paths
        .replace(/[A-Z]:\\[^\s]*/gi, '[PATH]')
        .replace(/\/home\/[^\s\/]+/g, '/home/[USER]')
        .replace(/\/Users\/[^\s\/]+/g, '/Users/[USER]')
        // Remove usernames/emails
        .replace(/[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi, '[EMAIL]')
        // Remove passwords
        .replace(/-pw\s*"[^"]*"/gi, '-pw "[PASS]"')
        .replace(/password[=:]\s*\S+/gi, 'password=[PASS]')
        // Remove API keys
        .replace(/[a-zA-Z0-9]{32,}/g, '[KEY]')
        // Keep it clean
        .trim()
}

// ============================================
// Sync Loop (runs in background)
// ============================================

let syncInterval: NodeJS.Timeout | null = null

export function startLearningSync(intervalMinutes: number = 30): void {
    if (syncInterval) return

    if (!REMOTE_LEARNING_ENABLED) {
        console.log('[LearningHub] Remote sync disabled; local governed learning remains active')
        return
    }

    console.log(`[LearningHub] 🔄 Starting sync loop (every ${intervalMinutes} min)`)
    console.log(`[LearningHub] 📍 Instance ID: ${INSTANCE_ID}`)

    // Initial fetch
    fetchSharedKnowledge().then(knowledge => {
        if (knowledge.size > 0) {
            console.log(`[LearningHub] 📚 Loaded ${knowledge.size} shared topics`)
        }
    })

    syncInterval = setInterval(async () => {
        const knowledge = await fetchSharedKnowledge()
        if (knowledge.size > 0) {
            // Merge into local store
            const proactiveLearning = await import('./proactive-learning.js')

            for (const [topic, facts] of knowledge.entries()) {
                // Add to local knowledge if we don't have it
                if (!proactiveLearning.hasKnowledgeAbout(topic)) {
                    proactiveLearning.storeKnowledge(topic, facts)
                    console.log(`[LearningHub] 📖 Learned from collective: ${topic.slice(0, 50)} (${facts.length} facts)`)
                }
            }
        }
    }, intervalMinutes * 60 * 1000)
}

export function stopLearningSync(): void {
    if (syncInterval) {
        clearInterval(syncInterval)
        syncInterval = null
        console.log('[LearningHub] Stopped sync')
    }
}

// ============================================
// Export
// ============================================

export default {
    shareKnowledge,
    fetchSharedKnowledge,
    reportLearningOutcome,
    getHubStats,
    startLearningSync,
    stopLearningSync,
    INSTANCE_ID,
}
