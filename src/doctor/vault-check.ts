/**
 * Doctor check for the vault (30.10.2026): a sealed store that no known key opens is reported
 * by path — never silently treated as "no access". Also warns when the vault key lies in the
 * data tree (copied with backups, peer swaps and the rollback copy of the runtime).
 * Reads only; never prints values.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { openCredential, vaultKeySource } from '../secrets/local-sealed-store.js'
import type { CheckResult, DoctorIssue } from './types.js'

function walk(dir: string): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
}

export function checkVault(dataDirs: readonly string[]): CheckResult {
    const issues: DoctorIssue[] = []
    for (const dataDir of [...new Set(dataDirs)]) {
        for (const path of walk(join(dataDir, 'secrets'))) {
            if (/\.(?:tmp|vor-tresor)$/.test(path) || path.endsWith('.credential-key')) continue
            let raw: string
            try { raw = readFileSync(path, 'utf8') } catch { continue }
            if (!raw.startsWith('nova-sealed:')) continue
            try { openCredential(raw, path) } catch {
                issues.push({
                    code: 'VAULT_STORE_UNREADABLE', severity: 'error',
                    message: `Tresor-Speicher nicht lesbar: ${relative(dataDir, path).split('\\').join('/')}`,
                    detail: 'Der Zugang ist gespeichert, aber der Schlüssel fehlt oder passt nicht — nichts gelöscht.',
                    fix: { type: 'info', hint: 'Den richtigen Tresor-Schlüssel wieder bereitstellen (NOVA_CREDENTIAL_KEY_FILE, systemd LoadCredential xaventra-credential-key oder Docker-Secret); danach ist der Zugang wieder da.', safe: false },
                })
            }
        }
    }
    if (vaultKeySource().kind === 'datenbaum') {
        issues.push({
            code: 'VAULT_KEY_IN_DATA_TREE', severity: 'warning',
            message: 'Tresor-Schlüssel liegt im Datenbaum',
            fix: { type: 'info', hint: 'NOVA_CREDENTIAL_KEY_FILE auf einen Pfad außerhalb des Datenbaums setzen (oder systemd LoadCredential / Docker-Secret).', safe: false },
        })
    }
    const unreadable = issues.filter(item => item.code === 'VAULT_STORE_UNREADABLE').length
    return {
        ok: unreadable === 0,
        label: 'Tresor',
        status: unreadable ? `${unreadable} Speicher nicht lesbar` : `Schlüssel: ${vaultKeySource().kind}`,
        issues,
    }
}
