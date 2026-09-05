/**
 * Nova Skill Forge
 *
 * One governed entry point for generated skills. Inspired by Ada-SI's visible
 * Forge workflow, but deliberately fail-closed: generated code is a proposal,
 * never a live tool. Promotion requires independently verified sandbox,
 * benchmark and canary evidence before an Owner may approve activation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { getNovaLearningDir } from '../core/data-root.js'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { validateSkillCode } from '../synthesis/sandbox.js'
import type { NovaTool } from './complete-registry.js'

export type SkillForgeStage = 'proposed' | 'sandbox-authorized' | 'sandbox-tested' | 'benchmark-passed' | 'canary-tested' | 'approved' | 'active' | 'degraded' | 'rejected'
export interface SkillForgeEvidence { stage: SkillForgeStage; evidenceRef: string; verifiedAt: string }
export interface SkillProposal {
    id: string
    ownerId: string
    name: string
    description: string
    why: string
    code: string
    codeHash: string
    parameters: Array<{ name: string; type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>
    dependencies: string[]
    status: SkillForgeStage
    evidence: SkillForgeEvidence[]
    createdAt: number
    decidedAt?: number
    activationBlockedReason?: string
}

interface LegacySkillProposal extends Omit<Partial<SkillProposal>, 'status'> { status?: SkillForgeStage | 'pending' }
function getProposalsPath(): string { return getNovaLearningDir('skill-forge.json') }

function normalizeProposal(raw: LegacySkillProposal): SkillProposal | null {
    const name = String(raw.name || '').trim()
    const code = String(raw.code || '')
    if (!raw.id || !name || !code) return null
    return {
        id: String(raw.id), ownerId: String(raw.ownerId || 'nova-self'), name,
        description: String(raw.description || ''), why: String(raw.why || ''), code,
        codeHash: String(raw.codeHash || createHash('sha256').update(code).digest('hex')),
        parameters: Array.isArray(raw.parameters) ? raw.parameters : [],
        dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String).slice(0, 50) : [],
        status: raw.status === 'pending' || !raw.status ? 'proposed' : raw.status,
        evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
        createdAt: Number(raw.createdAt || Date.now()), decidedAt: raw.decidedAt,
        activationBlockedReason: raw.activationBlockedReason,
    }
}

function readAll(): SkillProposal[] {
    const path = getProposalsPath()
    if (!existsSync(path)) return []
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        const rows = Array.isArray(parsed) ? parsed : parsed?.proposals
        return (Array.isArray(rows) ? rows : []).map(normalizeProposal).filter(Boolean) as SkillProposal[]
    } catch { return [] }
}
function writeAll(proposals: SkillProposal[]): void {
    atomicWriteJsonSync(getProposalsPath(), { version: 1, updatedAt: new Date().toISOString(), proposals: proposals.slice(-500) })
}

export function getSkillProposals(limit = 50, ownerId?: string): SkillProposal[] {
    return readAll().filter(item => !ownerId || item.ownerId === ownerId).slice(-Math.max(1, Math.min(limit, 500))).map(item => structuredClone(item))
}
export function saveSkillProposal(proposal: SkillProposal): void {
    const existing = readAll().filter(item => item.id !== proposal.id)
    existing.push(structuredClone(proposal)); writeAll(existing)
}

export function createSkillProposal(input: {
    ownerId?: string; name: string; description: string; why: string; code: string
    parameters?: SkillProposal['parameters']; dependencies?: string[]
}): SkillProposal {
    const name = input.name.trim().replace(/[^a-z0-9_]/gi, '_').toLowerCase()
    const code = input.code.trim()
    if (!name || !input.description.trim() || !input.why.trim() || !code) throw new Error('Name, description, why and code are required')
    if (code.length > 20_000) throw new Error('Skill code exceeds the 20 KB proposal limit')
    const validation = validateSkillCode(code)
    if (!validation.valid) throw new Error(`Static skill validation failed: ${validation.errors.join('; ')}`)
    const codeHash = createHash('sha256').update(code).digest('hex')
    const proposal: SkillProposal = {
        id: `forge_${Date.now()}_${randomUUID().slice(0, 8)}`,
        ownerId: String(input.ownerId || 'nova-self').slice(0, 200), name,
        description: input.description.trim(), why: input.why.trim(), code, codeHash,
        parameters: Array.isArray(input.parameters) ? input.parameters.slice(0, 50) : [],
        dependencies: Array.isArray(input.dependencies) ? [...new Set(input.dependencies.map(String))].slice(0, 50) : [],
        status: 'proposed', evidence: [{ stage: 'proposed', evidenceRef: `sha256:${codeHash}`, verifiedAt: new Date().toISOString() }],
        createdAt: Date.now(), activationBlockedReason: 'Native sandbox, benchmark, canary and Owner approval evidence are required.',
    }
    saveSkillProposal(proposal)
    return proposal
}

const ALLOWED_TRANSITIONS: Partial<Record<SkillForgeStage, SkillForgeStage[]>> = {
    proposed: ['sandbox-authorized', 'rejected'],
    'sandbox-authorized': ['sandbox-tested', 'rejected'],
    'sandbox-tested': ['benchmark-passed', 'degraded', 'rejected'],
    'benchmark-passed': ['canary-tested', 'degraded', 'rejected'],
    'canary-tested': ['approved', 'degraded', 'rejected'],
    approved: ['active', 'rejected'], active: ['degraded', 'rejected'], degraded: ['sandbox-authorized', 'rejected'],
}
export function advanceSkillProposal(id: string, ownerId: string, target: SkillForgeStage, evidenceRef: string, options: { operatorApproved?: boolean } = {}): SkillProposal | null {
    const all = readAll()
    const proposal = all.find(item => item.id === id && item.ownerId === ownerId)
    if (!proposal || !evidenceRef || !ALLOWED_TRANSITIONS[proposal.status]?.includes(target)) return null
    if (['sandbox-tested', 'benchmark-passed', 'canary-tested'].includes(target) && !/^(sandbox|benchmark|canary|outcome):/i.test(evidenceRef)) return null
    if (['sandbox-authorized', 'approved', 'active', 'rejected'].includes(target) && options.operatorApproved !== true) return null
    proposal.status = target; proposal.decidedAt = Date.now()
    proposal.evidence.push({ stage: target, evidenceRef: evidenceRef.slice(0, 500), verifiedAt: new Date().toISOString() })
    proposal.evidence = proposal.evidence.slice(-30)
    proposal.activationBlockedReason = target === 'active' ? undefined : 'Skill is not active until every maturity gate has verified evidence.'
    writeAll(all)
    return structuredClone(proposal)
}

export function updateSkillProposalStatus(id: string, status: 'approved' | 'rejected', ownerId = 'nova-self'): SkillProposal | null {
    return advanceSkillProposal(id, ownerId, status === 'rejected' ? 'rejected' : 'sandbox-authorized', status === 'rejected' ? 'operator:rejected' : 'operator:sandbox-authorized', { operatorApproved: true })
}
/** @deprecated Direct installation is intentionally disabled. */
export async function installSkillProposal(_proposal: SkillProposal): Promise<boolean> { return false }

