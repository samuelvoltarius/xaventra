import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { redactSecrets } from '../security/secret-redaction.js'

export type MemoryAssetKind = 'chat-memory' | 'skill' | 'wiki' | 'code-graph'
export type MemoryAssetVisibility = 'private' | 'team' | 'restricted' | 'agent'
export type MemoryAssetStatus = 'draft' | 'verified' | 'active' | 'superseded' | 'retired'
export type MemoryLoadoutTarget = 'principal' | 'bot' | 'room'

export interface MemoryAsset {
    id: string
    ownerId: string
    name: string
    description: string
    kind: MemoryAssetKind
    visibility: MemoryAssetVisibility
    status: MemoryAssetStatus
    version: number
    content: string
    source: string
    sourceMemoryIds: string[]
    allowedPrincipalIds: string[]
    allowedBotIds: string[]
    createdAt: string
    updatedAt: string
}

export interface MemoryLoadoutBinding {
    id: string
    ownerId: string
    targetType: MemoryLoadoutTarget
    targetId: string
    assetId: string
    priority: number
    enabled: boolean
    createdAt: string
    updatedAt: string
}

interface CatalogData { version: 1; assets: MemoryAsset[]; bindings: MemoryLoadoutBinding[] }

const kinds = new Set<MemoryAssetKind>(['chat-memory', 'skill', 'wiki', 'code-graph'])
const visibilities = new Set<MemoryAssetVisibility>(['private', 'team', 'restricted', 'agent'])
const statuses = new Set<MemoryAssetStatus>(['draft', 'verified', 'active', 'superseded', 'retired'])
const clean = (value: unknown, max: number) => redactSecrets(String(value || '')).replace(/\s+/g, ' ').trim().slice(0, max)
const unique = (value: unknown, max = 100) => Array.isArray(value)
    ? [...new Set(value.map(item => clean(item, 160)).filter(Boolean))].slice(0, max) : []

export class MemoryAssetCatalog {
    private data: CatalogData = { version: 1, assets: [], bindings: [] }

    constructor(private readonly file = join(process.cwd(), '.nova-data', 'memory', 'assets.json')) { this.load() }

    list(ownerId: string, actorId = ownerId): MemoryAsset[] {
        return this.data.assets.filter(asset => this.canRead(asset, actorId)).map(asset => structuredClone(asset))
    }

    get(id: string, actorId: string): MemoryAsset | undefined {
        const asset = this.data.assets.find(item => item.id === id)
        return asset && this.canRead(asset, actorId) ? structuredClone(asset) : undefined
    }

    create(ownerId: string, raw: Partial<MemoryAsset>): MemoryAsset {
        const now = new Date().toISOString()
        const kind = kinds.has(raw.kind as MemoryAssetKind) ? raw.kind as MemoryAssetKind : 'chat-memory'
        const visibility = visibilities.has(raw.visibility as MemoryAssetVisibility) ? raw.visibility as MemoryAssetVisibility : 'private'
        const status = statuses.has(raw.status as MemoryAssetStatus) ? raw.status as MemoryAssetStatus : 'draft'
        const asset: MemoryAsset = {
            id: `asset-${randomUUID()}`, ownerId, kind, visibility, status, version: 1,
            name: clean(raw.name, 120) || 'Unbenanntes Memory Asset', description: clean(raw.description, 500),
            content: clean(raw.content, 40_000), source: clean(raw.source, 300) || 'desktop-owner',
            sourceMemoryIds: unique(raw.sourceMemoryIds), allowedPrincipalIds: unique(raw.allowedPrincipalIds),
            allowedBotIds: unique(raw.allowedBotIds), createdAt: now, updatedAt: now,
        }
        if (asset.status === 'active' && !asset.content && asset.sourceMemoryIds.length === 0) throw new Error('Active assets require content or governed memory references')
        this.data.assets.push(asset); this.save(); return structuredClone(asset)
    }

    update(id: string, ownerId: string, raw: Partial<MemoryAsset>): MemoryAsset {
        const asset = this.data.assets.find(item => item.id === id && item.ownerId === ownerId)
        if (!asset) throw new Error('Memory asset not found')
        if (raw.name !== undefined) asset.name = clean(raw.name, 120) || asset.name
        if (raw.description !== undefined) asset.description = clean(raw.description, 500)
        if (raw.content !== undefined) asset.content = clean(raw.content, 40_000)
        if (raw.visibility && visibilities.has(raw.visibility)) asset.visibility = raw.visibility
        if (raw.status && statuses.has(raw.status)) asset.status = raw.status
        if (raw.allowedPrincipalIds) asset.allowedPrincipalIds = unique(raw.allowedPrincipalIds)
        if (raw.allowedBotIds) asset.allowedBotIds = unique(raw.allowedBotIds)
        if (raw.sourceMemoryIds) asset.sourceMemoryIds = unique(raw.sourceMemoryIds)
        asset.version += 1; asset.updatedAt = new Date().toISOString(); this.save(); return structuredClone(asset)
    }

