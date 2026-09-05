/**
 * Wave Pipeline — nWave-inspired Structured Mission System
 *
 * 6-Phase workflow with human checkpoints:
 * 1. Discover — understand the problem space
 * 2. Discuss — requirements gathering
 * 3. Design — architecture + approach
 * 4. DevOps — environment + tooling setup
 * 5. Distill — acceptance tests / criteria
 * 6. Deliver — implementation + verification
 *
 * Each wave produces artifacts. User reviews before next wave starts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'missions')

// ============================================
// Types
// ============================================

export type WavePhase = 'discover' | 'discuss' | 'design' | 'devops' | 'distill' | 'deliver'

export interface WaveArtifact {
    phase: WavePhase
    type: 'document' | 'code' | 'test' | 'config' | 'plan'
    title: string
    content: string
    createdAt: number
}

export interface Mission {
    id: string
    title: string
    description: string
    currentPhase: WavePhase
    status: 'active' | 'paused' | 'completed' | 'failed'
    phases: Record<WavePhase, {
        status: 'pending' | 'in-progress' | 'review' | 'approved' | 'skipped'
        startedAt?: number
        completedAt?: number
        artifacts: WaveArtifact[]
        userFeedback?: string
    }>
    createdAt: number
    updatedAt: number
    createdBy: string
}

interface MissionStore {
    missions: Record<string, Mission>
    activeMissionId: string | null
}

// ============================================
// State
// ============================================

const PHASES_ORDER: WavePhase[] = ['discover', 'discuss', 'design', 'devops', 'distill', 'deliver']

let store: MissionStore = {
    missions: {},
    activeMissionId: null,
}

function ensureDir(): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function load(): void {
    ensureDir()
    const path = join(DATA_DIR, 'missions.json')
    if (existsSync(path)) {
        try { store = JSON.parse(readFileSync(path, 'utf-8')) } catch { }
    }
}

function save(): void {
    writeFileSync(join(DATA_DIR, 'missions.json'), JSON.stringify(store, null, 2))
}

// ============================================
// Mission CRUD
// ============================================

export function createMission(title: string, description: string, createdBy: string): Mission {
    load()

    const id = `m-${Date.now().toString(36)}`
    const phases: Mission['phases'] = {} as Mission['phases']

    for (const phase of PHASES_ORDER) {
        phases[phase] = { status: 'pending', artifacts: [] }
    }
    phases.discover.status = 'in-progress'
    phases.discover.startedAt = Date.now()

    const mission: Mission = {
        id,
        title,
        description,
        currentPhase: 'discover',
        status: 'active',
        phases,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy,
    }

    store.missions[id] = mission
    store.activeMissionId = id
    save()

    console.log(`[WavePipeline] 🌊 Mission "${title}" created (id: ${id})`)
    return mission
}

/**
 * Add artifact to current phase
 */
export function addArtifact(
    missionId: string,
    artifact: Omit<WaveArtifact, 'createdAt'>
): void {
    load()
    const mission = store.missions[missionId]
    if (!mission) return

    mission.phases[mission.currentPhase].artifacts.push({
        ...artifact,
        createdAt: Date.now(),
    })
    mission.updatedAt = Date.now()
    save()
}

/**
 * Submit current phase for review
 */
export function submitForReview(missionId: string): string {
    load()
    const mission = store.missions[missionId]
    if (!mission) return '❌ Mission nicht gefunden'

    const phase = mission.phases[mission.currentPhase]
    phase.status = 'review'
    mission.updatedAt = Date.now()
    save()

    const artifacts = phase.artifacts.length
    return `🔍 **Phase "${mission.currentPhase}" zur Review eingereicht**

${artifacts} Artefakt(e) erstellt.

Bitte reviewe und antworte mit:
- ✅ "approved" → Nächste Phase starten
- 🔄 "revise: <feedback>" → Phase überarbeiten
- ⏭️ "skip" → Phase überspringen`
}

/**
 * Approve current phase and advance
 */
