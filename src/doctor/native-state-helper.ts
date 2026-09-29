import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { protectControllerDirectory } from './repair-controller-files.js'
import { linuxProcessIdentityReader } from './native-process-identity.js'
import { createNativeStateCopyScript, createNativeStateHashScript, type RepairStateCopyLimits } from './docker-repair-state.js'

export interface NativeStateHelperProfile {
    node: string; nodeHash: string; setprivHash: string; uid: number; gid: number
    source: string; destination: string; limits?: RepairStateCopyLimits
}
/** Fixed operator-enrolled helper, not a general shell/code execution tool.
 * Only trusted generated copy/hash code is accepted. The snapshot store must
 * independently hold authority, stopped-writer and filesystem fences. */
export class NativeStateHelper {
    private profile: NativeStateHelperProfile
    constructor(profile: NativeStateHelperProfile) {
        this.profile = structuredClone(profile)
        const p = this.profile
        createNativeStateCopyScript(p.source, p.destination, p.limits)
        if (!p.node.startsWith('/') || ![p.nodeHash,p.setprivHash].every(h => /^[a-f0-9]{64}$/.test(h))
            || ![p.uid,p.gid].every(n => Number.isSafeInteger(n) && n > 0 && n < 4294967295)) throw Error('Invalid native helper enrollment')
    }
    private async binary(path: string, expected: string) {
        protectControllerDirectory(dirname(path))
        const s = await lstat(path)
        if (await realpath(path) !== path || !s.isFile() || s.nlink !== 1 || s.uid !== 0 || (s.mode & 0o6022)
            || !(s.mode & 0o111) || await linuxProcessIdentityReader.hash(path) !== expected) throw Error('Native helper executable identity mismatch')
    }
    private async statePath(path: string) {
        protectControllerDirectory(dirname(path))
        const s = await lstat(path)
        if (await realpath(path) !== path || !s.isDirectory() || s.uid !== this.profile.uid || s.gid !== this.profile.gid) throw Error('Native helper state path mismatch')
    }
    private async run(script: string): Promise<any> {
        if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('Root Linux controller required')
        const p = this.profile
        await this.binary('/usr/bin/setpriv', p.setprivHash); await this.binary(p.node, p.nodeHash)
        await this.statePath(p.source); await this.statePath(p.destination)
        // Node may include the effective GID even with an empty supplementary
        // group list. Reject every group other than that enrolled primary GID.
        script = `if(process.getuid()!==${p.uid}||process.getgid()!==${p.gid}||process.getgroups().some(g=>g!==${p.gid}))throw Error('Helper identity mismatch');\n` + script
        // setpriv execs Node; SIGKILL terminates this single trusted non-spawning
        // process on timeout/overflow. No inherited NODE_OPTIONS/LD_* or tokens.
        const result: string = await new Promise((resolve, reject) => {
            execFile('/usr/bin/setpriv', ['--reuid',String(p.uid),'--regid',String(p.gid),'--clear-groups','--no-new-privs','--',p.node,'-e',script],
                { cwd:'/', env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}, timeout:p.limits?.timeoutMs ?? 120000,
                    maxBuffer:16384, killSignal:'SIGKILL', encoding:'utf8' },
                (error, stdout) => error ? reject(Error('Native state helper failed; snapshot remains unverified')) : resolve(stdout))
        })
        await this.binary('/usr/bin/setpriv', p.setprivHash); await this.binary(p.node, p.nodeHash)
        await this.statePath(p.source); await this.statePath(p.destination)
        return JSON.parse(result)
    }
    async copy(): Promise<{sourceHash:string;copyHash:string;sourceAfterHash:string}> {
        const p=this.profile, result=await this.run(createNativeStateCopyScript(p.source,p.destination,p.limits))
        if (!result || Object.keys(result).sort().join(',') !== 'copyHash,sourceAfterHash,sourceHash'
            || !/^[a-f0-9]{64}$/.test(result.sourceHash) || result.sourceHash!==result.copyHash || result.sourceHash!==result.sourceAfterHash) throw Error('Invalid native copy evidence')
        return result
    }
    async hash(path: string): Promise<string> {
        if (path!==this.profile.source && path!==this.profile.destination) throw Error('Unenrolled native state path')
        const result=await this.run(createNativeStateHashScript(path,this.profile.limits))
        if (!result || Object.keys(result).join(',')!=='hash' || !/^[a-f0-9]{64}$/.test(result.hash)) throw Error('Invalid native hash evidence')
        return result.hash
    }
}
