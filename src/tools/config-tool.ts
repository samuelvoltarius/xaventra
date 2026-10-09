/**
 * Config Management Tool
 * 
 * Allows Nova to modify her own xaventra.config.json safely.
 * Supports updating any top-level config section (telegram, llm, memory, etc.)
 * 
 * Examples:
 * - "Aktiviere Telegram mit Token xyz" → save_config({section: "telegram", values: {enabled: true, token: "xyz"}})
 * - "Ändere das Model auf gpt-5.4" → save_config({section: "llm", values: {model: "gpt-5.4"}})
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolveConfigPath } from '../config/config-path.js'
import { atomicWriteFileSync } from '../core/atomic-storage.js'
import { approvalDetailOf, ownerApprovalRefusal } from './owner-approval.js'

/**
 * R2 T1: sections that decide who is owner, where LLM traffic and keys go, or
 * how Nova is reached. A tool call (model-authored, possibly injected) may not
 * change them without an explicit owner approval.
 */
const PROTECTED_SECTIONS = ['telegram', 'channels', 'providers', 'supabase', 'server', 'dashboard', 'apis']
const PROTECTED_KEY = /allow|url|endpoint|host|key|token|secret|password|auth|owner|admin/i

function touchesProtected(section: string, values: Record<string, unknown>): boolean {
    if (PROTECTED_SECTIONS.includes(section)) return true
    const visit = (value: unknown, depth: number): boolean => {
        if (!value || typeof value !== 'object' || depth > 8) return false
        return Object.entries(value as Record<string, unknown>).some(([key, inner]) => PROTECTED_KEY.test(key) || visit(inner, depth + 1))
    }
    return visit(values, 0)
}

/**
 * 2.89.4: pull key-like values out of a config write into the 0600 stores.
 * The config keeps only `«field»Ref`. Never logs the value.
 */
