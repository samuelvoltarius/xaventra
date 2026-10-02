import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parse as parseEnv } from 'dotenv'
import { resolveConfigPath } from '../config/config-path.js'

// ============================================================================
// 2.85 Paket B — erster Start ohne Fragebogen.
//
// Ohne Konfiguration beendete sich der Daemon bisher mit Exit 1 ("Führe npm run
// setup aus"). Jetzt legt er dieselbe sichere Grundkonfiguration an wie der
// Installer (scripts/setup.mjs seedConfiguration: lokal zuerst, keine Kanäle,
// keine Peers, nur 127.0.0.1) und startet im Ersteinrichtungs-Modus. Eine
// vorhandene Installation bekommt nie einen Ersteinrichtungs-Marker: ihr
// Verhalten bleibt unverändert.
// ============================================================================

export type FirstStartReportStatus = 'ok' | 'getan' | 'vorgeschlagen' | 'braucht-dich' | 'gescheitert'
export interface FirstStartReportItem {
    step: 'doctor' | 'hardware' | 'modell' | 'einrichtung'
    status: FirstStartReportStatus
    text: string
    /** Doctor case that Xaventra follows itself (failure-research). */
    caseId?: string
    /** Install queue proposal (card) for a catalog entry. */
    proposalId?: string
    catalogId?: string
}
export interface FirstStartReport {
    startedAt: string
    finishedAt: string
    hardware: { platform: string; arch: string; cpus: number; memoryGb: number; gpu: string | null }
    localModel: { provider: string; model: string; endpoint: string } | null
    items: FirstStartReportItem[]
}
export interface TelegramOnboardingState {
    /** sha256 of the one-time pairing code; the code itself is never stored. */
    codeHash?: string
    expiresAt?: string
    pairedAt?: string
    /** Display only (Telegram @username or "verbunden"); the id lives in the config allowFrom. */
    pairedWith?: string
    /** Public @username of the bot (from getMe), for the t.me link. Never the token. */
    botUsername?: string
}
export interface OnboardingState {
    version: 1
    state: 'pending' | 'done'
    seededAt: string
    /** The local Desktop app took over the owner token (once, see onboarding-api). */
    claimedAt?: string
    ownerName?: string
    doctor?: FirstStartReport
    doctorRunning?: boolean
    telegram?: TelegramOnboardingState
    completedAt?: string
}

export function onboardingStatePath(root = process.cwd()): string {
    return join(root, '.nova-data', 'onboarding.json')
}

/** null = no marker (existing installation) or unreadable marker (treated as no first start). */
export function readOnboardingState(root = process.cwd()): OnboardingState | null {
    try {
        const value = JSON.parse(readFileSync(onboardingStatePath(root), 'utf8'))
        if (!value || value.version !== 1 || !['pending', 'done'].includes(value.state)) return null
        return value as OnboardingState
    } catch { return null }
}

export function isFirstStartPending(root = process.cwd()): boolean {
    return readOnboardingState(root)?.state === 'pending'
}

/** Atomic update of an existing marker. Never creates one: only seeding does. */
export function updateOnboardingState(patch: Partial<OnboardingState> | ((current: OnboardingState) => Partial<OnboardingState>), root = process.cwd()): OnboardingState | null {
    const current = readOnboardingState(root)
    if (!current) return null
    const next: OnboardingState = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), version: 1 }
    const path = onboardingStatePath(root)
    mkdirSync(join(root, '.nova-data'), { recursive: true })
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
    return next
}

export type ConfigSeeder = (directory: string) => string

async function loadSeeder(): Promise<ConfigSeeder> {
    // One seeding rule for installer and daemon (no second copy of the defaults).
    // src/onboarding and dist/onboarding both sit two levels below the package root.
    const module: any = await import(new URL('../../scripts/setup.mjs', import.meta.url).href)
    return module.seedConfiguration as ConfigSeeder
}

export interface FirstStartResult { seeded: boolean; firstStart: boolean; configPath: string }

/**
 * Before config validation: seed a safe configuration when none exists.
 * Existing configurations are never touched (same rule as the installer).
 */
export async function ensureFirstStartConfig(options: { root?: string; env?: Record<string, string | undefined>; seed?: ConfigSeeder } = {}): Promise<FirstStartResult> {
    const root = options.root ?? process.cwd()
    const env = options.env ?? process.env
    const existing = resolveConfigPath(root)
    if (existsSync(existing)) return { seeded: false, firstStart: isFirstStartPending(root), configPath: existing }
    const seed = options.seed ?? await loadSeeder()
    const configPath = seed(root)
    // dotenv ran before this; values of a .env created just now must reach this process too.
    // Variables the process already has always win (same rule as dotenv).
    try {
        const values = parseEnv(readFileSync(join(root, '.env'), 'utf8'))
        for (const [key, value] of Object.entries(values)) if (env[key] === undefined) env[key] = value
    } catch { /* no .env: nothing to load */ }
    return { seeded: true, firstStart: isFirstStartPending(root), configPath }
}