export function approvePhase(missionId: string, feedback?: string): string {
    load()
    const mission = store.missions[missionId]
    if (!mission) return '❌ Mission nicht gefunden'

    const currentIdx = PHASES_ORDER.indexOf(mission.currentPhase)
    const phase = mission.phases[mission.currentPhase]

    phase.status = 'approved'
    phase.completedAt = Date.now()
    if (feedback) phase.userFeedback = feedback

    // Advance to next phase
    if (currentIdx < PHASES_ORDER.length - 1) {
        const nextPhase = PHASES_ORDER[currentIdx + 1]
        mission.currentPhase = nextPhase
        mission.phases[nextPhase].status = 'in-progress'
        mission.phases[nextPhase].startedAt = Date.now()
        mission.updatedAt = Date.now()
        save()

        return `✅ Phase "${PHASES_ORDER[currentIdx]}" genehmigt!

🌊 **Nächste Phase: ${nextPhase}** (${currentIdx + 2}/${PHASES_ORDER.length})
${getPhaseDescription(nextPhase)}`
    }

    // Mission complete
    mission.status = 'completed'
    mission.updatedAt = Date.now()
    save()

    return `🎉 **Mission "${mission.title}" abgeschlossen!**
Alle ${PHASES_ORDER.length} Phasen durchlaufen.`
}

/**
 * Revise current phase with feedback
 */
export function revisePhase(missionId: string, feedback: string): string {
    load()
    const mission = store.missions[missionId]
    if (!mission) return '❌ Mission nicht gefunden'

    const phase = mission.phases[mission.currentPhase]
    phase.status = 'in-progress'
    phase.userFeedback = feedback
    mission.updatedAt = Date.now()
    save()

    return `🔄 Phase "${mission.currentPhase}" wird überarbeitet.
Feedback: ${feedback}`
}

// ============================================
// Status & Reporting
// ============================================

export function getMissionStatus(missionId?: string): string {
    load()

    const id = missionId || store.activeMissionId
    if (!id || !store.missions[id]) {
        const count = Object.keys(store.missions).length
        if (count === 0) return '📋 Keine Missionen. Starte eine mit `/mission new <titel>`'
        return `📋 ${count} Mission(en). Aktiv: ${store.activeMissionId || 'keine'}`
    }

    const m = store.missions[id]
    const phaseLines = PHASES_ORDER.map((p, i) => {
        const phase = m.phases[p]
        const icon = phase.status === 'approved' ? '✅' :
            phase.status === 'in-progress' ? '🔵' :
                phase.status === 'review' ? '🔍' :
                    phase.status === 'skipped' ? '⏭️' : '⬜'
        const current = p === m.currentPhase ? ' ← aktuell' : ''
        const artifacts = phase.artifacts.length ? ` (${phase.artifacts.length} Artefakte)` : ''
        return `${icon} ${i + 1}. ${p}${artifacts}${current}`
    }).join('\n')

    return `🌊 **Mission: ${m.title}**
Status: ${m.status} | Phase: ${m.currentPhase}

${phaseLines}

Befehle:
\`/mission status\` — Dieser Status
\`/mission approve\` — Phase genehmigen
\`/mission revise <feedback>\` — Überarbeiten
\`/mission skip\` — Phase überspringen`
}

export function listMissions(): string {
    load()
    const missions = Object.values(store.missions)
    if (missions.length === 0) return '📋 Keine Missionen.'

    return missions.map(m => {
        const completed = PHASES_ORDER.filter(p => m.phases[p].status === 'approved').length
        return `${m.status === 'active' ? '🔵' : m.status === 'completed' ? '✅' : '⏸️'} ${m.id}: ${m.title} (${completed}/${PHASES_ORDER.length} Phasen)`
    }).join('\n')
}

// ============================================
// Helpers
// ============================================

function getPhaseDescription(phase: WavePhase): string {
    const descriptions: Record<WavePhase, string> = {
        discover: '🔍 Problem verstehen, Kontext sammeln, Scope definieren',
        discuss: '💬 Requirements klären, User Stories, Akzeptanzkriterien',
        design: '📐 Architektur, Datenmodell, API-Design, Tech-Entscheidungen',
        devops: '⚙️ Tooling, CI/CD, Environments, Dependencies',
        distill: '🧪 Tests definieren, Edge Cases, Akzeptanztests schreiben',
        deliver: '🚀 Implementation, Code schreiben, Integration, Deployment',
    }
    return descriptions[phase] || ''
}
