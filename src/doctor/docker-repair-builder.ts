import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { validatePatchInSandbox, validatePatchSnapshot, readPatchSnapshot, repairDependencyHash } from '../synthesis/patch-sandbox.js'
import { repairHash } from './repair-activation.js'
import type { RepairBuildAdapter } from './repair-publication.js'

const COMPILE = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');let input='';
process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{try{
 if(process.getuid()!==1000)throw Error('Compiler must not be root');
 const files=JSON.parse(input);for(const [file,data]of Object.entries(files)){
  const p=path.join('/workspace',file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(data,'base64'));
 }
 fs.symlinkSync('/opt/sandbox/node_modules','/workspace/node_modules');
 const r=cp.spawnSync('/usr/local/bin/node',['/opt/sandbox/node_modules/typescript/bin/tsc','--outDir','/compiled','--noEmit','false'],{
  cwd:'/workspace',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp'},encoding:'utf8',timeout:180000,killSignal:'SIGKILL',maxBuffer:1048576});
 if(r.status!==0||r.error||r.signal)throw Error('Isolated compiler failed: '+r.stdout+r.stderr);
 const result={};let size=0,count=0;function visit(dir,prefix){for(const name of fs.readdirSync(dir)){
  const file=path.join(dir,name),stat=fs.lstatSync(file),key=prefix+name;
  if(stat.isSymbolicLink()||stat.nlink>1)throw Error('Linked compiled output');
  if(stat.isDirectory())visit(file,key+'/');else if(stat.isFile()){
   size+=stat.size;if(size>67108864||++count>20000)throw Error('Compiled output budget');result[key]=fs.readFileSync(file).toString('base64');
  }else throw Error('Nonregular compiled output');
 }}visit('/compiled','dist/');process.stdout.write(JSON.stringify(result));
 }catch(e){process.stderr.write(String(e));process.exitCode=1;}});`

/** Fixed compiler/packager. No host package scripts, model shell command,
 * candidate Dockerfile, credentials, host mounts or network in compilation. */
export function createDockerRepairBuilder(options: { imageId: string; stagingRoot: string }): RepairBuildAdapter {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.imageId)) throw Error('Pinned dependency image required')
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) if (process.env[key]) env[key] = process.env[key]
    const docker = (args: string[], input?: string, timeout = 30_000): Promise<string> => new Promise((resolve, reject) => {
        const child = execFile('docker', args, { env, windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 96 * 1024 * 1024 }, (error, stdout) => error ? reject(Error(`Isolated Docker build failed (${error.code}); reconcile retained artifacts`)) : resolve(stdout))
        child.stdin?.on('error', () => undefined); child.stdin?.end(input)
    })
    return { build: async (root, patch, candidate) => {
        validatePatchSnapshot(candidate)
        if (process.env.XAVENTRA_REPAIR_SANDBOX_IMAGE !== options.imageId) throw Error('Build and sandbox dependency identity differ')
        const inspect = async (id: string) => JSON.parse(await docker(['image', 'inspect', id]))[0]
        const base = await inspect(options.imageId)
        // Dependencies remain the verified baseline lock; the deterministic
        // candidate transformation changes root versions, never dependency entries.
        const lockHash = repairDependencyHash(Buffer.from(readPatchSnapshot(root)['package-lock.json'], 'base64'))
        if (base.Id !== options.imageId || base.Os !== 'linux' || base.Config?.Labels?.['org.xaventra.sandbox.dependencies-sha256'] !== lockHash
            || Object.keys(base.Config?.Volumes || {}).length) throw Error('Trusted build image contract mismatch')
        const sandbox = await validatePatchInSandbox({ projectRoot: root, ...patch })
        if (!sandbox.verified || !sandbox.reproductionPassed) throw Error('Actual isolated regression/rollback failed')
        const name = `xaventra-compile-${randomUUID()}`
        let compiled: Record<string, string>
        try {
            const output = await docker(['run', '--name', name, '--pull=never', '--network=none', '--read-only', '--user=1000:1000',
                '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=128', '--memory=4g', '--memory-swap=4g', '--cpus=2',
                '--ipc=private', '--init', '--log-driver=none',
                '--tmpfs=/workspace:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700',
                '--tmpfs=/compiled:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700',
                '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700',
                '--entrypoint=/usr/bin/env', '-i', options.imageId, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', '/usr/local/bin/node', '-e', COMPILE], JSON.stringify(candidate), 200_000)
            compiled = JSON.parse(output)
        } finally {
            await docker(['rm', '-f', name])
            if ((await docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])).trim()) throw Error('Compiler cleanup not verified')
        }
        validatePatchSnapshot(compiled)
        if (!Object.keys(compiled).length || Object.keys(compiled).some(f => !/^dist\/.+\.(?:[cm]?js|map|json|ts)$/.test(f))) throw Error('Unexpected compiled artifact')
        // Assets are copied as data by trusted code, never by a candidate npm script.
        for (const [file, bytes] of Object.entries(candidate)) if (file.startsWith('src/dashboard/public/')) compiled[file.replace(/^src\//, 'dist/')] = bytes
        compiled['package.json'] = candidate['package.json']
        validatePatchSnapshot(compiled)
        const compiledHash = repairHash(compiled)
        mkdirSync(options.stagingRoot, { recursive: true })
        const staging = mkdtempSync(join(options.stagingRoot, 'build-')), context = join(staging, 'context'); mkdirSync(context)
        for (const [file, bytes] of Object.entries(compiled)) {
            const target = join(context, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(bytes, 'base64'), { flag: 'wx', mode: 0o444 })
        }
        const alias = `xaventra-publisher-base:${randomUUID()}`
        await docker(['tag', options.imageId, alias])
        if ((await inspect(alias)).Id !== options.imageId) throw Error('Build alias changed')
        // RUN precedes candidate COPY and executes only this fixed built-in setup.
        writeFileSync(join(context, 'Dockerfile'), `FROM ${alias}\nUSER 0:0\nWORKDIR /app\nRUN ["/usr/local/bin/node","-e","require('node:fs').symlinkSync('/opt/sandbox/node_modules','/app/node_modules')"]\nCOPY --chown=1000:1000 dist/ /app/dist/\nCOPY --chown=1000:1000 package.json /app/package.json\nUSER 1000:1000\nENTRYPOINT ["/usr/local/bin/node"]\nCMD ["/app/dist/daemon.js"]\n`)
        const idFile = join(staging, 'image-id')
        await docker(['build', '--pull=false', '--network=none', '--iidfile', idFile, context], undefined, 180_000)
        const imageId = readFileSync(idFile, 'utf8').trim(), built = await inspect(imageId)
        if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || (await inspect(alias)).Id !== options.imageId
            || JSON.stringify(built.RootFS?.Layers?.slice(0, base.RootFS?.Layers?.length)) !== JSON.stringify(base.RootFS?.Layers)
            || built.Config?.User !== '1000:1000') throw Error('Published image ancestry/confinement mismatch')
        return { imageId, baseImageId: options.imageId, compiledHash, sandbox }
    } }
}