export const buildSkillTool: NovaTool = {
    name: 'build_skill',
    description: 'Erstellt einen reviewbaren Nova-Studio-Forge-Vorschlag. Generierter Code wird nie direkt aktiviert; Sandbox, Benchmark, Canary und Owner-Freigabe sind Pflicht.',
    category: 'other',
    parameters: [
        { name: 'name', type: 'string', description: 'Eindeutiger Tool-Name in snake_case', required: true },
        { name: 'description', type: 'string', description: 'Was der Skill tun soll', required: true },
        { name: 'why', type: 'string', description: 'Belegter Capability-Gap', required: true },
        { name: 'code', type: 'string', description: 'Reviewbarer JavaScript-Entwurf ohne freie Systemzugriffe', required: true },
        { name: 'parameters', type: 'string', description: 'JSON-Array typisierter Parameter', required: false },
        { name: 'dependencies', type: 'string', description: 'Optionales JSON-Array; wird nie automatisch installiert', required: false },
    ],
    handler: async params => {
        try {
            const parseArray = <T>(value: unknown): T[] => {
                if (!value) return []
                const parsed = typeof value === 'string' ? JSON.parse(value) : value
                if (!Array.isArray(parsed)) throw new Error('Expected a JSON array')
                return parsed
            }
            const proposal = createSkillProposal({
                ownerId: String((params as any).ownerId || 'nova-self'), name: String(params.name || ''),
                description: String(params.description || ''), why: String(params.why || ''), code: String(params.code || ''),
                parameters: parseArray<SkillProposal['parameters'][number]>(params.parameters),
                dependencies: parseArray<string>((params as any).dependencies),
            })
            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                const chatId = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID
                if (tg && chatId) await tg.sendWithButtons(chatId,
                    `🧪 *Nova Studio · Skill Forge*\n\n📛 \`${proposal.name}\`\n📝 ${proposal.description}\n💡 ${proposal.why}\n🔒 Noch nicht ausführbar · \`${proposal.codeHash.slice(0, 16)}\``,
                    [[{ text: '🧪 Sandbox freigeben', callback_data: `skill_ok:${proposal.id}` }, { text: '❌ Ablehnen', callback_data: `skill_no:${proposal.id}` }]])
            } catch { /* optional channel */ }
            return `🧪 Forge-Vorschlag \`${proposal.name}\` gespeichert (${proposal.id}). Noch nicht aktiv: Sandbox, Benchmark, Canary und Owner-Freigabe fehlen.`
        } catch (error) { return `❌ Skill-Vorschlag abgelehnt: ${error instanceof Error ? error.message : String(error)}` }
    },
}
