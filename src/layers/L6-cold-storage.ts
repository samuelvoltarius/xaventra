/**
 * L6 Cold Storage — Tier 3 Memory
 * 
 * Manages persistent USER.md and MEMORY.md files that Nova
 * reads on every request and can update when learning new facts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data')

// ============================================
// File Paths
// ============================================

export const USER_MD_PATH = join(DATA_DIR, 'USER.md')
export const MEMORY_MD_PATH = join(DATA_DIR, 'MEMORY.md')

// ============================================
// Templates
// ============================================

const USER_TEMPLATE = `# User-Profil

> Nova aktualisiert diese Datei automatisch wenn sie neue Fakten über den User lernt.

## Identität
- **Name:** (unbekannt)
- **Rolle:** (unbekannt)

## Geräte & Netzwerk
<!-- Hier speichert Nova bekannte Geräte, IPs, SSH-Zugänge -->

## Präferenzen
- **Sprache:** Deutsch
- **Ton:** Direkt, technisch

## Projekte
<!-- Aktive Projekte des Users -->

## Notizen
<!-- Sonstige wichtige Infos -->
`

const MEMORY_TEMPLATE = `# Nova Langzeit-Gedächtnis

> Wichtige Entscheidungen, gelöste Probleme, Kontextinfos.
> Nova aktualisiert diese Datei automatisch.

## Gelöste Probleme
<!-- Probleme und deren Lösungen -->

## Wichtige Entscheidungen
<!-- Architektur-Entscheidungen, Konfigurationsänderungen -->

## Gelernte Lektionen
<!-- Was Nova aus Fehlern gelernt hat -->
`

// ============================================
// Read/Write
// ============================================

export function ensureColdStorage(): void {
    if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true })
    }
    if (!existsSync(USER_MD_PATH)) {
        writeFileSync(USER_MD_PATH, USER_TEMPLATE)
        console.log('[L6 ColdStorage] Created USER.md template')
    }
    if (!existsSync(MEMORY_MD_PATH)) {
        writeFileSync(MEMORY_MD_PATH, MEMORY_TEMPLATE)
        console.log('[L6 ColdStorage] Created MEMORY.md template')
    }
}

export function readUserMd(): string {
    try {
        ensureColdStorage()
        return readFileSync(USER_MD_PATH, 'utf-8')
    } catch {
        return ''
    }
}

export function readMemoryMd(): string {
    try {
        ensureColdStorage()
        return readFileSync(MEMORY_MD_PATH, 'utf-8')
    } catch {
        return ''
    }
}

export function writeUserMd(content: string): void {
    try {
        ensureColdStorage()
        writeFileSync(USER_MD_PATH, content)
        console.log(`[L6 ColdStorage] USER.md updated (${content.length} chars)`)
    } catch (err) {
        console.log(`[L6 ColdStorage] USER.md write error: ${err}`)
    }
}

export function writeMemoryMd(content: string): void {
    try {
        ensureColdStorage()
        writeFileSync(MEMORY_MD_PATH, content)
        console.log(`[L6 ColdStorage] MEMORY.md updated (${content.length} chars)`)
    } catch (err) {
        console.log(`[L6 ColdStorage] MEMORY.md write error: ${err}`)
    }
}

/**
 * Append a section to MEMORY.md without overwriting existing content.
 */
export function appendToMemory(section: string, entry: string): void {
    try {
        let content = readMemoryMd()
        const sectionHeader = `## ${section}`
        const idx = content.indexOf(sectionHeader)
        if (idx !== -1) {
            // Find the end of the section header line
            const headerEnd = content.indexOf('\n', idx) + 1
            const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
            const newEntry = `- [${timestamp}] ${entry}\n`
            content = content.slice(0, headerEnd) + newEntry + content.slice(headerEnd)
        } else {
            // Section doesn't exist, add it
            content += `\n${sectionHeader}\n- ${entry}\n`
        }
        writeMemoryMd(content)
    } catch (err) {
        console.log(`[L6 ColdStorage] Append error: ${err}`)
    }
}

// ============================================
// Build Cold Storage context for LLM
// ============================================

export function buildColdStorageContext(): string {
    const userMd = readUserMd()
    const memoryMd = readMemoryMd()

    const parts: string[] = []

    // Filesystem Map — Nova must know where her files are
    const cwd = process.cwd()
    parts.push(`## 📂 DATEISYSTEM-MAP
Mein Arbeitsverzeichnis (CWD): \`${cwd}\`
Meine Daten liegen in: \`${cwd}/.nova-data/\`

| Datei | Pfad | Tool |
|-------|------|------|
| User-Profil | \`.nova-data/USER.md\` | \`update_user_profile\` |
| Langzeit-Memory | \`.nova-data/MEMORY.md\` | \`update_memory\` |
| Heartbeat | \`.nova-data/heartbeat.md\` | (automatisch) |
| Journal | \`.nova-data/memories/journal/YYYY-MM-DD.md\` | (automatisch) |
| Knowledge | \`.nova-data/knowledge/\` | \`knowledge_store\` |
| LanceDB Vektoren | \`.nova-data/lancedb/\` | \`remember\` / \`recall\` |
| Custom Tools | \`.nova-tools/\` | \`create_tool\` |
| Missions | \`.nova-data/missions.json\` | \`start_mission\` |
| Config | \`nova.config.json\` | (manuell) |

**WICHTIG:** Wenn ich sage "ich finde MEMORY.md nicht" — sie liegt IMMER unter \`.nova-data/MEMORY.md\`!`)

    if (userMd && userMd.trim().length > 50) {
        parts.push(`<user_profile>\n${userMd}\n</user_profile>`)
    }

    if (memoryMd && memoryMd.trim().length > 50) {
        parts.push(`<long_term_memory>\n${memoryMd}\n</long_term_memory>`)
    }

    return `## LANGZEIT-GEDÄCHTNIS (Cold Storage)
Diese Dateien enthalten alles was du dir dauerhaft gemerkt hast. Nutze diese Infos IMMER bevor du den User fragst!
Wenn du neue wichtige Fakten lernst, aktualisiere diese Dateien mit den Tools update_user_profile und update_memory.

${parts.join('\n\n')}`
}