async function extractSecretsToStore(section: string, values: Record<string, unknown>): Promise<{
    cleanValues: Record<string, unknown>
    storedNotes: string[]
}> {
    const cleanValues: Record<string, unknown> = {}
    const storedNotes: string[] = []
    for (const [key, val] of Object.entries(values)) {
        const isSecretField = PROTECTED_KEY.test(key) && typeof val === 'string' && val.length >= 8
        if (!isSecretField) {
            cleanValues[key] = val
            continue
        }
        const id = `cfg-${section}-${key}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)
        const { registerSecretValue } = await import('../security/secret-redaction.js')
        registerSecretValue(val, id)
        try {
            const { speichereEintrag, dienstVon } = await import('../secrets/credential-broker.js')
            const dienst = dienstVon(section) || `${section}.local`
            const saved = speichereEintrag({ id, label: `${section}.${key}`, quelle: 'datei', dienste: [dienst], geheim: val })
            if (saved.ok) {
                cleanValues[`${key}Ref`] = `tresor:${id}`
                storedNotes.push(id)
                continue
            }
        } catch { /* fall through to auth store */ }
        try {
            const { getOAuthManager } = await import('../auth/oauth.js')
            ;(getOAuthManager() as any).setApiKey(id, section, val)
            cleanValues[`${key}Ref`] = `auth:${id}`
            storedNotes.push(id)
        } catch {
            // Last resort: still never write the clear value into the config.
            cleanValues[`${key}Ref`] = `ref:${id}`
            storedNotes.push(`${id} (Wert nicht ablegbar)`)
        }
    }
    return { cleanValues, storedNotes }
}


export const saveConfigTool = {
    name: 'save_config',
    description: 'Eigene Konfiguration ändern. Sektionen: telegram (token, allowFrom), channels (discord, whatsapp, signal), llm (model, provider), providers (openai/anthropic apiKey+enabled), memory (embedding), autonomy (enabled, intervalMinutes, selfThinkMaxPerHour, quietHours, triggers), proactive (enabled, morningBriefing), learning (enabled, autoLearnThreshold), voice (enabled, wakeWord, ttsVoice), server (port), heartbeat (intervalMinutes), apis (tavily_key), dashboard (port). Ändert xaventra.config.json sicher per Merge.',
    category: 'system' as const,
    parameters: [
        {
            name: 'section',
            type: 'string' as const,
            description: 'Config-Sektion: telegram, llm, memory, layers, supabase, boot, apis',
            required: true,
        },
        {
            name: 'values',
            type: 'object' as const,
            description: 'Die Werte die gesetzt werden sollen (werden gemergt, nicht ersetzt). Beispiel: {"enabled": true, "token": "abc123"}',
            required: true,
        },
        {
            name: 'confirm',
            type: 'string' as const,
            description: 'Nur für geschützte Sektionen (telegram, channels, providers, supabase, server, dashboard, apis, Schlüssel/URLs): Einmal-Freigabecode, den der Owner selbst nennt. Niemals selbst bilden.',
            required: false,
        },
    ],
    handler: async (params: Record<string, unknown>) => {
        const section = params?.section
        const values = params?.values

        if (typeof section !== 'string' || !section.trim()) {
            return {
                success: false,
                error: 'Section muss angegeben werden (z.B. "telegram", "llm", "memory")',
            }
        }

        if (!values || typeof values !== 'object' || Array.isArray(values)) {
            return {
                success: false,
                error: 'Values muss ein Objekt sein (z.B. {"enabled": true})',
            }
        }

        // Allowed sections (safety: prevent writing arbitrary keys)
        const allowedSections = [
            // Channels & Communication
            'telegram', 'channels', 'dashboard',
            // AI & Models
            'llm', 'providers', 'memory',
            // Behaviour
            'autonomy', 'proactive', 'learning', 'resilience',
            // System
            'voice', 'server', 'heartbeat', 'apis', 'supabase',
            // Tuning
            'layers', 'boot',
        ]

        const sectionKey = section.toLowerCase().trim()
        if (!allowedSections.includes(sectionKey)) {
            return {
                success: false,
                error: `Unbekannte Sektion: ${section}`,
                allowed: allowedSections,
            }
        }

        if (touchesProtected(sectionKey, values as Record<string, unknown>)) {
            const refusal = await ownerApprovalRefusal(params, 'save_config', approvalDetailOf({ section: sectionKey, values }))
            if (refusal) {
                return {
                    success: false,
                    error: `Sektion "${sectionKey}" bzw. Zugangs-/Adressfelder sind geschützt (Owner, Kanäle, Provider, Schlüssel). ${refusal}`,
                }
            }
        }

        try {
            // Read current config
            const configPath = resolveConfigPath()

            let config: Record<string, any> = {}
            if (existsSync(configPath)) {
                const raw = readFileSync(configPath, 'utf-8')
                config = JSON.parse(raw)
            }

            // 2.89.4: keys/tokens never land in clear in xaventra.config.json.
            // They go to the existing 0600 stores (Tresor / auth); the config
            // only keeps a reference. The model never sees the value again.
            const { cleanValues, storedNotes } = await extractSecretsToStore(sectionKey, values as Record<string, unknown>)

            // Merge values into section
            if (!config[sectionKey] || typeof config[sectionKey] !== 'object') {
                config[sectionKey] = {}
            }

            // Deep merge one level
            for (const [key, val] of Object.entries(cleanValues)) {
                config[sectionKey][key] = val
            }

            // Write back atomically: an aborted write must not leave a broken config
            atomicWriteFileSync(configPath, JSON.stringify(config, null, 4))

            console.log(`[save_config] ✅ ${sectionKey} updated:`, Object.keys(cleanValues).join(', '))

            return {
                success: true,
                message: `✅ Config "${sectionKey}" aktualisiert!${storedNotes.length ? ` Schlüssel im verschlüsselten Speicher (${storedNotes.join(', ')}); Config trägt nur die Referenz.` : ''}`,
                section: sectionKey,
                updatedKeys: Object.keys(cleanValues),
                hint: 'Neustart nötig damit Änderungen wirken.',
            }

        } catch (err: any) {
            return {
                success: false,
                error: `Config konnte nicht gespeichert werden: ${err.message}`,
            }
        }
    },
}

export default { saveConfigTool }
