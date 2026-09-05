/**
 * Nova Agent Patterns
 * 
 * Inspired by OpenClaw's agents/ (363 files)
 * Tool-policy engine, model fallback chains, context compaction,
 * sub-agent spawning, skill loading.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'

// ============================================
// Tool Policy Engine
// ============================================

export type ToolPolicyAction = 'allow' | 'deny' | 'confirm'

export interface ToolPolicy {
    pattern: string
    action: ToolPolicyAction
    reason?: string
    maxCallsPerSession?: number
}

const toolPolicies: ToolPolicy[] = []
const toolCallCounts = new Map<string, number>()

export function addToolPolicy(policy: ToolPolicy): void {
    toolPolicies.push(policy)
}

export function removeToolPolicy(pattern: string): boolean {
    const idx = toolPolicies.findIndex(p => p.pattern === pattern)
    if (idx === -1) return false
    toolPolicies.splice(idx, 1)
    return true
}

export function checkToolPolicy(toolName: string, sessionId = 'default'): {
    action: ToolPolicyAction
    reason?: string
} {
    for (const policy of toolPolicies) {
        const matches = policy.pattern === '*'
            || policy.pattern === toolName
            || (policy.pattern.endsWith('*') && toolName.startsWith(policy.pattern.slice(0, -1)))
            || (policy.pattern.startsWith('*') && toolName.endsWith(policy.pattern.slice(1)))

        if (matches) {
            if (policy.maxCallsPerSession) {
                const key = `${sessionId}:${toolName}`
                const count = toolCallCounts.get(key) || 0
                if (count >= policy.maxCallsPerSession) {
                    return { action: 'deny', reason: `Max calls exceeded (${policy.maxCallsPerSession})` }
                }
            }
            return { action: policy.action, reason: policy.reason }
        }
    }
    return { action: 'allow' }
}

export function recordToolCall(toolName: string, sessionId = 'default'): void {
    const key = `${sessionId}:${toolName}`
    toolCallCounts.set(key, (toolCallCounts.get(key) || 0) + 1)
}

export function resetToolCallCounts(sessionId?: string): void {
    if (sessionId) {
        for (const key of toolCallCounts.keys()) {
            if (key.startsWith(`${sessionId}:`)) toolCallCounts.delete(key)
        }
    } else {
        toolCallCounts.clear()
    }
}

export function listToolPolicies(): ToolPolicy[] {
    return [...toolPolicies]
}

// NOTE: Model Fallback is handled by llm/fallback.ts (ModelFallback class)
// NOTE: Sub-Agent spawning is handled by layers/L8-sub-agent.ts + resilience/orchestrator.ts

// ============================================
// Context Compaction
// ============================================

export interface CompactionConfig {
    maxMessages: number
    maxTokensEstimate: number
    keepSystemMessages: boolean
    keepLastN: number
    summarize: boolean
}

const DEFAULT_COMPACTION: CompactionConfig = {
    maxMessages: 50,
    maxTokensEstimate: 100_000,
    keepSystemMessages: true,
    keepLastN: 10,
    summarize: true,
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    timestamp?: number
    tokens?: number
}

export function compactMessages(
    messages: ChatMessage[],
    config: Partial<CompactionConfig> = {},
): { messages: ChatMessage[]; removed: number; summary?: string } {
    const cfg = { ...DEFAULT_COMPACTION, ...config }

    if (messages.length <= cfg.maxMessages) {
        return { messages, removed: 0 }
    }

    const result: ChatMessage[] = []
    const systemMessages = messages.filter(m => m.role === 'system')
    const nonSystem = messages.filter(m => m.role !== 'system')

    // Keep system messages
    if (cfg.keepSystemMessages) {
        result.push(...systemMessages)
    }

    // Keep last N messages
    const lastN = nonSystem.slice(-cfg.keepLastN)
    const toRemove = nonSystem.slice(0, nonSystem.length - cfg.keepLastN)

    // Create summary of removed messages
    let summary: string | undefined
    if (cfg.summarize && toRemove.length > 0) {
        const userMsgs = toRemove.filter(m => m.role === 'user').map(m => m.content)
        const assistantMsgs = toRemove.filter(m => m.role === 'assistant').map(m => m.content)
        summary = [
            `[Compacted ${toRemove.length} messages]`,
            userMsgs.length > 0 ? `User topics: ${userMsgs.slice(0, 5).map(m => m.slice(0, 50)).join('; ')}` : '',
            assistantMsgs.length > 0 ? `Assistant covered: ${assistantMsgs.slice(0, 3).map(m => m.slice(0, 50)).join('; ')}` : '',
        ].filter(Boolean).join('\n')

        result.push({
            role: 'system',
            content: `Previous conversation summary:\n${summary}`,
        })
    }

    result.push(...lastN)
    return { messages: result, removed: toRemove.length, summary }
}

export function estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4)
}

export function estimateContextTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

// ============================================
// Skill Loading from Markdown
// ============================================

export interface Skill {
    name: string
    description: string
    content: string
    filePath: string
    activation?: string
    tags?: string[]
}

export function loadSkillsFromDir(skillsDir: string): Skill[] {
    if (!existsSync(skillsDir)) return []
    const skills: Skill[] = []

    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            const skillFile = join(skillsDir, entry.name, 'SKILL.md')
            if (existsSync(skillFile)) {
                const skill = parseSkillFile(skillFile)
                if (skill) skills.push(skill)
            }
        } else if (entry.isFile() && extname(entry.name) === '.md') {
            const skill = parseSkillFile(join(skillsDir, entry.name))
            if (skill) skills.push(skill)
        }
    }

    return skills
}

function parseSkillFile(filePath: string): Skill | null {
    try {
        const raw = readFileSync(filePath, 'utf-8')

        // Parse YAML frontmatter
        const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
        if (!fmMatch) {
            return {
                name: filePath.split(/[/\\]/).slice(-2, -1)[0] || 'unknown',
                description: '',
                content: raw,
                filePath,
            }
        }

        const frontmatter = fmMatch[1] || ''
        const content = fmMatch[2] || ''
        const data: Record<string, string> = {}

        for (const line of frontmatter.split('\n')) {
            const colonIdx = line.indexOf(':')
            if (colonIdx === -1) continue
            data[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
        }

        return {
            name: data.name || filePath.split(/[/\\]/).slice(-2, -1)[0] || 'unknown',
            description: data.description || '',
            content,
            filePath,
            activation: data.activation,
            tags: data.tags?.split(',').map(t => t.trim()),
        }
    } catch {
        return null
    }
}

export function findMatchingSkills(query: string, skills: Skill[]): Skill[] {
    const lower = query.toLowerCase()
    return skills.filter(s => {
        if (s.name.toLowerCase().includes(lower)) return true
        if (s.description.toLowerCase().includes(lower)) return true
        if (s.tags?.some(t => t.toLowerCase().includes(lower))) return true
        if (s.activation && lower.includes(s.activation.toLowerCase())) return true
        return false
    })
}
