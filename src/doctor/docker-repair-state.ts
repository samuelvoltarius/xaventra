import { randomUUID } from 'node:crypto'
import type { DockerRepairEngine } from './docker-repair-driver.js'
import type { RepairTicket } from './repair-activation.js'

/** Executes only in a trusted, digest-pinned helper, never in the candidate.
 * Reject links/special files rather than following application-controlled paths.
 * Comparison includes directory/file modes and all content, not just filenames. */
const COPY = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
if(fs.readdirSync('/destination').length)throw Error('Destination must be empty');
function walk(root,copy){const entries=[];let bytes=0,count=0;
 function visit(relative){const full=path.join(root,relative),s=fs.lstatSync(full);
  if(++count>limits.maxEntries||s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory())||s.isFile()&&s.nlink!==1)throw Error('Unsupported state entry');
  if(s.isDirectory()){
   if(copy&&relative){fs.mkdirSync(path.join('/destination',relative));fs.chmodSync(path.join('/destination',relative),s.mode&511);}
   entries.push([relative,'directory',s.mode&511]);
   for(const name of fs.readdirSync(full).sort())visit(path.join(relative,name));
  }else{
   bytes+=s.size;if(bytes>limits.maxBytes||s.size>limits.maxFileBytes)throw Error('State copy budget exceeded');
   const input=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   let output;const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);let total=0;
   try{
    const opened=fs.fstatSync(input);
    if(!opened.isFile()||opened.nlink!==1||opened.ino!==s.ino||opened.dev!==s.dev||opened.size!==s.size)throw Error('State entry changed');
    if(copy)output=fs.openSync(path.join('/destination',relative),'wx',s.mode&511);
    for(;;){const n=fs.readSync(input,buffer,0,buffer.length,null);if(!n)break;
     total+=n;if(total>s.size)throw Error('State entry changed');hash.update(buffer.subarray(0,n));
     if(copy){let offset=0;while(offset<n){const written=fs.writeSync(output,buffer,offset,n-offset,null);if(!written)throw Error('State write stalled');offset+=written;}}
    }
    const after=fs.fstatSync(input);
    if(total!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs)throw Error('State entry changed');
    if(copy){fs.fchmodSync(output,s.mode&511);fs.fsyncSync(output);}
   }finally{fs.closeSync(input);if(output!==undefined)fs.closeSync(output);}
   entries.push([relative,'file',s.mode&511,hash.digest('hex')]);
  }
 }
 visit('');return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
fs.chmodSync('/destination',fs.statSync('/source').mode&511);
const original=walk('/source',true),copied=walk('/destination',false),unchanged=walk('/source',false);
if(original!==copied||original!==unchanged)throw Error('State snapshot mismatch');
`

export interface RepairStateCopyLimits {
    maxBytes?: number
    maxFileBytes?: number
    maxEntries?: number
    timeoutMs?: number
}

/** Operator-owned enrollment only. Defaults stay conservative; never accept
 * these budgets from an application request, release package or tool argument. */
export function createRepairStateCopyScript(limits: RepairStateCopyLimits = {}): string {
    const values = { maxBytes: limits.maxBytes ?? 8 * 1024 ** 3,
        maxFileBytes: limits.maxFileBytes ?? 128 * 1024 ** 2,
        maxEntries: limits.maxEntries ?? 100_000, timeoutMs: limits.timeoutMs ?? 120_000 }
    for (const [key, maximum] of Object.entries({ maxBytes: 32 * 1024 ** 3,
        maxFileBytes: 32 * 1024 ** 3, maxEntries: 100_000, timeoutMs: 540_000 })) {
        if (!Number.isSafeInteger(values[key]) || values[key] <= 0 || values[key] > maximum) throw new Error(`Invalid state copy limit: ${key}`)
    }
    if (values.maxFileBytes > values.maxBytes) throw new Error('File budget exceeds snapshot budget')
    return `const limits=${JSON.stringify(values)};\n${COPY}`
}

/** Local state clone is only one part of state readiness. The separate authority
 * must also attest that shared/external writers and in-flight tasks are quiesced.
 * Missing or stale quiescence fails closed; local copy never implies Mesh safety. */
export function createDockerRepairStateCloner(options: { engine: DockerRepairEngine; helperImageId: string; limits?: RepairStateCopyLimits;
    quiescent(ticket: RepairTicket): Promise<boolean> }): (oldId: string, nextId: string, ticket: RepairTicket) => Promise<boolean> {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.helperImageId)) throw new Error('Pinned state-helper image required')
    const script = createRepairStateCopyScript(options.limits)
    const timeoutMs = options.limits?.timeoutMs ?? 120_000
    const engine = options.engine
    return async (oldId, nextId, ticket) => {
        const inspect = (id: string) => engine.call('GET', `/containers/${id}/json`)
        const stopped = (info: any) => !info.State?.Running && !info.State?.Paused && !info.State?.Restarting
        const old = await inspect(oldId), next = await inspect(nextId)
        if (old.Id !== oldId || next.Id !== nextId || !stopped(old) || !stopped(next) || !await options.quiescent(ticket)) return false
        if (!/^[1-9][0-9]*(?::[1-9][0-9]*)?$/.test(old.Config?.User || '') || old.Config.User !== next.Config?.User) return false
        const writes = (info: any) => (info.Mounts || []).filter((m: any) => m.RW && m.Type !== 'tmpfs')
        const source = writes(old), destinations = writes(next)
        if (!source.length || source.length !== destinations.length || source.some((s: any) => s.Type !== 'volume')) return false
        for (const mount of source) {
            const destination = destinations.find((m: any) => m.Destination === mount.Destination)
            if (!destination || destination.Type !== 'volume' || destination.Name === mount.Name
                || ![mount.Name, destination.Name].every(name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name))) return false
            const helper = await engine.call('POST', `/containers/create?name=xaventra-state-${randomUUID()}`, {
                Image: options.helperImageId, User: old.Config.User, Entrypoint: ['/usr/local/bin/node'], Cmd: ['-e', script],
                Env: ['PATH=/usr/local/bin:/usr/bin:/bin'], Labels: { 'xaventra.repair-state-helper': ticket.attemptId },
                HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
                    Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 32, RestartPolicy: { Name: 'no' },
                    LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
                    Mounts: [{ Type: 'volume', Source: mount.Name, Target: '/source', ReadOnly: true },
                        { Type: 'volume', Source: destination.Name, Target: '/destination' }] },
            })
            if (!/^[a-f0-9]{64}$/.test(helper?.Id)) throw new Error('State helper identity unavailable; reconcile before retry')
            let success = false
            try {
                await engine.call('POST', `/containers/${helper.Id}/start`)
                const deadline = Date.now() + timeoutMs
                while (Date.now() < deadline) {
                    const state = await inspect(helper.Id)
                    if (!state.State.Running) { success = state.State.ExitCode === 0; break }
                    await new Promise(resolve => setTimeout(resolve, 200))
                }
            } finally {
                const state = await inspect(helper.Id)
                if (state.State.Running) await engine.call('POST', `/containers/${helper.Id}/kill?signal=SIGKILL`)
                if ((await inspect(helper.Id)).State.Running) throw new Error('State helper cleanup unverified')
                await engine.call('DELETE', `/containers/${helper.Id}`)
            }
            if (!success) return false // Partial candidate volumes are retained, never reused silently.
        }
        return stopped(await inspect(oldId)) && stopped(await inspect(nextId)) && await options.quiescent(ticket)
    }
}
