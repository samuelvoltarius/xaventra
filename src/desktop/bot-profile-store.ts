import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

export type BotSource = 'nova' | 'hermes' | 'openclaw'
export type BotSpecialization = 'general' | 'doctor' | 'research' | 'development' | 'operations' | 'blue-team' | 'red-team-lab' | 'memory' | 'creative'

export interface BotModelPolicy {
    mode: 'auto' | 'pinned'
    provider?: string
    model?: string
    fallbackToAuto: boolean
}

export interface BotProfile {
    id: string
    ownerId: string
    name: string
    handle: string
    avatar: string
    color: string
    description: string
    specialization: BotSpecialization
    source: BotSource
    externalConnectionId?: string
    externalAgentId?: string
    instructions: string
    toolPacks: string[]
    deniedTools: string[]
    preferredNodeIds: string[]
    modelPolicy: BotModelPolicy
    autonomy: 'observe' | 'safe-auto' | 'governed'
    enabled: boolean
    builtIn: boolean
    createdAt: string
    updatedAt: string
}

type BotInput = Omit<BotProfile, 'id' | 'ownerId' | 'createdAt' | 'updatedAt' | 'builtIn'> & { id?: string }

const SAFE_COLORS = new Set(['#4F7CFF', '#14B8A6', '#F59E0B', '#22C55E', '#F97316', '#EF4444', '#9CA8C2'])
const HANDLE = /^[a-z][a-z0-9-]{1,31}$/

const BUILT_INS: Array<Omit<BotProfile, 'createdAt' | 'updatedAt'>> = [
    { id: 'nova', ownerId: '*', name: 'Nova', handle: 'nova', avatar: 'N', color: '#4F7CFF', description: 'Persoenliche Orchestratorin fuer Alltag, Planung und Ausfuehrung.', specialization: 'general', source: 'nova', instructions: 'Arbeite als Novas allgemeine Orchestratorin. Delegiere Spezialarbeit nur mit sichtbarer Herkunft und bleibe knapp.', toolPacks: [], deniedTools: [], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'governed', enabled: true, builtIn: true },
    { id: 'doctor', ownerId: '*', name: 'Doctor', handle: 'doctor', avatar: 'D', color: '#14B8A6', description: 'Diagnose, Runtime-Checks und kontrollierte Repair-Entwuerfe.', specialization: 'doctor', source: 'nova', instructions: 'Diagnostiziere anhand echter Runtime-Evidence. Aendere nichts ohne Sandbox, Regression, Rollback-Proof und geltendes Gate.', toolPacks: ['self-setup', 'hooks-events'], deniedTools: ['self_evolve'], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'observe', enabled: true, builtIn: true },
    { id: 'researcher', ownerId: '*', name: 'Researcher', handle: 'researcher', avatar: 'R', color: '#4F7CFF', description: 'Recherche mit aktuellen Primaerquellen und Quellenvergleich.', specialization: 'research', source: 'nova', instructions: 'Nutze fuer aktuelle Behauptungen frische Primaerquellen, trenne Fakten von Schlussfolgerungen und zitiere knapp.', toolPacks: ['web-research'], deniedTools: ['run_command', 'ssh'], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'safe-auto', enabled: true, builtIn: true },
    { id: 'developer', ownerId: '*', name: 'Developer', handle: 'developer', avatar: 'C', color: '#F59E0B', description: 'Code, Tests, Reviews und sandbox-isolierte Aenderungen.', specialization: 'development', source: 'nova', instructions: 'Arbeite repository-grounded, bewahre fremde Aenderungen und validiere Code mit passenden Tests. Schreibende Arbeit bleibt workspace- und gate-gebunden.', toolPacks: ['code', 'git'], deniedTools: [], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'governed', enabled: true, builtIn: true },
    { id: 'operator', ownerId: '*', name: 'Operator', handle: 'operator', avatar: 'O', color: '#F97316', description: 'Mesh, Nodes, Deployments, Telemetrie und Failover.', specialization: 'operations', source: 'nova', instructions: 'Behandle Leases, Fencing und Node-Rollen als Autoritaet. Diagnose ist automatisch; Deployments und Konfigurationsaenderungen bleiben freigabepflichtig.', toolPacks: ['mesh-network', 'monitoring'], deniedTools: [], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'governed', enabled: true, builtIn: true },
    { id: 'blue-team', ownerId: '*', name: 'Blue Team', handle: 'blue-team', avatar: 'B', color: '#22C55E', description: 'Defensive Inventarisierung, Log-/IOC-Triage und Incident Response.', specialization: 'blue-team', source: 'nova', instructions: 'Arbeite ausschliesslich defensiv. Sammle begrenzte Evidence und erstelle Containment-Vorschlaege; keine Exploitation oder laterale Bewegung.', toolPacks: ['blue-team'], deniedTools: ['run_command', 'ssh'], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'observe', enabled: true, builtIn: true },
    { id: 'red-team-lab', ownerId: '*', name: 'Red Team Lab', handle: 'red-team', avatar: 'X', color: '#EF4444', description: 'Isolierte Self-Hardening-Simulation gegen Novas eigene Guards.', specialization: 'red-team-lab', source: 'nova', instructions: 'Teste nur Novas lokale Guards mit dem fest definierten, nicht-netzwerkfaehigen Self-Test-Katalog. Keine fremden Ziele, Payload-Generierung, Persistenz oder Ausnutzung.', toolPacks: [], deniedTools: ['run_command', 'ssh', 'browser'], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'observe', enabled: true, builtIn: true },
    { id: 'memory-curator', ownerId: '*', name: 'Memory Curator', handle: 'memory', avatar: 'M', color: '#9CA8C2', description: 'Provenance, Konflikte, Tombstones und Memory-Qualitaet.', specialization: 'memory', source: 'nova', instructions: 'Aendere kanonisches Memory nur ueber Memory Governance. Vermische niemals Benutzer- oder Bot-Scopes und behandle Modellprosa nicht als verifiziertes Outcome.', toolPacks: ['memory'], deniedTools: [], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'observe', enabled: true, builtIn: true },
]

