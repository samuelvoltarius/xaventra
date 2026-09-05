/**
 * Nova - Identity & Persona System
 * 
 * Manages Nova's personality, identity, and context injection.
 * Allows customization of how Nova presents herself.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// ============================================
// Types
// ============================================

export interface NovaPersona {
    // Core Identity
    name: string
    emoji: string
    version: string

    // Personality Traits
    personality: {
        traits: string[]           // e.g., ['freundlich', 'präzise', 'hilfsbereit']
        tone: 'formal' | 'casual' | 'professional' | 'playful'
        language: 'de' | 'en' | 'auto'
    }

    // Owner/Creator Info
    owner: {
        name?: string
        title?: string
        company?: string
    }

    // Capabilities & Restrictions
    capabilities: {
        canBrowse: boolean
        canExecuteCode: boolean
        canControlDesktop: boolean
        canAccessFiles: boolean
    }

    // Custom System Prompt Additions
    systemPromptAdditions: string[]

    // Memory Settings
    memory: {
        enabled: boolean
        maxContextTokens: number
        rememberConversations: boolean
        semanticSearch: boolean
    }
}

export interface PersonaConfig {
    path?: string
    autoLoad?: boolean
}

// ============================================
// Default Persona
// ============================================

const DEFAULT_PERSONA: NovaPersona = {
    name: 'Nova',
    emoji: '✨',
    version: '1.0.0',

    personality: {
        traits: ['freundlich', 'hilfsbereit', 'präzise', 'professionell'],
        tone: 'professional',
        language: 'de',
    },

    owner: {
        name: undefined,
        title: undefined,
        company: undefined,
    },

    capabilities: {
        canBrowse: true,
        canExecuteCode: true,   // ENABLED - Nova soll Tools nutzen!
        canControlDesktop: true,
        canAccessFiles: true,
    },

    systemPromptAdditions: [
        'WICHTIG: Wenn du etwas tun KANNST (Datei lesen, Befehl ausführen, im Internet suchen), dann TU ES SOFORT mit deinen Tools! Erkläre NICHT wie man es macht - MACH es einfach!',
        'Du hast Tools wie run_command, read_file, write_file, web_search, google_search. Nutze sie IMMER wenn der User eine Aktion will.',
        'Beispiel: "Scanne mein Netzwerk" → nutze run_command mit "arp -a", nicht erklären wie der User es selbst macht.',
    ],

    memory: {
        enabled: true,
        maxContextTokens: 100000,
        rememberConversations: true,
        semanticSearch: true,
    },
}

// ============================================
// Persona Loader
// ============================================

export class PersonaLoader {
    private config: Required<PersonaConfig>
    private persona: NovaPersona | null = null

    constructor(config: PersonaConfig = {}) {
        this.config = {
            path: config.path ?? '.nova/persona.json',
            autoLoad: config.autoLoad ?? true,
        }

        if (this.config.autoLoad) {
            this.load()
        }
    }

    // ============================================
    // Load & Save
    // ============================================

    load(): NovaPersona {
        if (existsSync(this.config.path)) {
            try {
                const data = readFileSync(this.config.path, 'utf-8')
                const loaded = JSON.parse(data) as Partial<NovaPersona>
                this.persona = { ...DEFAULT_PERSONA, ...loaded }
            } catch (err) {
                console.warn('[Persona] Failed to load persona, using default:', err)
                this.persona = { ...DEFAULT_PERSONA }
            }
        } else {
            this.persona = { ...DEFAULT_PERSONA }
        }

        return this.persona
    }

    save(): void {
        if (!this.persona) return

        const dir = dirname(this.config.path)
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
        }

        writeFileSync(this.config.path, JSON.stringify(this.persona, null, 2))
        console.log('[Persona] Saved to', this.config.path)
    }

    // ============================================
    // Getters & Setters
    // ============================================

    get(): NovaPersona {
        if (!this.persona) {
            return this.load()
        }
        return this.persona
    }

    update(updates: Partial<NovaPersona>): NovaPersona {
        this.persona = { ...this.get(), ...updates }
        return this.persona
    }

    setOwner(owner: NovaPersona['owner']): void {
        this.update({ owner })
    }

    setTraits(traits: string[]): void {
        const p = this.get()
        this.update({ personality: { ...p.personality, traits } })
    }

    // ============================================
    // System Prompt Generation
    // ============================================

    buildSystemPrompt(): string {
        const p = this.get()

        const parts: string[] = []

        // Core Identity
        parts.push(`Du bist ${p.name}, ein ${p.personality.traits.join(', ')} KI-Assistent.`)

        // Owner Info
        if (p.owner.name) {
            parts.push(`Du wurdest von ${p.owner.name}${p.owner.title ? ` (${p.owner.title})` : ''}${p.owner.company ? ` bei ${p.owner.company}` : ''} konfiguriert.`)
        }

        // Tone
        switch (p.personality.tone) {
            case 'formal':
                parts.push('Kommuniziere stets höflich und formal.')
                break
            case 'casual':
                parts.push('Kommuniziere locker und entspannt.')
                break
            case 'professional':
                parts.push('Kommuniziere professionell aber zugänglich.')
                break
            case 'playful':
                parts.push('Sei freundlich und bringe gelegentlich Humor ein.')
                break
        }

        // Capabilities
        const caps: string[] = []
        if (p.capabilities.canBrowse) caps.push('im Internet suchen')
        if (p.capabilities.canExecuteCode) caps.push('Code ausführen')
        if (p.capabilities.canControlDesktop) caps.push('den Desktop steuern')
        if (p.capabilities.canAccessFiles) caps.push('auf Dateien zugreifen')

        if (caps.length > 0) {
            parts.push(`Du kannst: ${caps.join(', ')}.`)
        }

        // Language
        if (p.personality.language === 'de') {
            parts.push('Antworte auf Deutsch, außer der Nutzer spricht dich in einer anderen Sprache an.')
        } else if (p.personality.language === 'en') {
            parts.push('Respond in English unless the user speaks another language.')
        }

        // Custom additions
        if (p.systemPromptAdditions.length > 0) {
            parts.push(...p.systemPromptAdditions)
        }

        return parts.join(' ')
    }

    // ============================================
    // Quick Info
    // ============================================

    getIdentityString(): string {
        const p = this.get()
        return `${p.emoji} ${p.name} v${p.version}`
    }

    getTraitsString(): string {
        return this.get().personality.traits.join(', ')
    }
}

// ============================================
// Singleton
// ============================================

let personaInstance: PersonaLoader | null = null

export function getPersonaLoader(config?: PersonaConfig): PersonaLoader {
    if (!personaInstance) {
        personaInstance = new PersonaLoader(config)
    }
    return personaInstance
}

// ============================================
// Quick Helpers
// ============================================

export function getNovaSystemPrompt(): string {
    return getPersonaLoader().buildSystemPrompt()
}

export function getNovaIdentity(): string {
    return getPersonaLoader().getIdentityString()
}

export default {
    PersonaLoader,
    getPersonaLoader,
    getNovaSystemPrompt,
    getNovaIdentity,
    DEFAULT_PERSONA,
}
