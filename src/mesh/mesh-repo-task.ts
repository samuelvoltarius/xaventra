/**
 * Mesh-Git (2.88): eine Repo-Aufgabe auf dem passenden Knoten ausführen.
 *
 *  1. Stand festlegen: `main` (oder ein Zweig) des Mesh-Repos auf dem Main,
 *     optional vorher aus einem lokalen Repository übernommen.
 *  2. Knoten wählen: angegeben oder „auto“ (Stärken: Programmieren).
 *  3. Liefern: genau dieser Commit als Bundle über den signierten Mesh-Weg.
 *  4. Arbeiten: Subagent auf dem Knoten, im gelieferten Arbeitsordner
 *     (nur die Werkzeuge, die die Mesh-Richtlinie dort erlaubt).
 *  5. Zurückholen: Ergebnis als eigener Zweig `mesh/<knoten>/<arbeit>`.
 *  6. Aufräumen: Arbeitsordner auf dem Knoten entfernen — immer.
 */
import type { GitReceipt, GitRequest } from './mesh-git.js'

export interface RepoTaskInput {
    repo: string
    task: string
    /** Node id, or "auto" / empty = pick by strength. */
    node?: string
    ref?: string
    /** Optional local repository to publish into the mesh repo first. */
    sourcePath?: string
    tools?: string[]
    timeoutMs?: number
    parent?: { userId?: string; authUserId?: string }
}

export interface RepoTaskResult {
    status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'not-started'
    node?: string
    reason?: string
    commit?: string
    workId?: string
    branch?: string | null
    changedFiles?: number
    output?: string
    error?: string
}

export interface RepoTaskDeps {
    localNodeId: () => string
    route: (task: string) => Promise<{ nodeId: string; isLocal: boolean; reason: string }>
    publish: (sourcePath: string, repo: string) => Promise<{ commit: string }>
    head: (repo: string, ref: string) => Promise<string>
    prepare: (repo: string, commit: string, workId: string) => Promise<Extract<GitRequest, { operation: 'deliver' }>>
    request: (node: string, payload: GitRequest) => Promise<GitReceipt>
    importResult: (repo: string, node: string, receipt: Extract<GitReceipt, { operation: 'collect' }>) => Promise<{ branch: string | null; head: string; changedFiles: number }>
    spawn: (task: { task: string; meshNode?: string; tools?: string[]; timeoutMs?: number; userId?: string; authUserId?: string }) => Promise<{ status: string; output: string; error?: string }>
    newWorkId: () => string
}

/** Read tools that the default mesh policy allows remotely; write tools only where the owner allowed them. */
export const DEFAULT_REPO_TASK_TOOLS = ['read_file', 'list_directory', 'find_files', 'code_search', 'code_outline', 'view_code_item']

export async function defaultRepoTaskDeps(): Promise<RepoTaskDeps> {
    const git = await import('./mesh-git.js')
    const runtime = await import('./mesh-transport-runtime.js')
    const { getLocalNodeId } = await import('./mesh-registry.js')
    return {
        localNodeId: getLocalNodeId,
        route: async () => {
            const { rankNodesLive, shortReason } = await import('./node-strengths.js')
            const ranking = await rankNodesLive('code')
            const best = ranking.ranked[0]
            return best ? { nodeId: best.nodeId, isLocal: best.local, reason: shortReason(ranking) } : { nodeId: getLocalNodeId(), isLocal: true, reason: shortReason(ranking) }
        },
        publish: (sourcePath, repo) => git.publishRepo(sourcePath, repo),
        head: (repo, ref) => git.repoHead(repo, ref),
        prepare: (repo, commit, workId) => git.prepareDelivery(repo, commit, workId),
        request: (node, payload) => runtime.requestGitOperation(node, payload),
        importResult: (repo, node, receipt) => git.importResult(repo, node, receipt),
        spawn: async task => {
            const { spawnSubagent } = await import('../agents/subagent-orchestrator.js')
            return spawnSubagent(task)
        },
        newWorkId: git.newWorkId,
    }
}