function cleanText(value: unknown, max: number): string { return String(value || '').trim().slice(0, max) }
function clone<T>(value: T): T { return structuredClone(value) }

export class BotProfileStore {
    private bots = new Map<string, BotProfile>()

    constructor(private readonly file = join(process.cwd(), '.nova-data', 'desktop', 'bots.json')) {
        this.load()
        this.seedBuiltIns()
    }

    list(ownerId: string): BotProfile[] {
        return [...this.bots.values()]
            .filter(bot => bot.ownerId === '*' || bot.ownerId === ownerId)
            .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name))
            .map(clone)
    }

    get(id: string, ownerId: string): BotProfile | undefined {
        const bot = this.bots.get(id)
        return bot && (bot.ownerId === '*' || bot.ownerId === ownerId) ? clone(bot) : undefined
    }

    create(ownerId: string, input: BotInput): BotProfile {
        const now = new Date().toISOString()
        const id = input.id ? cleanText(input.id, 64) : `bot-${randomUUID()}`
        if (this.bots.has(id)) throw new Error(`Bot already exists: ${id}`)
        const bot = this.normalize({ ...input, id, ownerId, builtIn: false, createdAt: now, updatedAt: now })
        this.bots.set(bot.id, bot)
        this.save()
        return clone(bot)
    }

    update(id: string, ownerId: string, updates: Partial<BotInput>): BotProfile {
        const current = this.bots.get(id)
        if (!current || current.ownerId !== ownerId || current.builtIn) throw new Error('Bot is not editable by this owner')
        const next = this.normalize({ ...current, ...updates, id: current.id, ownerId, builtIn: false, createdAt: current.createdAt, updatedAt: new Date().toISOString() })
        this.bots.set(id, next)
        this.save()
        return clone(next)
    }

    remove(id: string, ownerId: string): boolean {
        const current = this.bots.get(id)
        if (!current || current.ownerId !== ownerId || current.builtIn) return false
        const deleted = this.bots.delete(id)
        if (deleted) this.save()
        return deleted
    }

    private normalize(value: BotProfile): BotProfile {
        const handle = cleanText(value.handle, 32).toLowerCase()
        if (!HANDLE.test(handle)) throw new Error('Bot handle must match [a-z][a-z0-9-]{1,31}')
        if (!['nova', 'hermes', 'openclaw'].includes(value.source)) throw new Error('Unsupported bot source')
        if (value.source !== 'nova' && !value.externalConnectionId) throw new Error('External bots require a connection reference')
        return {
            ...value,
            name: cleanText(value.name, 80), handle, avatar: cleanText(value.avatar, 8) || 'N',
            color: SAFE_COLORS.has(value.color) ? value.color : '#4F7CFF',
            description: cleanText(value.description, 500), instructions: cleanText(value.instructions, 2_000),
            toolPacks: [...new Set((value.toolPacks || []).map(item => cleanText(item, 80)).filter(Boolean))].slice(0, 32),
            deniedTools: [...new Set((value.deniedTools || []).map(item => cleanText(item, 100)).filter(Boolean))].slice(0, 100),
            preferredNodeIds: [...new Set((value.preferredNodeIds || []).map(item => cleanText(item, 100)).filter(Boolean))].slice(0, 16),
            modelPolicy: { mode: value.modelPolicy?.mode === 'pinned' ? 'pinned' : 'auto', provider: cleanText(value.modelPolicy?.provider, 80) || undefined, model: cleanText(value.modelPolicy?.model, 200) || undefined, fallbackToAuto: value.modelPolicy?.fallbackToAuto !== false },
            enabled: Boolean(value.enabled),
        }
    }

    private seedBuiltIns(): void {
        const now = new Date().toISOString()
        let changed = false
        for (const entry of BUILT_INS) {
            if (this.bots.has(entry.id)) continue
            this.bots.set(entry.id, { ...entry, createdAt: now, updatedAt: now })
            changed = true
        }
        if (changed) this.save()
    }

    private load(): void {
        if (!existsSync(this.file)) return
        try {
            const values = JSON.parse(readFileSync(this.file, 'utf8')) as BotProfile[]
            for (const value of values) this.bots.set(value.id, value)
        } catch { /* corrupted optional projection grants no capability */ }
    }

    private save(): void {
        mkdirSync(dirname(this.file), { recursive: true })
        atomicWriteJsonSync(this.file, [...this.bots.values()])
    }
}

let singleton: BotProfileStore | null = null
export function getBotProfileStore(): BotProfileStore { return singleton ||= new BotProfileStore() }
