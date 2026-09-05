/**
 * CORE_FACTS — Tier-0 Memory (Always Injected)
 * 
 * Top ~50 facts that Nova should NEVER forget.
 * Auto-extracted from observer/facts.json + manually curated.
 * Injected at the top of every system prompt.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMemoryGovernanceCoordinator } from '../memory/memory-governance.js'
import { principalScope, resolvePrincipalId } from '../users/principal-id.js'
import { resolveConfigPath } from '../config/config-path.js'


// Under test (Vitest), use an isolated temp path so tests never pollute
// the real CORE_FACTS.json with flood-fact-*/Test-fact-* entries.
const IS_TEST = !!process.env.VITEST || process.env.NODE_ENV === 'test'
const DATA_DIR = IS_TEST
    ? join(process.cwd(), '.nova-test-tmp')
    : join(process.cwd(), '.nova-data')
const CORE_FACTS_PATH = join(DATA_DIR, 'CORE_FACTS.json')
const OBSERVER_FACTS_PATH = IS_TEST
    ? join(DATA_DIR, 'observer-facts.json')
    : join(process.cwd(), '.nova-data', 'observer', 'facts.json')

export interface CoreFact {
    category: 'identity' | 'device' | 'project' | 'preference' | 'pet' | 'network' | 'credential' | 'other'
    fact: string
    source: string        // 'manual' | 'auto_extracted' | 'correction'
    confidence: number    // 0-1
    updatedAt: string
    governanceId?: string
    governanceStatus?: 'canonical' | 'verified' | 'candidate' | 'superseded' | 'rejected' | 'expired'
    expiresAt?: number
}

interface CoreFactsStore {
    facts: CoreFact[]
    lastExtraction: string
    version: number
}

// ============================================
// Load / Save
// ============================================

let store: CoreFactsStore = { facts: [], lastExtraction: '', version: 1 }

function legacyOwnerScope(): string {
    try {
        const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf-8'))
        const owner = config.channels?.telegram?.allowFrom?.[0] || config.allowFrom?.[0]
        if (owner) return principalScope(resolvePrincipalId(config, 'telegram', String(owner)))
    } catch { /* retain global compatibility */ }
    return 'global'
}

function loadCoreFacts(): void {
    try {
        if (existsSync(CORE_FACTS_PATH)) {
            store = JSON.parse(readFileSync(CORE_FACTS_PATH, 'utf-8'))
            console.log(`[CoreFacts] Loaded ${store.facts.length} core facts`)
        }
    } catch { /* fresh start */ }
}

function saveCoreFacts(): void {
    try {
        writeFileSync(CORE_FACTS_PATH, JSON.stringify(store, null, 2))
    } catch (err) {
        console.log(`[CoreFacts] Save error: ${err}`)
    }
}

// ============================================
// CRUD
// ============================================

export function addFact(fact: CoreFact): void {
    if (!fact.governanceId) {
        const kind = fact.category === 'identity' ? 'identity'
            : fact.category === 'preference' ? 'preference'
                : fact.category === 'project' ? 'project' : 'fact'
        const governed = getMemoryGovernanceCoordinator().propose({
            content: fact.fact, kind, scope: 'global', source: `core-facts:${fact.source}`,
            evidence: fact.source === 'correction' ? 'correction' : 'manual',
            confidence: fact.confidence, verified: true, timestamp: Date.parse(fact.updatedAt) || Date.now(),
        })
        if (!governed) return
        fact = { ...fact, governanceId: governed.id, governanceStatus: governed.status }
    }
    // Dedup: check if similar fact exists
    const existing = store.facts.findIndex(f =>
        f.fact.toLowerCase() === fact.fact.toLowerCase() ||
        (f.category === fact.category && f.fact.includes(fact.fact.slice(0, 30)))
    )

    if (existing >= 0) {
        // Update existing fact
        store.facts[existing] = { ...store.facts[existing], ...fact, updatedAt: new Date().toISOString() }
    } else {
        store.facts.push({ ...fact, updatedAt: new Date().toISOString() })
    }

    // Keep max 100 facts
    if (store.facts.length > 100) {
        store.facts = store.facts
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 100)
    }

    saveCoreFacts()
}

export function removeFact(factText: string): boolean {
    const before = store.facts.length
    store.facts = store.facts.filter(f => !f.fact.toLowerCase().includes(factText.toLowerCase()))
    if (store.facts.length < before) {
        saveCoreFacts()
        return true
    }
    return false
}

export function removeFactByGovernanceId(governanceId: string): boolean {
    const before = store.facts.length
    store.facts = store.facts.filter(f => f.governanceId !== governanceId)
    if (store.facts.length === before) return false
    saveCoreFacts()
    return true
}

export function getAllFacts(): CoreFact[] {
    return [...store.facts]
}

// ============================================
// Auto-Extraction from Observer facts.json
// ============================================

