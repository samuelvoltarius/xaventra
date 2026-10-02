import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessWorkspaceSource, fetchPinnedCommit, fetchWorkspace, gitRunner, verifyCheckout } from './workspace-handoff.js'

// 2.86 Paket J Punkt 4 (erster belegter Schritt): Arbeitsdaten wandern mit.
// Quelle ist ein eigenes Git-Ziel im Mesh (z. B. NAS); der ausführende Knoten
// holt genau den angegebenen Commit, verschlüsselt (ssh/https), nie aus der
// Cloud, und prüft das Ergebnis. Tests: nur lokales git, kein Netz.
const MESH = ['xaventra-nas', 'nas.example.com']

describe('assessWorkspaceSource — nur eigenes Mesh, nur verschlüsselt', () => {
    it('erlaubt ssh/https zu Mesh-Knoten, Tailnet und privaten Adressen', () => {
        for (const url of [
            'ssh://git@xaventra-nas/srv/git/projekt.git',
            'git@nas.example.com:projekte/website.git',
            'ssh://git@100.101.102.103:2222/srv/git/a.git',
            'https://nas.tailnet-1234.ts.net/git/a.git',
            'ssh://git@192.168.1.20/srv/git/a.git',
        ]) expect(assessWorkspaceSource(url, MESH), url).toMatchObject({ ok: true })
        expect(assessWorkspaceSource('git@nas.example.com:projekte/website.git', MESH)).toMatchObject({ transport: 'ssh', host: 'nas.example.com' })
    })

    it('verweigert Cloud, unverschlüsselte Wege, Zugangsdaten in der URL und Optionen', () => {
        const cases: Array<[string, RegExp]> = [
            ['https://github.com/example/projekt.git', /nicht im eigenen Mesh/],
            ['git@github.com:example/projekt.git', /nicht im eigenen Mesh/],
            ['http://xaventra-nas/git/a.git', /unverschlüsselt/],
            ['git://xaventra-nas/a.git', /unverschlüsselt/],
            ['file:///srv/git/a.git', /Protokoll/],
            ['ext::sh -c touch% /tmp/pwned', /Protokoll/],
            ['https://user:geheim@xaventra-nas/git/a.git', /Zugangsdaten/],
            ['ssh://-oProxyCommand=touch%20x/a.git', /ungültig/],
            ['', /leer/],
        ]
        for (const [url, reason] of cases) {
            const result = assessWorkspaceSource(url, MESH)
            expect(result.ok, url).toBe(false)
            expect(result.ok ? '' : result.reason, url).toMatch(reason)
        }
    })
})

describe('fetchWorkspace — genau ein Commit, ohne Shell', () => {
    const commit = 'a'.repeat(40)

    it('prüft Quelle und Commit, bevor git läuft; erlaubt nur ssh/https', async () => {
        const calls: string[][] = []
        const runGit = async (args: string[]) => { calls.push(args); return { code: 0, stdout: args.includes('rev-parse') ? `${commit}\n` : '' } }
        const result = await fetchWorkspace({ source: 'ssh://git@xaventra-nas/srv/git/a.git', commit }, join(tmpdir(), 'xav-ws-plan'), { meshHosts: MESH, runGit })
        expect(result).toMatchObject({ ok: true, commit })
        const fetch = calls.find(args => args.includes('fetch'))!
        expect(fetch).toEqual(expect.arrayContaining(['-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.https.allow=always', '--', 'ssh://git@xaventra-nas/srv/git/a.git', commit]))
        expect(fetch.indexOf('--')).toBeLessThan(fetch.indexOf('ssh://git@xaventra-nas/srv/git/a.git'))

        calls.length = 0
        expect(await fetchWorkspace({ source: 'https://github.com/example/a.git', commit }, join(tmpdir(), 'x'), { meshHosts: MESH, runGit })).toMatchObject({ ok: false })
        expect(await fetchWorkspace({ source: 'ssh://git@xaventra-nas/a.git', commit: 'main' }, join(tmpdir(), 'x'), { meshHosts: MESH, runGit })).toMatchObject({ ok: false, reason: expect.stringMatching(/Commit/) })
        expect(calls).toEqual([])
    })
})

describe('mit echtem git (lokal, ohne Netz)', () => {
    const dirs: string[] = []
    const temp = (name: string) => { const dir = mkdtempSync(join(tmpdir(), `xav-${name}-`)); dirs.push(dir); return dir }
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()

    it('holt den gepinnten Commit und erkennt Abweichungen', async () => {
        const source = temp('src')
        git(source, 'init', '-q')
        writeFileSync(join(source, 'arbeit.txt'), 'Stand 1\n')
        git(source, 'add', 'arbeit.txt'); git(source, 'commit', '-q', '-m', 'eins')
        const first = git(source, 'rev-parse', 'HEAD')
        writeFileSync(join(source, 'arbeit.txt'), 'Stand 2\n')
        git(source, 'commit', '-q', '-am', 'zwei')

        const target = join(temp('dst'), 'ws')
        // Nur im Test: lokales Protokoll statt ssh/https.
        const fetched = await fetchPinnedCommit(source, first, target, gitRunner(), ['file'])
        expect(fetched).toMatchObject({ ok: true, commit: first })
        expect(await verifyCheckout(target, first, gitRunner())).toMatchObject({ ok: true })

        writeFileSync(join(target, 'arbeit.txt'), 'manipuliert\n')
        expect(await verifyCheckout(target, first, gitRunner())).toMatchObject({ ok: false, reason: expect.stringMatching(/geändert/) })
        expect(await verifyCheckout(target, 'b'.repeat(40), gitRunner())).toMatchObject({ ok: false })
    }, 30_000)
})
