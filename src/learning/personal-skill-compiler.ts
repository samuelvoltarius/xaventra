import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaLearningDir } from '../core/data-root.js'
import { workflowSignature, type WorkflowEpisode } from '../memory/workflow-episode-store.js'

export interface PersonalSkillProposal {
    id: string
    userId: string
    name: string
    version: number
    signature: string
    toolSequence: string[]
    successfulSamples: number
    failedSamples: number
    sourceRunIds: string[]
    status: SkillMaturityStatus
    maturityEvidence: Array<{ stage: SkillMaturityStatus; evidenceRef: string; verifiedAt: string }>
    consecutiveFailures: number
    updatedAt: string
}

export type SkillMaturityStatus = 'candidate' | 'proposed' | 'sandbox-tested' | 'benchmark-passed' | 'canary-tested' | 'approved' | 'active' | 'degraded' | 'rejected'

interface ProposalFile { version: 1; updatedAt: string; proposals: PersonalSkillProposal[] }

export class PersonalSkillCompiler {
    private proposals: PersonalSkillProposal[] = []

    constructor(private readonly path = join(getNovaLearningDir(), 'personal-skill-proposals.json')) {
        try { if (existsSync(path)) this.proposals = (JSON.parse(readFileSync(path, 'utf8')) as ProposalFile).proposals || [] } catch { this.proposals = [] }
    }

    observe(episode: WorkflowEpisode): PersonalSkillProposal {
        const signature = workflowSignature(episode)
        const key = `${episode.userId}\0${signature}`
        const id = createHash('sha256').update(key).digest('hex').slice(0, 24)
        let proposal = this.proposals.find(item => item.id === id)
        if (!proposal) {
            proposal = {
                id, userId: episode.userId,
                name: `workflow-${episode.steps.map(step => step.toolName).join('-').slice(0, 80)}`,
                version: 1, signature, toolSequence: episode.steps.map(step => step.toolName),
                successfulSamples: 0, failedSamples: 0, sourceRunIds: [], status: 'candidate',
                maturityEvidence: [], consecutiveFailures: 0, updatedAt: episode.createdAt,
            }
            this.proposals.push(proposal)
        }
        if (episode.success) proposal.successfulSamples++
        else proposal.failedSamples++
        proposal.sourceRunIds = [...new Set([...proposal.sourceRunIds, episode.runId])].slice(-20)
        if (proposal.status === 'candidate' && proposal.successfulSamples >= 3 && proposal.failedSamples === 0) proposal.status = 'proposed'
        proposal.updatedAt = new Date().toISOString()
        this.proposals = this.proposals.slice(-500)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt: proposal.updatedAt, proposals: this.proposals } satisfies ProposalFile)
        return JSON.parse(JSON.stringify(proposal))
    }

    list(userId?: string): PersonalSkillProposal[] {
        return this.proposals.filter(item => !userId || item.userId === userId).map(item => JSON.parse(JSON.stringify(item)))
    }

    advance(id: string, target: SkillMaturityStatus, evidenceRef: string, options: { operatorApproved?: boolean } = {}): PersonalSkillProposal | null {
        const proposal = this.proposals.find(item => item.id === id)
        if (!proposal || !evidenceRef || target === 'candidate' || target === 'proposed') return null
        const allowed: Partial<Record<SkillMaturityStatus, SkillMaturityStatus[]>> = {
            proposed: ['sandbox-tested', 'rejected'],
            'sandbox-tested': ['benchmark-passed', 'degraded', 'rejected'],
            'benchmark-passed': ['canary-tested', 'degraded', 'rejected'],
            'canary-tested': ['approved', 'degraded', 'rejected'],
            approved: ['active', 'rejected'],
            active: ['degraded', 'rejected'],
            degraded: ['sandbox-tested', 'rejected'],
        }
        if (!allowed[proposal.status]?.includes(target)) return null
        if ((target === 'approved' || target === 'active') && options.operatorApproved !== true) return null
        proposal.status = target
        proposal.maturityEvidence ||= []
        proposal.maturityEvidence.push({ stage: target, evidenceRef, verifiedAt: new Date().toISOString() })
        proposal.maturityEvidence = proposal.maturityEvidence.slice(-20)
        proposal.consecutiveFailures = 0
        proposal.updatedAt = new Date().toISOString()
        this.persist(proposal.updatedAt)
        return structuredClone(proposal)
    }

    recordRuntimeOutcome(id: string, success: boolean, runId: string): PersonalSkillProposal | null {
        const proposal = this.proposals.find(item => item.id === id)
        if (!proposal) return null
        proposal.sourceRunIds = [...new Set([...proposal.sourceRunIds, runId])].slice(-20)
        proposal.consecutiveFailures = success ? 0 : (proposal.consecutiveFailures || 0) + 1
        if (!success && proposal.status === 'active') {
            proposal.status = 'degraded'
            proposal.maturityEvidence ||= []
            proposal.maturityEvidence.push({ stage: 'degraded', evidenceRef: `outcome:${runId}`, verifiedAt: new Date().toISOString() })
        }
        proposal.updatedAt = new Date().toISOString()
        this.persist(proposal.updatedAt)
        return structuredClone(proposal)
    }

    retractRun(runId: string): number {
        let changed = 0
        for (const proposal of this.proposals) {
            if (!proposal.sourceRunIds.includes(runId)) continue
            proposal.sourceRunIds = proposal.sourceRunIds.filter(id => id !== runId)
            if (proposal.successfulSamples > 0) proposal.successfulSamples--
            if (proposal.status !== 'candidate' && proposal.status !== 'rejected') proposal.status = 'degraded'
            proposal.updatedAt = new Date().toISOString()
            changed++
        }
        if (changed > 0) this.persist(new Date().toISOString())
        return changed
    }

    getStats(userId?: string): { total: number; proposed: number; approved: number } {
        const values = this.list(userId)
        return { total: values.length, proposed: values.filter(item => item.status === 'proposed').length, approved: values.filter(item => item.status === 'approved' || item.status === 'active').length }
    }

    private persist(updatedAt: string): void {
        this.proposals = this.proposals.slice(-500)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt, proposals: this.proposals } satisfies ProposalFile)
    }
}

let singleton: PersonalSkillCompiler | null = null
export function getPersonalSkillCompiler(): PersonalSkillCompiler { return singleton ||= new PersonalSkillCompiler() }
export function setPersonalSkillCompiler(value: PersonalSkillCompiler): void { singleton = value }
