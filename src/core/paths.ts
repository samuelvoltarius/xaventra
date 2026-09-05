/**
 * Nova — Centralized Path Management
 *
 * Single Source of Truth for ALL file system paths Nova uses.
 * Every module that reads/writes files MUST import paths from here.
 *
 * Auto-creates directories on first access via ensureDirectories().
 *
 * Directory layout:
 *   .nova-data/
 *   ├── auth.json               # OAuth tokens
 *   ├── users/                  # User profiles & context
 *   │   ├── _index.json         # userId → displayName mapping
 *   │   └── {userId}/
 *   │       ├── profile.json    # Preferences, language, timezone
 *   │       ├── history.json    # Interaction history (last N)
 *   │       └── context.md      # Long-term context (what Nova knows)
 *   ├── inbox/                  # Received files (by channel)
 *   │   ├── telegram/
 *   │   ├── whatsapp/
 *   │   ├── web/
 *   │   └── mesh/
 *   ├── workspace/              # Temporary work files
 *   │   ├── current/
 *   │   └── archive/
 *   ├── knowledge/              # RAG knowledge base
 *   ├── memory/                 # Persistent memory
 *   ├── media/                  # Generated media (images etc.)
 *   ├── sessions/               # Chat sessions
 *   ├── journal/                # Daily journal entries
 *   └── scripts/                # Self-generated scripts
 */

import { join } from 'node:path'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Base Directory
// ============================================

/** Nova data root — relative to CWD (where nova-core runs) */
export const NOVA_DATA_DIR = join(process.cwd(), '.nova-data')

// ============================================
// Top-Level Files
// ============================================

export const AUTH_FILE = join(NOVA_DATA_DIR, 'auth.json')
export const CONFIG_FILE = resolveConfigPath()
export const INSTANCE_ID_FILE = join(NOVA_DATA_DIR, 'instance-id.txt')

// ============================================
// Users
// ============================================

export const USERS_DIR = join(NOVA_DATA_DIR, 'users')
export const USERS_INDEX = join(USERS_DIR, '_index.json')

export const getUserDir = (userId: string): string => join(USERS_DIR, userId)
export const getUserProfile = (userId: string): string => join(USERS_DIR, userId, 'profile.json')
export const getUserHistory = (userId: string): string => join(USERS_DIR, userId, 'history.json')
export const getUserContext = (userId: string): string => join(USERS_DIR, userId, 'context.md')

// ============================================
// Inbox (received files by channel)
// ============================================

export const INBOX_DIR = join(NOVA_DATA_DIR, 'inbox')
export const INBOX_TELEGRAM = join(INBOX_DIR, 'telegram')
export const INBOX_WHATSAPP = join(INBOX_DIR, 'whatsapp')
export const INBOX_WEB = join(INBOX_DIR, 'web')
export const INBOX_MESH = join(INBOX_DIR, 'mesh')

/** Get inbox path for a specific channel */
export const getInboxDir = (channel: string): string => join(INBOX_DIR, channel)

/** Generate a unique filename for an inbox file */
export const getInboxFilePath = (channel: string, originalName: string): string => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_')
    return join(INBOX_DIR, channel, `${timestamp}_${safeName}`)
}

// ============================================
// Workspace (temporary work files)
// ============================================

export const WORKSPACE_DIR = join(NOVA_DATA_DIR, 'workspace')
export const WORKSPACE_CURRENT = join(WORKSPACE_DIR, 'current')
export const WORKSPACE_ARCHIVE = join(WORKSPACE_DIR, 'archive')

// ============================================
// Knowledge & Memory
// ============================================

export const KNOWLEDGE_DIR = join(NOVA_DATA_DIR, 'knowledge')
export const MEMORY_DIR = join(NOVA_DATA_DIR, 'memory')
export const MEMORIES_DIR = join(NOVA_DATA_DIR, 'memories')
export const LANCEDB_DIR = join(NOVA_DATA_DIR, 'lancedb')

// ============================================
// Media & Downloads
// ============================================

export const MEDIA_DIR = join(NOVA_DATA_DIR, 'media')
export const DOWNLOADS_DIR = join(NOVA_DATA_DIR, 'downloads')
export const IMAGES_DIR = join(NOVA_DATA_DIR, 'images')

// ============================================
// Sessions & History
// ============================================

