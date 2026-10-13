/**
 * 2.89.5: Modellanbieter-Schlüssel stehen nur im node-lokalen verschlüsselten
 * Schlüssel-Tresor (0600-Auth-Store, at-rest AES-256-GCM via local-sealed-store).
 * `xaventra.config.json` und `.nova-data/external-providers.json` tragen nur die
 * Referenz `apiKeyRef = auth:llm-provider:<name>` — dasselbe Profil, das
 * model-resolver.ts beim Registrieren schreibt und beim Laden rehydriert.
 * Beim Lesen wird der Schlüssel synchron aus dem Tresor geholt; der Anbieter
 * funktioniert damit wie bisher. Restliche Klartextwerte wandern beim ersten
 * Lesen bzw. beim Start dorthin zurück (idempotent, Config ohne Schlüssel gesichert).
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'
import { atomicWriteFileSync } from '../core/atomic-storage.js'
import { getOAuthManager } from '../auth/oauth.js'
import { registerSecretValue } from '../security/secret-redaction.js'

const REF = 'auth:'

/** Tresor-Profil eines Anbieters — identisch zur Konvention von model-resolver.ts. */
export function providerKeyProfileId(name: unknown): string {
    return `llm-provider:${String(name ?? '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '')}`
}

/**
 * Ein echter Schlüsselwert — keine Referenz, kein versiegelter Wert, nicht leer.
 * Ab 8 Zeichen; kürzere Platzhalter werden nicht migriert, bleiben aber nutzbar.
 */
export function isPlaintextProviderKey(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 8 && !/^(?:auth|tresor|ref):/i.test(value) && !value.startsWith('nova-sealed:')
}

/**
 * In den Tresor legen (0600, versiegelt) + der Redaction registrieren; ergibt die
 * Referenz. Akzeptiert jeden echten Wert — auch kurze Test-Schlüssel; Referenzen
 * und versiegelte Werte sind keine Schlüssel und werden abgelehnt.
 */
export function storeProviderKey(name: unknown, value: string): string {
    const profileId = providerKeyProfileId(name)
    const key = String(value ?? '')
    if (!profileId || key.length < 1 || /^(?:auth|tresor|ref):/i.test(key) || key.startsWith('nova-sealed:')) throw new Error('Ungültiger Provider-Key')
    registerSecretValue(key, profileId)
    getOAuthManager().setApiKey(profileId, String(name).toLowerCase(), key)
    return `${REF}${profileId}`
}

/** Referenz → Tresor (sync); ein Klartextwert bleibt bis zur Migration nutzbar. */
export function resolveProviderKey(entry: any): string {
    if (!entry || typeof entry !== 'object') return ''
    if (isPlaintextProviderKey(entry.apiKey)) return entry.apiKey
    const ref = String(entry.apiKeyRef || '')
    if (!ref.startsWith(REF)) return ''
    try {
        const profile = getOAuthManager().getProfile(ref.slice(REF.length)) as { key?: string } | null
        return typeof profile?.key === 'string' ? profile.key : ''
    } catch { return '' }
}

/** Hat der Anbieter einen Schlüssel (Referenz auflösbar)? Gibt nie den Wert zurück. */
export function providerKeyPresent(entry: any): boolean {
    return resolveProviderKey(entry) !== ''
}

/**
 * Migration der Config-Datei: `providers.<name>.apiKey` in den Tresor, die Datei
 * behält nur Referenzen. Zuerst liegt die Sicherung der Config ohne Schlüssel
 * (die Sicherung enthält nie den Wert). Idempotent; ein Anbieter ohne auflösbaren
 * Tresorwert bleibt unverändert, damit nichts verloren geht.
 */
export function migrateConfigProviderKeys(options: { configPath?: string } = {}): string[] {
    const configPath = options.configPath || resolveConfigPath()
    if (!existsSync(configPath)) return []
    let cfg: any
    try { cfg = JSON.parse(readFileSync(configPath, 'utf8')) } catch { return [] }
    const names = Object.entries(cfg?.providers || {}).filter(([, entry]: any) => isPlaintextProviderKey(entry?.apiKey)).map(([name]) => name)
    if (!names.length) return []
    const moved: string[] = []
    for (const name of names) {
        const entry = cfg.providers[name]
        try {
            entry.apiKeyRef = storeProviderKey(name, String(entry.apiKey))
            entry.apiKey = ''
            moved.push(name)
        } catch { /* Tresor nicht verfügbar: Schlüssel bleibt, nächste migration */ }
    }
    if (!moved.length) return []
    const backupPath = join(dirname(configPath), basename(configPath).replace(/\.json$/i, '') + '.backup.json')
    atomicWriteFileSync(backupPath, JSON.stringify({ ...cfg, secretMigration: { at: new Date().toISOString(), movedProviderKeys: moved } }, null, 4))
    atomicWriteFileSync(configPath, JSON.stringify(cfg, null, 4))
    return moved
}

/**
 * Lese-Pfad für ein frisch von Platte gelesenes Config-Objekt: füllt jedes
 * `providers.<name>.apiKey` aus dem Tresor. Findet die Datei noch Klartext,
 * wandert er zuerst in den Tresor (Auftritt wie die Start-Migration).
 * Gibt dasselbe Objekt zurück — der Anbieter arbeitet ohne Neustart weiter.
 */
export function rehydrateConfigProviderKeys(config: any): any {
    const providers = config?.providers
    if (!providers || typeof providers !== 'object') return config
    const entries = Object.values(providers) as any[]
    if (entries.some(entry => entry && typeof entry === 'object' && isPlaintextProviderKey(entry.apiKey))) migrateConfigProviderKeys()
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || entry.apiKey) continue
        const key = resolveProviderKey(entry)
        if (key) entry.apiKey = key
    }
    return config
}

export default { providerKeyProfileId, isPlaintextProviderKey, storeProviderKey, resolveProviderKey, providerKeyPresent, migrateConfigProviderKeys, rehydrateConfigProviderKeys }
