import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'

export interface PatchSandboxRequest {
    projectRoot: string
    file: string
    search: string
    replace: string
    /** Existing unchanged regression test, failing before and passing after repair. */
    reproductionTest?: string
}
export interface SandboxPhase {
    phase: 'baseline' | 'candidate' | 'rollback' | 'recovery'
    snapshotHash: string
    buildPassed: boolean
    testsPassed: boolean
    reproductionPassed?: boolean
}
export interface PatchSandboxResult {
    verified: boolean
    buildPassed: boolean
    testsPassed: boolean
    rollbackPassed?: boolean
    recoveryPassed?: boolean
    symptomVerified?: boolean
    reproductionPassed?: boolean
    cleanupVerified?: boolean
    baselineHash?: string
    candidateHash?: string
    imageId?: string
    phases?: SandboxPhase[]
    output: string
}
type Snapshot = Record<string, string>
const MAX_BYTES = 64 * 1024 * 1024
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const snapshotHash = (files: Snapshot) => hash(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
const safeRelative = (file: string) => typeof file === 'string' && /^[^\\:\x00-\x1f<>|"*?]+$/.test(file)
    && !file.startsWith('/') && file.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p))
const forbidden = (file: string) => file.split('/').some(p => /^\.env(?:\.|$)|^\.nova-|^\.xaventra-|^node_modules$|^\.git$|^\.ssh$|^\.npmrc$|^PROJECT_MEMORY\.md$|^(?:nova|xaventra)\.config\.json$|\.(?:pem|key|p12|pfx)$/i.test(p))

/** Shared pre-read boundary including ancestors, junctions and hard links. */
export function assertPatchSourcePath(root: string, file: string): void {
    if (!safeRelative(file) || !file.startsWith('src/') || forbidden(file)) throw new Error('Unsafe source path')
    assertRegularPath(root, file)
}
function assertRegularPath(root: string, file: string): void {
    let cursor = realpathSync(root)
    const parts = file.split('/')
    for (const [index, part] of parts.entries()) {
        cursor = join(cursor, part)
        const stat = lstatSync(cursor)
        if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
            throw new Error('Linked or non-regular sandbox input')
        }
    }
}
function snapshot(root: string): Snapshot {
    // Only tracked inputs; never recursively copy the running installation.
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_BYTES })
    const files: Snapshot = Object.create(null)
    let size = 0, count = 0
    for (const file of tracked.split('\0').filter(Boolean).sort()) {
        if (forbidden(file)) continue
        if (!safeRelative(file)) throw new Error('Non-canonical tracked path')
        if (!/^(?:src|test|scripts|docs|models|catalogs|contracts|desktop|\.github)\//.test(file)
            && !/^[^/]+\.(?:json|ts|js|mjs|cjs|md|sh|ps1)$/.test(file)) continue
        if (/\.(?:gguf|bin|exe|zip|png|jpg|ico|icns)$/i.test(file)) continue
        assertRegularPath(root, file)
        const bytes = readFileSync(join(root, file))
        size += bytes.length
        if (size > MAX_BYTES || ++count > 20_000) throw new Error('Sandbox snapshot exceeds budget')
        files[file] = bytes.toString('base64')
    }
    for (const required of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'xaventra.config.example.json']) {
        if (!files[required]) throw new Error(`Missing tracked sandbox input: ${required}`)
    }
    return files
}

