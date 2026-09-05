/**
 * Capabilities Store - Nova's Learned Skills Memory
 * 
 * Nova remembers what she's successfully done before:
 * - "Ich kann Audio erstellen" (15x erfolgreich)
 * - "Ich kann Bilder analysieren" (8x erfolgreich)
 * 
 * This is INJECTED into every prompt so Nova never forgets!
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface Capability {
    id: string
    name: string                 // "Audio erstellen"
    description: string          // "Mit edge-tts Text in MP3 umwandeln"
    tools: string[]              // ["run_command", "write_file"]
    examples: string[]           // ["edge-tts --text 'Hallo'..."]
    successCount: number
    lastUsed: number
    firstLearned: number
    category: 'audio' | 'vision' | 'network' | 'filesystem' | 'coding' | 'system' | 'other'
}

// ============================================
// Storage
// ============================================

const CAPABILITIES_DIR = '.nova-learning'
const CAPABILITIES_FILE = 'capabilities.json'

function getCapabilitiesPath(): string {
    const dir = join(process.cwd(), CAPABILITIES_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, CAPABILITIES_FILE)
}

function loadCapabilities(): Capability[] {
    const path = getCapabilitiesPath()
    if (!existsSync(path)) return []
    try {
        return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
        return []
    }
}

function saveCapabilities(capabilities: Capability[]): void {
    writeFileSync(getCapabilitiesPath(), JSON.stringify(capabilities, null, 2))
}

/**
 * Record a successful capability usage
 * Called every time a tool succeeds!
 */
export async function recordCapability(
    toolName: string,
    description: string,
    category: Capability['category'] = 'other',
    example?: string
): Promise<void> {
    const capabilities = loadCapabilities()

    // Generate capability ID from description
    const id = description.toLowerCase()
        .replace(/[^a-z0-9äöüß]+/g, '-')
        .slice(0, 50)

    // Find existing or create new
    let cap = capabilities.find(c => c.id === id)

    if (cap) {
        cap.successCount++
        cap.lastUsed = Date.now()
        if (!cap.tools.includes(toolName)) {
            cap.tools.push(toolName)
        }
        if (example && !cap.examples.includes(example)) {
            cap.examples.push(example)
            // Keep only last 3 examples
            if (cap.examples.length > 3) cap.examples.shift()
        }
    } else {
        cap = {
            id,
            name: description,
            description,
            tools: [toolName],
            examples: example ? [example] : [],
            successCount: 1,
            lastUsed: Date.now(),
            firstLearned: Date.now(),
            category
        }
        capabilities.push(cap)
        console.log(`[Capabilities] 🎓 NEW SKILL LEARNED: ${description}`)
    }

    // Save locally
    saveCapabilities(capabilities)
    console.log(`[Capabilities] ✅ ${description} (${cap.successCount}x erfolgreich)`)

    // === SYNC TO LEARNING HUB ===
    // Share this capability with other Nova instances!
    try {
        const { shareKnowledge } = await import('../intelligence/learning-hub.js')
        await shareKnowledge(
            `capability:${category}:${id}`,
            [
                `Skill: ${description}`,
                `Tools: ${cap.tools.join(', ')}`,
                ...(cap.examples.length > 0 ? [`Example: ${cap.examples[0]}`] : [])
            ]
        )
        console.log(`[Capabilities→Hub] 🌐 Shared to Learning Hub`)
    } catch (hubErr) {
        // Learning Hub not available, that's OK - local storage still works
        console.log(`[Capabilities] Hub sync skipped: ${hubErr}`)
    }
}

/**
 * Get all learned capabilities
 */
export function getCapabilities(): Capability[] {
    return loadCapabilities()
}

/**
 * Get capabilities by category
 */
export function getCapabilitiesByCategory(category: Capability['category']): Capability[] {
    return loadCapabilities().filter(c => c.category === category)
}

/**
 * Get top N most used capabilities
 */
export function getTopCapabilities(n: number = 10): Capability[] {
    return loadCapabilities()
        .sort((a, b) => b.successCount - a.successCount)
        .slice(0, n)
}

/**
 * Find capability by keywords
 */
export function findCapability(keywords: string[]): Capability | null {
    const capabilities = loadCapabilities()
    const lower = keywords.map(k => k.toLowerCase())

    for (const cap of capabilities) {
        const text = `${cap.name} ${cap.description}`.toLowerCase()
        if (lower.every(kw => text.includes(kw))) {
            return cap
        }
    }
    return null
}

// ============================================
// PROMPT INJECTION - This is the key!
// ============================================

/**
 * Generate prompt section with Nova's known capabilities
 * This gets INJECTED into every system prompt!
 */
