/**
 * Main succession (2.88): owner decisions per node.
 *
 * Succession is opt-in (`mesh.succession.enabled`). Once it is on, Main
 * eligibility is an explicit owner decision per node: a node may only become
 * Main when the owner allowed it (`mesh.succession.mainEligible: true` in its
 * config or `NOVA_MAIN_ELIGIBLE=true`). Everything else stays a worker.
 * Without succession the legacy rule is unchanged (eligible unless
 * `NOVA_MAIN_ELIGIBLE=false`).
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolveConfigPath } from '../config/config-path.js'

export interface SuccessionConfig {
    enabled: boolean
    /** Owner allowed this node to become Main. */
    mainEligible: boolean
    /** Longest an owner-confirmed emergency Main may act without a majority. */
    emergencyMaxMs: number
    /** Next-ranked candidate waits rank x grace after a vacancy. */
    vacancyGraceMs: number
    /**
     * Node ids the owner allowed to become Main (journal replicas). A fixed
     * list keeps the majority size stable; a shrinking discovery view must
     * never lower the quorum.
     */
    mainNodes: string[]
    /** Loopback owner door in safe mode (0 = off). */
    localPort: number
}

export const DEFAULT_EMERGENCY_MAX_MS = 4 * 60 * 60_000
export const MAX_EMERGENCY_MAX_MS = 24 * 60 * 60_000
export const DEFAULT_VACANCY_GRACE_MS = 20_000

function readRawConfig(): unknown {
    try {
        const path = resolveConfigPath()
        if (!existsSync(path)) return null
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        return null
    }
}

function explicitEnv(env: NodeJS.ProcessEnv): boolean | undefined {
    const value = String(env.NOVA_MAIN_ELIGIBLE ?? '').trim().toLowerCase()
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
    return undefined
}

export function parseSuccessionConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): SuccessionConfig {
    const section = (raw as { mesh?: { succession?: Record<string, unknown> } } | null)?.mesh?.succession || {}
    const enabled = section.enabled === true
    const fromEnv = explicitEnv(env)
    // An explicit "false" always wins: the owner said worker.
    const mainEligible = fromEnv === false ? false : fromEnv === true || section.mainEligible === true
    const emergency = Number(section.emergencyMaxMinutes) * 60_000
    const grace = Number(section.vacancyGraceSeconds) * 1000
    const mainNodes = Array.isArray(section.mainNodes)
        ? [...new Set((section.mainNodes as unknown[]).map(item => String(item || '').trim()).filter(Boolean))].slice(0, 32)
        : []
    return {
        enabled,
        mainEligible,
        mainNodes,
        localPort: Number.isInteger(section.localPort) && Number(section.localPort) >= 0 && Number(section.localPort) < 65536 ? Number(section.localPort) : 3019,
        emergencyMaxMs: Number.isFinite(emergency) && emergency > 0 ? Math.min(emergency, MAX_EMERGENCY_MAX_MS) : DEFAULT_EMERGENCY_MAX_MS,
        vacancyGraceMs: Number.isFinite(grace) && grace >= 0 ? Math.min(grace, 5 * 60_000) : DEFAULT_VACANCY_GRACE_MS,
    }
}

export function loadSuccessionConfig(env: NodeJS.ProcessEnv = process.env, raw: unknown = readRawConfig()): SuccessionConfig {
    return parseSuccessionConfig(raw, env)
}

/**
 * Single eligibility rule for election, capability advertising and ranking.
 * Succession on: explicit owner permission required (default worker).
 * Succession off: legacy default (eligible unless NOVA_MAIN_ELIGIBLE=false).
 */
export function isNodeMainEligible(env: NodeJS.ProcessEnv = process.env, raw: unknown = readRawConfig()): boolean {
    const config = parseSuccessionConfig(raw, env)
    if (config.enabled) return config.mainEligible
    return explicitEnv(env) !== false
}
