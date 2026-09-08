/** Real Docker acceptance, on a disposable Git fixture. No production runtime. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { validatePatchInSandbox } from '../dist/synthesis/patch-sandbox.js'

const project = process.cwd()
const output = resolve(process.env.XAVENTRA_SANDBOX_QA_DIR || '.nova-data/sandbox-qa')
mkdirSync(output, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'xaventra-sandbox-qa-'))
const canary = join(root, 'private-canary.txt')
const report = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    platform: process.platform, backend: 'real Docker Linux containers', checks: [], passed: false }
try {
    mkdirSync(join(root, 'src'))
    writeFileSync(canary, 'host must remain unchanged')
    writeFileSync(join(root, 'xaventra.config.json'), '{"private":"must-not-copy"}')
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    copyFileSync(join(project, 'package-lock.json'), join(root, 'package-lock.json'))
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true, noEmit: true }, include: ['src'] }))
    writeFileSync(join(root, 'vitest.config.ts'), `import {defineConfig} from 'vitest/config'; export default defineConfig({test:{include:['src/**/*.test.ts']}})`)
    writeFileSync(join(root, 'xaventra.config.example.json'), '{}')
    writeFileSync(join(root, 'src/value.ts'), 'export const value = 1;')
    writeFileSync(join(root, 'src/reproduce.test.ts'), `import {it,expect} from 'vitest'; import {value} from './value.js'; it('original symptom',()=>expect(value).toBe(2));`)
    writeFileSync(join(root, 'src/control.test.ts'), `
import {it,expect} from 'vitest'; import fs from 'node:fs'; import os from 'node:os'; import {value} from './value.js';
it('control',()=>expect(value).toBeGreaterThan(0));
it('confidentiality and containment',async()=>{
 expect(process.getuid()).toBe(1000);
 expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
 expect(fs.existsSync(${JSON.stringify(canary)})).toBe(false);
 expect(fs.existsSync('/workspace/xaventra.config.json')).toBe(false);
 expect(fs.existsSync('/var/run/docker.sock')).toBe(false);
 expect(()=>fs.writeFileSync('/opt/sandbox/node_modules/private-canary','x')).toThrow();
 expect(fs.readFileSync('/proc/self/status','utf8')).toMatch(/NoNewPrivs:\\s+1/);
 expect(fs.readFileSync('/proc/self/status','utf8')).toMatch(/CapBnd:\\s+0+/);
 expect(Object.keys(os.networkInterfaces())).toEqual(['lo']);
 await expect(fetch('http://192.0.2.1:80',{signal:AbortSignal.timeout(1500)})).rejects.toThrow();
});`)
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', 'src', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'xaventra.config.example.json'], { cwd: root })
    process.env.TELEGRAM_BOT_TOKEN = 'qa-host-environment-canary'
    const request = { projectRoot: root, file: 'src/value.ts', search: 'export const value = 1;', replace: 'export const value = 2;', reproductionTest: 'src/reproduce.test.ts' }
    const repaired = await validatePatchInSandbox(request)
    report.checks.push({ name: 'real regression, rollback and restoration experiment', passed: repaired.verified && repaired.reproductionPassed && !repaired.symptomVerified, evidence: repaired })
    const wholeProject = await validatePatchInSandbox({ projectRoot: project, file: 'src/synthesis/patch-sandbox.ts',
        search: '/** No host-execution fallback.', replace: '/** Verified disposable experiment. No host-execution fallback.' })
    report.checks.push({ name: 'complete source build/regression across four phases', passed: wholeProject.verified, evidence: wholeProject })
    const malicious = await validatePatchInSandbox({ ...request, replace: `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(canary)}, 'escaped'); export const value = 2;` })
    report.checks.push({ name: 'host-write attempt rejected', passed: !malicious.verified && malicious.phases?.some(p => p.phase === 'candidate') && readFileSync(canary, 'utf8') === 'host must remain unchanged', evidence: malicious })
    const forged = await validatePatchInSandbox({ ...request, replace: "import {expect} from 'vitest'; expect.extend({toBe:()=>({pass:true,message:()=>''})}); export const value = 1;" })
    report.checks.push({ name: 'test-matcher tampering cannot certify actual symptom recovery', passed: forged.verified && forged.reproductionPassed && !forged.symptomVerified, evidence: forged })
    process.env.XAVENTRA_REPAIR_SANDBOX_COMMAND_TIMEOUT_MS = '10000'
    const hanging = await validatePatchInSandbox({ ...request, replace: "process.on('SIGTERM',()=>{}); while(true){}; export const value = 2;" })
    report.checks.push({ name: 'non-cooperating candidate terminated and container removed', passed: !hanging.verified && hanging.cleanupVerified && hanging.output.includes('Sandbox command deadline exceeded') && hanging.phases?.some(p => p.phase === 'candidate' && p.buildPassed && !p.testsPassed), evidence: hanging })
    report.checks.push({ name: 'source unchanged', passed: readFileSync(join(root, 'src/value.ts'), 'utf8') === request.search })
    report.passed = report.checks.every(c => c.passed)
} catch (error) { report.error = error.message }
finally {
    // Keep evidence and failed fixture for diagnosis; no blanket cleanup of host paths.
    report.completedAt = new Date().toISOString()
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.map(({name,passed})=>({name,passed})), report: join(output, 'report.json') }))
    process.exitCode = report.passed ? 0 : 1
}