export function getCapabilitiesPrompt(): string {
    const capabilities = loadCapabilities()

    if (capabilities.length === 0) {
        return ''
    }

    // Group by category
    const byCategory: Record<string, Capability[]> = {}
    for (const cap of capabilities) {
        if (!byCategory[cap.category]) byCategory[cap.category] = []
        byCategory[cap.category].push(cap)
    }

    let prompt = `
## 🧠 DEINE GELERNTEN FÄHIGKEITEN
Du hast folgende Aktionen bereits erfolgreich ausgeführt - nutze dieses Wissen!

`

    const categoryLabels: Record<string, string> = {
        audio: '🔊 Audio',
        vision: '👁️ Vision',
        network: '🌐 Netzwerk',
        filesystem: '📁 Dateisystem',
        coding: '💻 Coding',
        system: '⚙️ System',
        other: '🔧 Sonstiges'
    }

    for (const [category, caps] of Object.entries(byCategory)) {
        const sorted = caps.sort((a, b) => b.successCount - a.successCount).slice(0, 5)
        prompt += `**${categoryLabels[category] || category}**:\n`

        for (const cap of sorted) {
            prompt += `- ${cap.name} (${cap.successCount}x ✅)`
            if (cap.examples.length > 0) {
                prompt += ` → z.B. \`${cap.examples[0].slice(0, 60)}...\``
            }
            prompt += '\n'
        }
        prompt += '\n'
    }

    prompt += `
⚠️ WICHTIG: Du KANNST diese Dinge! Sage nicht "ich kann keine Audio erstellen" wenn du es schon ${capabilities.filter(c => c.category === 'audio').length}x getan hast!
`

    return prompt + getUnavailablePrompt()
}

// ============================================
// Negativ-Gedaechtnis — was auf DIESER Maschine nicht geht
// ============================================
// Ohne das probiert Nova bei jeder Frage neu, ob ein Browser existiert,
// scheitert wieder und vergisst es wieder. Erfolge allein reichen nicht:
// erst das Wissen "hier fehlt X" macht aus einem Fehlversuch eine Lehre.

export interface UnavailableCapability {
    tool: string
    reason: string
    hint?: string          // Ersatzweg oder Nachruest-Befehl
    failCount: number
    firstFailed: number
    lastFailed: number
    resolved?: boolean     // nach erfolgreichem Nachruesten wieder frei
}

const UNAVAILABLE_FILE = 'unavailable.json'

function getUnavailablePath(): string {
    const dir = join(process.cwd(), CAPABILITIES_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, UNAVAILABLE_FILE)
}

export function loadUnavailable(): UnavailableCapability[] {
    const path = getUnavailablePath()
    if (!existsSync(path)) return []
    try {
        return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
        return []
    }
}

/** Merkt sich, dass ein Werkzeug auf dieser Maschine nicht funktioniert. */
export function recordUnavailable(tool: string, reason: string, hint?: string): void {
    try {
        const list = loadUnavailable()
        const now = Date.now()
        const found = list.find(u => u.tool === tool)
        if (found) {
            found.failCount++
            found.lastFailed = now
            found.reason = reason.slice(0, 300)
            if (hint) found.hint = hint
            found.resolved = false
        } else {
            list.push({
                tool,
                reason: reason.slice(0, 300),
                hint,
                failCount: 1,
                firstFailed: now,
                lastFailed: now,
            })
        }
        writeFileSync(getUnavailablePath(), JSON.stringify(list, null, 2))
    } catch { /* Lernen darf den Lauf nie zum Absturz bringen */ }
}

/** Nach erfolgreichem Nachruesten wieder freigeben. */
export function clearUnavailable(tool: string): void {
    try {
        const list = loadUnavailable()
        const found = list.find(u => u.tool === tool)
        if (!found) return
        found.resolved = true
        writeFileSync(getUnavailablePath(), JSON.stringify(list, null, 2))
    } catch { /* egal */ }
}

export function getUnavailablePrompt(): string {
    // Erst ab dem zweiten Fehlschlag als "geht hier nicht" melden — ein
    // einzelner Fehler kann ein Netzaussetzer oder ein Tippfehler sein.
    const list = loadUnavailable().filter(u => !u.resolved && u.failCount >= 2)
    if (list.length === 0) return ''

    let p = `
## 🚫 AUF DIESER MASCHINE NICHT VERFÜGBAR (selbst gelernt)
Das hast du hier schon erfolglos versucht — probiere es nicht blind erneut:

`
    for (const u of list.sort((a, b) => b.failCount - a.failCount).slice(0, 12)) {
        p += `- \`${u.tool}\` (${u.failCount}x fehlgeschlagen): ${u.reason}`
        if (u.hint) p += ` → ${u.hint}`
        p += '\n'
    }
    p += `
Du bist root: fehlt nur ein Paket, ruest es nach und trage die Faehigkeit danach
wieder als verfuegbar ein. Bleibt es unmoeglich, sag es klar und nenne den Ersatzweg.
`
    return p
}

// ============================================
// Auto-Detection Helpers
// ============================================

/**
 * Detect category from tool name and params
 */