export const SESSIONS_DIR = join(NOVA_DATA_DIR, 'sessions')
export const JOURNAL_DIR = join(NOVA_DATA_DIR, 'journal')
export const SUMMARIES_DIR = join(NOVA_DATA_DIR, 'summaries')
export const OBSERVER_DIR = join(NOVA_DATA_DIR, 'observer')

// ============================================
// Scripts & Tools
// ============================================

export const SCRIPTS_DIR = join(NOVA_DATA_DIR, 'scripts')

// ============================================
// State Files
// ============================================

export const CORE_FACTS_FILE = join(NOVA_DATA_DIR, 'CORE_FACTS.json')
export const MEMORY_FILE = join(NOVA_DATA_DIR, 'MEMORY.md')
export const USER_FILE = join(NOVA_DATA_DIR, 'USER.md')
export const SOUL_FILE = join(NOVA_DATA_DIR, 'soul.md')
export const SELF_ARCH_FILE = join(NOVA_DATA_DIR, 'self-architecture.md')
export const PERSONA_STATE_FILE = join(NOVA_DATA_DIR, 'persona-state.json')
export const MESH_FILE = join(NOVA_DATA_DIR, 'mesh.json')
export const HOSTS_FILE = join(NOVA_DATA_DIR, 'hosts.json')
export const MODEL_CACHE_FILE = join(NOVA_DATA_DIR, 'model-cache.json')
export const DISCOVERED_MODELS_FILE = join(NOVA_DATA_DIR, 'discovered-models.json')

// ============================================
// Directory Initialization
// ============================================

const REQUIRED_DIRS = [
    NOVA_DATA_DIR,
    USERS_DIR,
    INBOX_DIR,
    INBOX_TELEGRAM,
    INBOX_WHATSAPP,
    INBOX_WEB,
    INBOX_MESH,
    WORKSPACE_DIR,
    WORKSPACE_CURRENT,
    WORKSPACE_ARCHIVE,
    KNOWLEDGE_DIR,
    MEMORY_DIR,
    MEMORIES_DIR,
    MEDIA_DIR,
    DOWNLOADS_DIR,
    IMAGES_DIR,
    SESSIONS_DIR,
    JOURNAL_DIR,
    SUMMARIES_DIR,
    OBSERVER_DIR,
    SCRIPTS_DIR,
]

let _initialized = false

/**
 * Ensure all required directories exist.
 * Safe to call multiple times — only runs once.
 */
export const ensureDirectories = (): void => {
    if (_initialized) return
    for (const dir of REQUIRED_DIRS) {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }
    }

    // Create users index if it doesn't exist
    if (!existsSync(USERS_INDEX)) {
        writeFileSync(USERS_INDEX, JSON.stringify({
            version: 1,
            users: {},
            // Maps userId → { displayName, channel, firstSeen, lastSeen }
        }, null, 2))
    }

    _initialized = true
}

/**
 * Ensure a specific user directory exists.
 * Creates profile.json, history.json, context.md templates.
 */
export const ensureUserDir = (userId: string, displayName?: string): string => {
    const dir = getUserDir(userId)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })

        // Create profile template
        writeFileSync(getUserProfile(userId), JSON.stringify({
            userId,
            displayName: displayName || userId,
            language: 'de',
            timezone: 'Europe/Vienna',
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            preferences: {},
        }, null, 2))

        // Create empty history
        writeFileSync(getUserHistory(userId), JSON.stringify({
            interactions: [],
            totalMessages: 0,
        }, null, 2))

        // Create context template
        writeFileSync(getUserContext(userId), `# ${displayName || userId}\n\n_Noch keine Informationen gesammelt._\n`)
    }

    return dir
}

/**
 * Get a summary of all paths for system prompts.
 * Nova can use this to know where to find/store things.
 */
export const getPathsSummary = (): string => {
    return `## Nova Dateisystem-Pfade
- Daten-Root: ${NOVA_DATA_DIR}
- User-Profile: ${USERS_DIR}/{userId}/profile.json
- User-Kontext: ${USERS_DIR}/{userId}/context.md
- Empfangene Dateien: ${INBOX_DIR}/{channel}/{datei}
- Arbeitsverzeichnis: ${WORKSPACE_CURRENT}
- Wissen: ${KNOWLEDGE_DIR}
- Erinnerungen: ${MEMORY_DIR}
- Medien: ${MEDIA_DIR}
- Downloads: ${DOWNLOADS_DIR}
- Sessions: ${SESSIONS_DIR}
- Journal: ${JOURNAL_DIR}
- Skripte: ${SCRIPTS_DIR}`
}
