import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface PatchSandboxRequest {
    projectRoot: string
    file: string
    search: string
    replace: string
}

export interface PatchSandboxResult {
    verified: boolean
    buildPassed: boolean
    testsPassed: boolean
    output: string
}

function run(root: string, executable: string, args: string[], timeout: number) {
    const result = spawnSync(executable, args, {
        cwd: root,
        encoding: 'utf-8',
        timeout,
        windowsHide: true,
        env: { ...process.env, NOVA_RUNTIME_ROOT: join(root, '.runtime'), NOVA_TEST_MODE: '1' },
    })
    return {
        ok: result.status === 0,
        output: `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`.trim().slice(-8000),
    }
}

/** Validate a proposed source change without touching the live working tree. */
export function validatePatchInSandbox(request: PatchSandboxRequest): PatchSandboxResult {
    const sandboxRoot = join(request.projectRoot, '.nova-test-tmp', 'patch-sandboxes')
    mkdirSync(sandboxRoot, { recursive: true })
    const sandbox = mkdtempSync(join(sandboxRoot, 'nova-patch-sandbox-'))
    try {
        for (const entry of ['src', 'test']) {
            const source = join(request.projectRoot, entry)
            if (existsSync(source)) cpSync(source, join(sandbox, entry), { recursive: true })
        }
        for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'xaventra.config.json']) {
            const source = join(request.projectRoot, file)
            if (existsSync(source)) cpSync(source, join(sandbox, file))
        }
        const dependencies = join(request.projectRoot, 'node_modules')
        if (!existsSync(dependencies)) {
            return { verified: false, buildPassed: false, testsPassed: false, output: 'node_modules missing' }
        }
        symlinkSync(dependencies, join(sandbox, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')

        const target = join(sandbox, request.file)
        mkdirSync(dirname(target), { recursive: true })
        const original = readFileSync(target, 'utf-8')
        if (!original.includes(request.search)) {
            return { verified: false, buildPassed: false, testsPassed: false, output: 'search text missing in sandbox' }
        }
        writeFileSync(target, original.replace(request.search, request.replace), 'utf-8')

        const tsc = join(sandbox, 'node_modules', 'typescript', 'bin', 'tsc')
        const build = run(sandbox, process.execPath, [tsc, '--noEmit'], 120_000)
        if (!build.ok) return { verified: false, buildPassed: false, testsPassed: false, output: build.output }

        const vitest = join(sandbox, 'node_modules', 'vitest', 'vitest.mjs')
        const tests = run(sandbox, process.execPath, [vitest, 'run', '--passWithNoTests'], 180_000)
        return {
            verified: build.ok && tests.ok,
            buildPassed: build.ok,
            testsPassed: tests.ok,
            output: `${build.output}\n${tests.output}`.trim().slice(-8000),
        }
    } catch (error) {
        return { verified: false, buildPassed: false, testsPassed: false, output: String(error) }
    } finally {
        try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* best effort */ }
    }
}
