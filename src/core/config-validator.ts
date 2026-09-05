/**
 * Config Validator
 * 
 * Validates nova.config.json on startup.
 * Fails fast with clear error messages for critical issues,
 * warns for non-critical missing fields.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ValidationResult {
    valid: boolean
    errors: string[]
    warnings: string[]
}

export function validateConfig(configPath?: string): ValidationResult {
    const result: ValidationResult = { valid: true, errors: [], warnings: [] }
    const path = configPath || join(process.cwd(), 'nova.config.json')

    // Check file exists
    if (!existsSync(path)) {
        result.valid = false
        result.errors.push('nova.config.json nicht gefunden!')
        return result
    }

    // Check valid JSON
    let config: any
    try {
        config = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (err: any) {
        result.valid = false
        result.errors.push(`nova.config.json ist kein valides JSON: ${err.message}`)
        return result
    }

    // Required fields
    if (!config.name) result.warnings.push('name fehlt — Standard "Nova" wird verwendet')
    if (!config.provider) {
        result.errors.push('provider fehlt (z.B. "openai", "openai")')
        result.valid = false
    }

    // Channels validation (skip for edge/node-only mode)
    const isNodeOnly = process.env.NOVA_NODE_ONLY === 'true' || process.env.NOVA_NO_TELEGRAM === 'true'
    if (config.channels?.telegram?.enabled && !isNodeOnly) {
        const tg = config.channels.telegram
        if (!tg.token && !process.env.TELEGRAM_BOT_TOKEN) {
            result.errors.push('Telegram aktiviert aber kein Token! Setze TELEGRAM_BOT_TOKEN in .env oder channels.telegram.token in config')
            result.valid = false
        }
        if (!tg.allowFrom || tg.allowFrom.length === 0) {
            result.warnings.push('telegram.allowFrom ist leer — Bot akzeptiert keine Nachrichten')
        }
    }

    // Nodes validation
    if (config.nodes && Array.isArray(config.nodes)) {
        for (let i = 0; i < config.nodes.length; i++) {
            const node = config.nodes[i]
            if (node.enabled === false) continue
            if (!node.name) result.errors.push(`nodes[${i}]: name fehlt`)
            if (!node.host) result.errors.push(`nodes[${i}]: host fehlt (Format: user@ip)`)
            if (node.host && !node.host.includes('@')) {
                result.warnings.push(`nodes[${i}]: host "${node.host}" hat kein @ — Format sollte user@ip sein`)
            }
        }
    }

    // API keys check (warn only)
    if (config.provider === 'openai' && !process.env.OPENAI_API_KEY) {
        result.warnings.push('Provider ist OpenAI aber OPENAI_API_KEY nicht in .env gesetzt')
    }
    if (config.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
        result.warnings.push('Provider ist Anthropic aber ANTHROPIC_API_KEY nicht in .env gesetzt')
    }

    // Dashboard validation
    if (config.dashboard?.port && (config.dashboard.port < 1024 || config.dashboard.port > 65535)) {
        result.warnings.push(`Dashboard Port ${config.dashboard.port} ist ungewöhnlich`)
    }

    // Autonomy validation
    if (config.autonomy?.intervalMinutes && config.autonomy.intervalMinutes < 1) {
        result.warnings.push('autonomy.intervalMinutes < 1 — das wird sehr aggressiv')
    }

    if (result.errors.length > 0) result.valid = false

    return result
}
