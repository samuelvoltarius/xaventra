import { readFileSync } from 'node:fs'
import { resolveConfigPath } from '../config/config-path.js'
import { getNovaDataDir } from './data-root.js'
import { GitHubUpdateSource, installedUpdateVersion, type GitHubUpdatePolicy, type UpstreamStatus } from './github-update.js'
import { updateControllerRequest, formatUpdateJob } from './update-controller-client.js'

let cached: { key: string; source: GitHubUpdateSource } | undefined
export function configuredUpstreamSource(): GitHubUpdateSource {
    let policy: GitHubUpdatePolicy = {}
    try { policy = JSON.parse(readFileSync(resolveConfigPath(), 'utf8')).mesh?.update?.github || {} }
    catch { /* An unconfigured public check is safe; downloads still require publisher trust. */ }
    const root = getNovaDataDir('upstream-updates'), version = installedUpdateVersion()
    const key = JSON.stringify({ policy, root, version })
    if (cached?.key !== key) cached = { key, source: new GitHubUpdateSource(root, policy, version) }
    return cached.source
}
export function formatUpstreamStatus(s: UpstreamStatus): string {
    const lines = [`📦 Xaventra GitHub-Update: ${s.state}`, `Letzter Check: ${s.checkedAt || 'nie'}`]
    if (s.version) lines.push(`Version: ${s.version}`)
    if (s.releaseId) lines.push(`Release: ${s.releaseId}`)
    lines.push(`Publisher-Signatur: ${s.originVerified ? 'verifiziert' : 'nicht verifiziert'}`)
    if (s.reason) lines.push(`Grund: ${s.reason}`)
    if (s.state === 'no-eligible-release') lines.push('Keine neuere passende GitHub-Release in diesem Channel. Commits allein sind keine installierbaren Releases.')
    if (s.state === 'available') lines.push(`Download prüfen: /update prepare ${s.releaseId}`)
    if (s.state === 'prepared') lines.push('Paket vollständig heruntergeladen und geprüft. Noch nicht installiert; kein Container neu gestartet.')
    return lines.join('\n')
}
export async function upstreamUpdateCommand(args: string, permission: string, source = configuredUpstreamSource(), controller = updateControllerRequest): Promise<string> {
    const [action = 'status', id, ...extra] = args.trim().split(/\s+/).filter(Boolean)
    if (extra.length || !['status', 'check', 'prepare', 'deploy'].includes(action)) return '/update check · /update prepare <Release-ID> · /update deploy <Release-ID> · /update status'
    if (['prepare', 'deploy'].includes(action) && !['owner', 'admin'].includes(permission)) return '🔒 Nur Owner/Admin dürfen Update-Pakete vorbereiten oder aktivieren.'
    if (action === 'status') {
        const status = await source.status(), release = id || status.releaseId
        if (release && (id || process.env.XAVENTRA_UPDATE_CLIENT_FILE)) {
            try { return `${formatUpstreamStatus(status)}\n\n${formatUpdateJob(await controller('status', release))}` }
            catch { return `${formatUpstreamStatus(status)}\nController-Status nicht verifiziert.` }
        }
        return formatUpstreamStatus(status)
    }
    if (action === 'check') return formatUpstreamStatus(await source.check())
    if (!id) return 'Bitte zuerst /update check ausführen und die angezeigte exakte Release-ID verwenden. Ein Versionswechsel wird nicht stillschweigend genehmigt.'
    const prepared = await source.prepare(id)
    const report = formatUpstreamStatus(prepared)
    if (action !== 'deploy' || prepared.state !== 'prepared') return report
    try { return `${report}\n\n${formatUpdateJob(await controller('deploy', id))}` }
    catch { return `${report}\n\n❌ Aktivierung gesperrt oder unbestätigt: Update-Controller nicht eingeschrieben, nicht erreichbar oder keine gültige Freigabe. Kein Rollout gestartet durch diesen Prozess; ein verlorener Controller-Ack ist kein Abbruchnachweis. /update status ${id} prüfen.` }
}