    bind(ownerId: string, targetType: MemoryLoadoutTarget, targetId: string, assetId: string, enabled = true, priority = 50): MemoryLoadoutBinding {
        if (!['principal', 'bot', 'room'].includes(targetType)) throw new Error('Invalid memory loadout target')
        const asset = this.data.assets.find(item => item.id === assetId && item.ownerId === ownerId)
        if (!asset) throw new Error('Memory asset not found')
        const target = clean(targetId, 160)
        if (!target) throw new Error('Memory loadout target is required')
        const now = new Date().toISOString()
        let binding = this.data.bindings.find(item => item.ownerId === ownerId && item.targetType === targetType && item.targetId === target && item.assetId === assetId)
        if (binding) { binding.enabled = enabled; binding.priority = Math.max(0, Math.min(100, priority)); binding.updatedAt = now }
        else {
            binding = { id: `loadout-${randomUUID()}`, ownerId, targetType, targetId: target, assetId, enabled, priority: Math.max(0, Math.min(100, priority)), createdAt: now, updatedAt: now }
            this.data.bindings.push(binding)
        }
        this.save(); return structuredClone(binding)
    }

    bindings(ownerId: string): MemoryLoadoutBinding[] {
        return this.data.bindings.filter(item => item.ownerId === ownerId).map(item => structuredClone(item))
    }

    resolve(ownerId: string, targets: Array<{ type: MemoryLoadoutTarget; id: string }>, explicitAssetIds: string[] = []): MemoryAsset[] {
        const selected = new Map<string, number>()
        for (const id of explicitAssetIds) selected.set(id, 100)
        for (const binding of this.data.bindings) {
            if (binding.ownerId !== ownerId || !binding.enabled || !targets.some(target => target.type === binding.targetType && target.id === binding.targetId)) continue
            selected.set(binding.assetId, Math.max(selected.get(binding.assetId) || 0, binding.priority))
        }
        return [...selected.entries()].map(([id, priority]) => ({ asset: this.data.assets.find(item => item.id === id), priority }))
            .filter((item): item is { asset: MemoryAsset; priority: number } => Boolean(item.asset && item.asset.status === 'active' && this.canRead(item.asset, ownerId)))
            .sort((a, b) => b.priority - a.priority || b.asset.updatedAt.localeCompare(a.asset.updatedAt))
            .map(item => structuredClone(item.asset))
    }

    promptContext(assets: MemoryAsset[], maxChars = 8_000): string {
        let remaining = Math.max(0, Math.min(20_000, maxChars))
        const lines = ['## Memory-Asset-Loadout', 'Nutze nur diese freigegebenen Assets; Herkunft und Status bleiben maßgeblich.']
        for (const asset of assets) {
            const text = `[${asset.kind} · v${asset.version} · ${asset.status}] ${asset.name}: ${asset.content || `Governed refs: ${asset.sourceMemoryIds.join(', ')}`}`
            if (text.length > remaining) break
            lines.push(text); remaining -= text.length
        }
        return lines.length > 2 ? lines.join('\n') : ''
    }

    private canRead(asset: MemoryAsset, actorId: string): boolean {
        if (asset.ownerId === actorId) return true
        if (asset.visibility === 'team') return true
        return asset.visibility === 'restricted' && asset.allowedPrincipalIds.includes(actorId)
    }

    private load(): void {
        if (!existsSync(this.file)) return
        try { const parsed = JSON.parse(readFileSync(this.file, 'utf8')); if (parsed.version === 1 && Array.isArray(parsed.assets) && Array.isArray(parsed.bindings)) this.data = parsed }
        catch { /* damaged optional catalog starts empty; canonical memory remains untouched */ }
    }
    private save(): void { mkdirSync(dirname(this.file), { recursive: true }); atomicWriteJsonSync(this.file, this.data) }
}

let singleton: MemoryAssetCatalog | null = null
export function getMemoryAssetCatalog(): MemoryAssetCatalog { return singleton ||= new MemoryAssetCatalog() }