// Host-supplied driver, not a model-supplied shell command. Rebuild environment
// inside the container too: even the prepared image must not supply credentials.
const DRIVER = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 try {
  if (process.getuid() !== 1000 || fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim() !== '4294967296'
   || fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim() !== '128'
   || fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim() !== '200000 100000') throw new Error('Limits unavailable');
  const { files, command, timeout } = JSON.parse(input);
  for (const [file, bytes] of Object.entries(files)) {
   const target = path.join('/workspace', file);
   fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(bytes, 'base64'));
  }
  fs.mkdirSync('/workspace/node_modules');
  for (const name of fs.readdirSync('/opt/sandbox/node_modules')) {
   fs.symlinkSync('/opt/sandbox/node_modules/' + name, '/workspace/node_modules/' + name);
  }
  const env = { PATH:'/usr/local/bin:/usr/bin:/bin', HOME:'/tmp/home', TMPDIR:'/tmp',
   NOVA_TEST_MODE:'1', NOVA_NO_SIDE_EFFECTS:'1', NOVA_SKIP_MODEL_RESOLVER_INIT:'1',
   NOVA_RUNTIME_ROOT:'/tmp/runtime', NOVA_PROJECT_ROOT:'/workspace', CI:'1' };
  fs.mkdirSync(env.HOME, { recursive:true });
  const r = cp.spawnSync('/usr/local/bin/node', command, {cwd:'/workspace', env, stdio:'inherit', timeout, killSignal:'SIGKILL'});
  if (r.error && r.error.code === 'ETIMEDOUT') console.error('Sandbox command deadline exceeded');
  process.exit(r.error || r.signal ? 2 : r.status === 0 ? 0 : r.status === 1 ? 10 : 2);
 } catch (error) { console.error('Sandbox driver:', error.message); process.exit(2); }
});`

function docker(args: string[], input?: string, timeout = 15_000): Promise<{ ok: boolean; output: string; code: number | null }> {
    return new Promise(resolveResult => {
        const env: NodeJS.ProcessEnv = {}
        // Docker context is transport only. None of these are forwarded into the container.
        for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
            if (process.env[key]) env[key] = process.env[key]
        }
        const child = spawn('docker', args, { env, windowsHide: true, stdio: 'pipe' })
        let output = '', bytes = 0, exceeded = false, timedOut = false
        const collect = (chunk: Buffer) => {
            bytes += chunk.length; output = (output + chunk.toString()).slice(-65536)
            if (bytes > 4 * 1024 * 1024) { exceeded = true; child.kill() }
        }
        child.stdout.on('data', collect); child.stderr.on('data', collect)
        const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout)
        child.on('error', () => { clearTimeout(timer); resolveResult({ ok: false, code: null, output: 'Docker unavailable' }) })
        child.on('close', code => { clearTimeout(timer); resolveResult({ ok: code === 0 && !timedOut && !exceeded, code, output: timedOut ? 'Sandbox timeout' : exceeded ? 'Sandbox output limit' : output }) })
        child.stdin.on('error', () => { /* early container failure is handled on close */ })
        child.stdin.end(input)
    })
}

/** No host-execution fallback. Every command uses a fresh constrained container. */
export async function validatePatchInSandbox(request: PatchSandboxRequest): Promise<PatchSandboxResult> {
    const result: PatchSandboxResult = { verified: false, buildPassed: false, testsPassed: false,
        rollbackPassed: false, recoveryPassed: false, symptomVerified: false, reproductionPassed: false, cleanupVerified: true, phases: [], output: '' }
    const started = Date.now()
    try {
        assertPatchSourcePath(request.projectRoot, request.file)
        if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(request.file)) throw new Error('A patch cannot modify its test oracle')
        if (!request.search || request.search === request.replace) throw new Error('Empty or ineffective patch')
        const files = snapshot(request.projectRoot)
        if (!files[request.file]) throw new Error('Patch target must be tracked')
        const original = Buffer.from(files[request.file], 'base64').toString('utf8')
        if (!original.includes(request.search)) throw new Error('Search text missing')
        const candidate = { ...files, [request.file]: Buffer.from(original.replace(request.search, request.replace)).toString('base64') }
        result.baselineHash = snapshotHash(files); result.candidateHash = snapshotHash(candidate)
        const reproduction = request.reproductionTest
        if (reproduction && (!safeRelative(reproduction) || !/^src\/.*\.test\.ts$/.test(reproduction) || !files[reproduction])) {
            throw new Error('Reproduction must be an existing tracked test')
        }
        const image = process.env.XAVENTRA_REPAIR_SANDBOX_IMAGE || ''
        if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('SANDBOX_UNAVAILABLE: configure a trusted local image ID')
        const info = await docker(['image', 'inspect', image])
        if (!info.ok) throw new Error('SANDBOX_UNAVAILABLE: image not installed (automatic pull disabled)')
        const metadata = JSON.parse(info.output)[0]
        if (metadata.Os !== 'linux' || metadata.Id !== image || Object.keys(metadata.Config?.Volumes || {}).length
            || metadata.Config?.Labels?.['org.xaventra.sandbox.lock-sha256'] !== hash(Buffer.from(files['package-lock.json'], 'base64'))) {
            throw new Error('Sandbox image OS, volume or lockfile contract mismatch')
        }
        result.imageId = image
        const commandTimeout = Number(process.env.XAVENTRA_REPAIR_SANDBOX_COMMAND_TIMEOUT_MS || 180_000)
        if (!Number.isInteger(commandTimeout) || commandTimeout < 1000 || commandTimeout > 180_000) throw new Error('Invalid sandbox command timeout')
        const execute = async (source: Snapshot, command: string[]) => {
            if (Date.now() - started > 900_000) throw new Error('Sandbox total budget exhausted')
            const name = `xaventra-repair-${randomUUID()}`
            let outcome: Awaited<ReturnType<typeof docker>>
            try {
                outcome = await docker(['run', '--name', name, '--pull=never', '--network=none', '--read-only',
                    '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                    '--pids-limit=128', '--memory=4g', '--memory-swap=4g', '--cpus=2',
                    '--ulimit=nofile=1024:1024', '--ipc=private', '--init', '--log-driver=none',
                    '--tmpfs=/workspace:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700',
                    '--tmpfs=/tmp:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700',
                    '--entrypoint=/usr/bin/env', '-i', image, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
                    '/usr/local/bin/node', '-e', DRIVER], JSON.stringify({ files: source, command, timeout: commandTimeout }), commandTimeout + 20_000)
                result.output = (result.output + '\n' + outcome.output).slice(-8000)
            } finally {
                const removed = await docker(['rm', '-f', name])
                const listing = await docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])
                if (!removed.ok || !listing.ok || listing.output.trim()) {
                    result.cleanupVerified = false
                    throw new Error('Sandbox cleanup could not be verified; manual reconciliation required')
                }
            }
            return outcome
        }
        for (const phase of ['baseline', 'candidate', 'rollback', 'recovery'] as const) {
            const repaired = phase === 'candidate' || phase === 'recovery'
            // Rollback reconstructs the original snapshot, never a candidate-supplied undo command.
            const source = repaired ? candidate : files
            const evidence: SandboxPhase = { phase, snapshotHash: snapshotHash(source), buildPassed: false, testsPassed: false }
            result.phases.push(evidence)
            const build = await execute(source, ['/opt/sandbox/node_modules/typescript/bin/tsc', '--noEmit'])
            evidence.buildPassed = build.ok
            // Compilation defects are repairable: retain their failed baseline,
            // require a healthy candidate, then reproduce baseline on rollback.
            if (!build.ok && (repaired || build.code !== 10)) throw new Error(`${phase}: build failed`)
            if (phase === 'rollback' && evidence.buildPassed !== result.phases[0].buildPassed) throw new Error('Rollback build differs from baseline')
            const testArgs = ['/opt/sandbox/node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2']
            if (reproduction && !repaired) testArgs.push('--exclude', reproduction)
            evidence.testsPassed = (await execute(source, testArgs)).ok
            if (!evidence.testsPassed) throw new Error(`${phase}: regression failed`)
            if (reproduction) {
                const probe = await execute(source, ['/opt/sandbox/node_modules/vitest/vitest.mjs', 'run', reproduction, '--maxWorkers=2', '--reporter=json'])
                // A timeout, syntax/import failure, missing tests or broken Docker is
                // not evidence that the original failing assertion was reproduced.
                const receipt = JSON.parse(probe.output)
                if (!receipt.numTotalTests || receipt.numRuntimeErrorTestSuites > 0
                    || (repaired ? !probe.ok || receipt.success !== true || receipt.numFailedTests !== 0
                        : probe.code !== 10 || receipt.success !== false || !receipt.numFailedTests)) {
                    throw new Error(`${phase}: missing assertion-level reproduction evidence`)
                }
                evidence.reproductionPassed = probe.ok
                if (evidence.reproductionPassed !== repaired) throw new Error(`${phase}: original symptom expectation failed`)
            }
            if (phase === 'candidate') { result.buildPassed = true; result.testsPassed = true }
            if (phase === 'rollback') result.rollbackPassed = evidence.snapshotHash === result.baselineHash
            if (phase === 'recovery') result.recoveryPassed = evidence.snapshotHash === result.candidateHash
        }
        if (snapshotHash(snapshot(request.projectRoot)) !== result.baselineHash) throw new Error('Source changed during verification')
        result.reproductionPassed = Boolean(reproduction)
        // In-process tests can be influenced by generated source (e.g. matcher
        // replacement). Only an independent original live probe can certify
        // recovery; sandbox regression must never set that stronger claim.
        result.symptomVerified = false
        result.verified = Boolean(result.rollbackPassed && result.recoveryPassed && result.cleanupVerified)
    } catch (error) {
        result.output = `${result.output}\n${error instanceof Error ? error.message : 'Sandbox failure'}`.trim().slice(-8000)
    }
    return result
}