export function detectCategory(
    toolName: string,
    params: Record<string, unknown>
): Capability['category'] {
    const command = String(params.command || params.cmd || '').toLowerCase()

    // Audio
    if (command.includes('tts') || command.includes('speech') ||
        command.includes('audio') || command.includes('mp3') ||
        command.includes('beep') || command.includes('speak')) {
        return 'audio'
    }

    // Vision
    if (toolName.includes('vision') || toolName.includes('image') ||
        command.includes('image') || command.includes('screenshot')) {
        return 'vision'
    }

    // Network
    if (command.includes('ping') || command.includes('arp') ||
        command.includes('nmap') || command.includes('curl') ||
        command.includes('ssh') || command.includes('scp') ||
        command.includes('network') || command.includes('ip ')) {
        return 'network'
    }

    // Filesystem
    if (toolName === 'write_file' || toolName === 'read_file' ||
        command.includes('copy') || command.includes('move') ||
        command.includes('delete') || command.includes('mkdir')) {
        return 'filesystem'
    }

    // Coding
    if (command.includes('npm') || command.includes('node') ||
        command.includes('python') || command.includes('git') ||
        command.includes('compile') || command.includes('build')) {
        return 'coding'
    }

    // System
    if (command.includes('systeminfo') || command.includes('process') ||
        command.includes('service') || command.includes('install')) {
        return 'system'
    }

    return 'other'
}

/**
 * Generate a human-readable description from tool execution
 */
export function generateDescription(
    toolName: string,
    params: Record<string, unknown>,
    success: boolean
): string {
    if (!success) return ''

    const command = String(params.command || params.cmd || '')

    // Audio descriptions
    if (command.includes('edge-tts') || command.includes('tts')) {
        return 'Text-to-Speech Audio erstellen'
    }
    if (command.includes('beep') || command.includes('SoundPlayer')) {
        return 'Audio abspielen'
    }

    // Network descriptions  
    if (command.includes('arp') || command.includes('nmap')) {
        return 'Netzwerk-Geräte scannen'
    }
    if (command.includes('ping') || command.includes('Test-Connection')) {
        return 'Host Erreichbarkeit prüfen'
    }
    if (command.includes('ssh')) {
        return 'SSH-Verbindung herstellen'
    }
    if (command.includes('scp') || command.includes('sftp')) {
        return 'Dateien per SSH übertragen'
    }

    // Filesystem descriptions
    if (toolName === 'write_file') {
        return 'Dateien erstellen/schreiben'
    }
    if (toolName === 'read_file') {
        return 'Dateien lesen'
    }

    // Generic
    if (command.length > 10) {
        return `Befehl ausführen: ${command.slice(0, 40)}...`
    }

    return `${toolName} erfolgreich ausgeführt`
}

// ============================================
// Boot Loader
// ============================================

let booted = false

export async function bootCapabilities(): Promise<void> {
    if (booted) return
    booted = true

    const capabilities = loadCapabilities()
    if (capabilities.length > 0) {
        console.log(`[Capabilities] 🧠 ${capabilities.length} lokale Fähigkeiten geladen:`)
        const top3 = capabilities.sort((a, b) => b.successCount - a.successCount).slice(0, 3)
        for (const cap of top3) {
            console.log(`  - ${cap.name} (${cap.successCount}x)`)
        }
    } else {
        console.log(`[Capabilities] 📭 Noch keine lokalen Fähigkeiten`)
    }

    // === FETCH FROM LEARNING HUB ===
    // Learn what other Nova instances know!
    try {
        const { fetchSharedKnowledge } = await import('../intelligence/learning-hub.js')
        const sharedKnowledge = await fetchSharedKnowledge()

        let imported = 0
        for (const [topic, facts] of sharedKnowledge.entries()) {
            // Only import capability topics
            if (!topic.startsWith('capability:')) continue

            // Parse topic: capability:category:id
            const [, category, capId] = topic.split(':')
            if (!capId) continue

            // Check if we already have this
            const existing = capabilities.find(c => c.id === capId)
            if (existing) continue

            // Extract skill name from facts
            const skillFact = facts.find(f => f.startsWith('Skill:'))
            if (!skillFact) continue

            const skillName = skillFact.replace('Skill:', '').trim()
            const toolsFact = facts.find(f => f.startsWith('Tools:'))
            const tools = toolsFact ? toolsFact.replace('Tools:', '').trim().split(',').map(t => t.trim()) : []
            const exampleFact = facts.find(f => f.startsWith('Example:'))
            const examples = exampleFact ? [exampleFact.replace('Example:', '').trim()] : []

            // Add to local store
            capabilities.push({
                id: capId,
                name: skillName,
                description: skillName,
                tools,
                examples,
                successCount: 1,
                lastUsed: Date.now(),
                firstLearned: Date.now(),
                category: (category as Capability['category']) || 'other'
            })
            imported++
        }

        if (imported > 0) {
            saveCapabilities(capabilities)
            console.log(`[Capabilities←Hub] 🌐 ${imported} Fähigkeiten von anderen Novas gelernt!`)
        }
    } catch (hubErr) {
        console.log(`[Capabilities] Hub fetch skipped: ${hubErr}`)
    }
}

// ============================================
// Export
// ============================================

export default {
    recordCapability,
    getCapabilities,
    getCapabilitiesByCategory,
    getTopCapabilities,
    findCapability,
    getCapabilitiesPrompt,
    detectCategory,
    generateDescription,
    bootCapabilities,
}