export function extractFromObserver(): number {
    if (!existsSync(OBSERVER_FACTS_PATH)) return 0

    try {
        const raw = JSON.parse(readFileSync(OBSERVER_FACTS_PATH, 'utf-8'))
        let extracted = 0

        // facts.json is keyed by userId
        for (const [userId, facts] of Object.entries(raw)) {
            if (!Array.isArray(facts)) continue

            for (const fact of facts as any[]) {
                const content = fact.content || ''
                if (content.length < 10) continue

                // IP addresses
                const ipMatch = content.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/)
                if (ipMatch) {
                    addFact({
                        category: 'network',
                        fact: content.slice(0, 200),
                        source: 'auto_extracted',
                        confidence: fact.confidence || 0.6,
                        updatedAt: new Date().toISOString(),
                    })
                    extracted++
                    continue
                }

                // Device names
                if (/(?:pi|raspberry|jetson|beamer|projector|tv|server)/i.test(content)) {
                    addFact({
                        category: 'device',
                        fact: content.slice(0, 200),
                        source: 'auto_extracted',
                        confidence: fact.confidence || 0.6,
                        updatedAt: new Date().toISOString(),
                    })
                    extracted++
                    continue
                }

                // Identity facts
                if (/(?:heißt?|name|bin|ist)\s/i.test(content) && fact.type === 'identity') {
                    addFact({
                        category: 'identity',
                        fact: content.slice(0, 200),
                        source: 'auto_extracted',
                        confidence: fact.confidence || 0.7,
                        updatedAt: new Date().toISOString(),
                    })
                    extracted++
                }

                // Preferences
                if (fact.type === 'preference') {
                    addFact({
                        category: 'preference',
                        fact: content.slice(0, 200),
                        source: 'auto_extracted',
                        confidence: fact.confidence || 0.6,
                        updatedAt: new Date().toISOString(),
                    })
                    extracted++
                }
            }
        }

        store.lastExtraction = new Date().toISOString()
        saveCoreFacts()
        console.log(`[CoreFacts] Extracted ${extracted} facts from observer`)
        return extracted
    } catch (err) {
        console.log(`[CoreFacts] Observer extraction error: ${err}`)
        return 0
    }
}

// ============================================
// Build Context for LLM (Tier-0 Injection)
// ============================================

export function buildCoreFactsContext(): string {
    const now = Date.now()
    const governance = getMemoryGovernanceCoordinator()
    const activeFacts = store.facts.filter(fact => {
        if (fact.expiresAt && fact.expiresAt <= now) return false
        if (!fact.governanceId) return false
        return governance.get(fact.governanceId)?.status === 'canonical'
    })
    if (activeFacts.length === 0) return ''

    const grouped: Record<string, string[]> = {}
    for (const fact of activeFacts) {
        if (!grouped[fact.category]) grouped[fact.category] = []
        grouped[fact.category].push(fact.fact)
    }

    const categoryLabels: Record<string, string> = {
        identity: '👤 Identität',
        device: '🖥️ Geräte & Hardware',
        project: '📁 Projekte',
        preference: '⚙️ Präferenzen',
        pet: '🐾 Haustiere',
        network: '🌐 Netzwerk & IPs',
        credential: '🔑 Zugänge',
        other: '📌 Sonstiges',
    }

    const sections: string[] = []
    for (const [cat, facts] of Object.entries(grouped)) {
        const label = categoryLabels[cat] || cat
        sections.push(`${label}:\n${facts.map(f => `  - ${f}`).join('\n')}`)
    }

    return `## KERN-FAKTEN (NIEMALS VERGESSEN!)
Diese Fakten sind IMMER wahr. Nutze sie bevor du den User fragst!

${sections.join('\n\n')}`
}

// ============================================
// Init
// ============================================

export function initCoreFacts(): void {
    loadCoreFacts()

    // One-time adoption: legacy Tier-0 facts remain valid, but from now on
    // their lifecycle is controlled by the central governance catalog.
    let adopted = 0
    const governance = getMemoryGovernanceCoordinator()
    const ownerScope = legacyOwnerScope()
    for (const fact of store.facts) {
        if (fact.governanceId) {
            const governed = governance.get(fact.governanceId)
            if (governed?.scope === 'global' && governed.provenance.some(p => p.source.startsWith('legacy-core:'))
                && ownerScope !== 'global') governance.rescope(governed.id, ownerScope, 'legacy-core-owner-migration')
            continue
        }
        const kind = fact.category === 'identity' ? 'identity'
            : fact.category === 'preference' ? 'preference'
                : fact.category === 'project' ? 'project' : 'fact'
        const record = governance.adoptLegacy({
            content: fact.fact,
            kind,
            scope: ownerScope,
            source: `legacy-core:${fact.source}`,
            evidence: 'manual',
            confidence: fact.confidence,
            verified: true,
            timestamp: Date.parse(fact.updatedAt) || Date.now(),
        }, { coreFact: true })
        if (!record) continue
        fact.governanceId = record.id
        fact.governanceStatus = 'canonical'
        adopted++
    }
    if (adopted > 0) saveCoreFacts()

    // Observer writes through governance directly. Tier-0 must never scrape
    // observer JSON and silently promote user/model observations to global.
}
