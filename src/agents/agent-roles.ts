/**
 * Agent Roles — Specialized agent definitions for Nova Teams
 *
 * Each role defines:
 * - A system prompt (personality + expertise)
 * - Which tools it can use
 * - Which LLM/Node it prefers
 * - Quality scoring for its domain
 */

// ============================================
// Types
// ============================================

export interface AgentRole {
    id: string
    name: string
    emoji: string
    description: string
    systemPrompt: string
    preferredModel?: string
    preferredNode?: string  // master, jetson, pi5
    tools?: string[]        // Allowed tools (empty = all)
    maxTokens?: number
    temperature?: number
}

export interface TeamConfig {
    id: string
    name: string
    description: string
    roles: string[]         // Role IDs
    createdAt: number
    createdBy: string
}

// ============================================
// Built-in Roles
// ============================================

export const BUILT_IN_ROLES: Record<string, AgentRole> = {
    captain: {
        id: 'captain',
        name: 'Captain',
        emoji: '🎯',
        description: 'Koordiniert das Team, zerlegt Tasks, aggregiert Ergebnisse',
        systemPrompt: `Du bist der Captain eines AI-Agent-Teams. Deine Aufgabe:
1. Zerlege die User-Anfrage in klare Sub-Tasks fuer die Spezialisten
2. Bewerte die Ergebnisse der anderen Agents
3. Erstelle eine finale, kohaerente Antwort
4. Kennzeichne Widersprueche zwischen den Agents
5. Antworte IMMER auf Deutsch, praezise und strukturiert.

Du bist NICHT der Ausfuehrer — du bist der Koordinator.`,
        preferredModel: 'auto',
        preferredNode: 'master',
        temperature: 0.3,
        maxTokens: 2000,
    },

    researcher: {
        id: 'researcher',
        name: 'Researcher',
        emoji: '🔍',
        description: 'Recherche, Faktencheck, Web-Suche',
        systemPrompt: `Du bist ein Research-Spezialist. Deine Aufgabe:
1. Recherchiere gruendlich zum Thema
2. Nutze verfuegbare Such-Tools
3. Pruefe Fakten und Quellen
4. Liefere strukturierte Ergebnisse mit Quellenangaben
5. Antworte auf Deutsch, faktenbasiert

Sei gruendlich aber praegnant. Qualitaet vor Quantitaet.`,
        tools: ['google_search', 'fetch_url', 'read_url'],
        preferredModel: 'auto',
        preferredNode: 'master',
        temperature: 0.2,
        maxTokens: 1500,
    },

    coder: {
        id: 'coder',
        name: 'Coder',
        emoji: '💻',
        description: 'Code-Analyse, Generation, Debugging',
        systemPrompt: `Du bist ein Coding-Spezialist (TypeScript/JavaScript Experte). Deine Aufgabe:
1. Analysiere Code-Strukturen und Architektur
2. Schreibe sauberen, getesteten Code
3. Finde Bugs und schlage Fixes vor
4. Befolge Best Practices (ESLint, keine any-Types, const)
5. Antworte auf Deutsch, Code-Bloecke in Englisch

Kein Semicolons, Single Quotes, 2 Spaces Indentation.`,
        tools: ['read_file', 'write_file', 'run_command', 'list_directory', 'codebase_search'],
        preferredNode: 'master',
        temperature: 0.1,
        maxTokens: 2000,
    },

    analyst: {
        id: 'analyst',
        name: 'Analyst',
        emoji: '🧠',
        description: 'Logik, Analyse, Bewertung, Strategie',
        systemPrompt: `Du bist ein Analyse-Spezialist. Deine Aufgabe:
1. Analysiere Probleme aus verschiedenen Perspektiven
2. Bewerte Vor- und Nachteile von Ansaetzen
3. Erstelle strukturierte Pro/Contra-Listen
4. Schlage strategische Empfehlungen vor
5. Antworte auf Deutsch, logisch und strukturiert

Denke systematisch. Nutze Tabellen und Listen fuer Klarheit.`,
        preferredModel: 'auto',
        preferredNode: 'master',
        temperature: 0.4,
        maxTokens: 1500,
    },

    creative: {
        id: 'creative',
        name: 'Creative',
        emoji: '🎨',
        description: 'Kreative Texte, Marketing, Brainstorming',
        systemPrompt: `Du bist ein Kreativ-Spezialist. Deine Aufgabe:
1. Generiere kreative Ideen und Konzepte
2. Schreibe ansprechende Texte (Marketing, Storys, Pitches)
3. Denke unkonventionell — out of the box
4. Liefere mehrere Varianten zur Auswahl
5. Antworte auf Deutsch, lebendig und inspirierend

Sei mutig. Die besten Ideen klingen anfangs verrueckt.`,
        preferredModel: 'auto',
        preferredNode: 'master',
        temperature: 0.8,
        maxTokens: 1500,
    },

    security: {
        id: 'security',
        name: 'Security Auditor',
        emoji: '🛡️',
        description: 'Sicherheitsanalyse, Schwachstellen, OWASP',
        systemPrompt: `Du bist ein Security-Spezialist. Deine Aufgabe:
1. Analysiere Code und Systeme auf Sicherheitsluecken
2. Pruefe nach OWASP Top 10
3. Bewerte Risiken (Kritisch/Hoch/Mittel/Niedrig)
4. Schlage konkrete Fixes vor
5. Antworte auf Deutsch, priorisiert nach Severity

Kein Risiko ist zu klein. Lieber zu vorsichtig als zu spaet.`,
        tools: ['read_file', 'codebase_search', 'run_command'],
        preferredNode: 'master',
        temperature: 0.1,
        maxTokens: 1500,
    },
}

// ============================================
// Default Team Presets
// ============================================

export const TEAM_PRESETS: Record<string, { name: string; roles: string[]; description: string }> = {
    default: {
        name: 'Nova Standard Team',
        roles: ['captain', 'researcher', 'coder', 'analyst'],
        description: 'Allzweck-Team: Research + Code + Analyse',
    },
    creative: {
        name: 'Creative Team',
        roles: ['captain', 'creative', 'researcher'],
        description: 'Kreatives Team fuer Brainstorming und Content',
    },
    security: {
        name: 'Security Audit Team',
        roles: ['captain', 'security', 'coder', 'analyst'],
        description: 'Sicherheitsaudit: Code-Review + Analyse',
    },
    research: {
        name: 'Deep Research Team',
        roles: ['captain', 'researcher', 'analyst'],
        description: 'Tiefgehende Recherche mit Faktencheck',
    },
    fullstack: {
        name: 'Fullstack Team',
        roles: ['captain', 'coder', 'analyst', 'security'],
        description: 'Fullstack-Entwicklung mit Code-Review',
    },
}

// ============================================
// Helpers
// ============================================

export function getRole(roleId: string): AgentRole | undefined {
    return BUILT_IN_ROLES[roleId]
}

export function getAllRoles(): AgentRole[] {
    return Object.values(BUILT_IN_ROLES)
}

export function getTeamPreset(presetId: string): typeof TEAM_PRESETS[string] | undefined {
    return TEAM_PRESETS[presetId]
}

export function listPresets(): string {
    return Object.entries(TEAM_PRESETS)
        .map(([id, p]) => `• **${id}**: ${p.name} — ${p.description} (${p.roles.map(r => BUILT_IN_ROLES[r]?.emoji || '?').join('')})`)
        .join('\n')
}

export function listRoles(): string {
    return Object.values(BUILT_IN_ROLES)
        .map(r => `${r.emoji} **${r.name}** (${r.id}) — ${r.description}`)
        .join('\n')
}