export function repoTaskPrompt(task: string, path: string, repo: string, commit: string): string {
    return [
        `Arbeitsordner: ${path} (Repo ${repo}, Stand ${commit.slice(0, 12)}).`,
        'Arbeite nur in diesem Ordner, Pfade relativ dazu angeben. Änderungen dort werden danach automatisch als Zweig zurückgeholt; nichts selbst committen oder pushen.',
        '',
        `Aufgabe: ${task}`,
    ].join('\n')
}

export async function runRepoTaskOnNode(input: RepoTaskInput, deps?: RepoTaskDeps): Promise<RepoTaskResult> {
    const d = deps || await defaultRepoTaskDeps()
    const repo = String(input.repo || '')
    let commit: string
    try {
        commit = input.sourcePath ? (await d.publish(input.sourcePath, repo)).commit : await d.head(repo, input.ref || 'main')
    } catch (error) {
        return { status: 'not-started', error: String((error as Error)?.message || error).slice(0, 200) }
    }
    let node = String(input.node || '').trim()
    let reason = 'vom Nutzer gewählt'
    if (!node || node === 'auto') {
        const decision = await d.route(input.task)
        node = decision.isLocal ? d.localNodeId() : decision.nodeId
        reason = decision.reason
    }
    const workId = d.newWorkId()
    const base: RepoTaskResult = { status: 'failed', node, reason, commit, workId }
    let delivered = false
    try {
        const delivery = await d.prepare(repo, commit, workId)
        const receipt = await d.request(node, delivery)
        if (receipt.operation !== 'deliver') throw new Error('unexpected git receipt')
        delivered = true
        const run = await d.spawn({
            task: repoTaskPrompt(input.task, receipt.path, repo, commit),
            meshNode: node === d.localNodeId() ? undefined : node,
            tools: input.tools?.length ? input.tools : DEFAULT_REPO_TASK_TOOLS,
            timeoutMs: input.timeoutMs || 10 * 60_000,
            ...(input.parent?.userId ? { userId: input.parent.userId } : {}),
            ...(input.parent?.authUserId ? { authUserId: input.parent.authUserId } : {}),
        })
        const collected = await d.request(node, { operation: 'collect', repo, workId, base: commit })
        if (collected.operation !== 'collect') throw new Error('unexpected git receipt')
        const imported = await d.importResult(repo, node, collected)
        const status = (['completed', 'failed', 'timeout', 'cancelled'] as const).find(item => item === run.status) || 'failed'
        return { ...base, status, branch: imported.branch, changedFiles: imported.changedFiles, output: run.output, ...(run.error ? { error: run.error } : {}) }
    } catch (error) {
        return { ...base, error: String((error as Error)?.message || error).slice(0, 300) }
    } finally {
        if (delivered) await d.request(node, { operation: 'release', repo, workId }).catch(() => undefined)
    }
}

/** Short German answer for the owner. */
export function formatRepoTaskResult(result: RepoTaskResult): string {
    if (result.status === 'not-started') return `Nicht gestartet: ${result.error || 'unbekannter Fehler'}`
    const where = result.node ? `auf ${result.node}${result.reason ? ` (${result.reason})` : ''}` : ''
    const lines = [`${result.status === 'completed' ? 'Erledigt' : result.status === 'timeout' ? 'Zeit abgelaufen' : 'Nicht geschafft'} ${where}.`.replace(/\s+\./, '.')]
    if (result.branch) lines.push(`Ergebnis im Zweig ${result.branch} (${result.changedFiles} ${result.changedFiles === 1 ? 'Datei' : 'Dateien'} geändert). main bleibt unverändert.`)
    else if (result.status === 'completed') lines.push('Keine Dateien geändert.')
    if (result.error) lines.push(`Grund: ${result.error}`)
    if (result.output) lines.push('', result.output.slice(0, 3000))
    return lines.join('\n')
}
