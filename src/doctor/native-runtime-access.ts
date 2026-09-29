import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export interface NativeRuntimeAccount { uid:number; gid:number }
// Fixed observer only: never imports/executes a file from the candidate tree.
const observer=`
const fs=require('node:fs'),path=require('node:path');
process.setgroups([]);process.setgid(Number(process.argv[3]));process.setuid(Number(process.argv[2]));
let count=0;const deadline=Date.now()+55000;
function visit(p,depth){
 if(depth>64||++count>100000||Date.now()>deadline)throw Error('access budget exceeded');
 const s=fs.lstatSync(p);
 if(s.isSymbolicLink())throw Error('linked program path');
 if(s.isDirectory()){fs.accessSync(p,fs.constants.R_OK|fs.constants.X_OK);for(const n of fs.readdirSync(p))visit(path.join(p,n),depth+1);}
 else if(s.isFile())fs.accessSync(p,fs.constants.R_OK);
 else throw Error('unsupported program path');
}
visit(process.argv[1],0);process.stdout.write('readable');
`
/** Supplementary groups are cleared; no candidate code or configuration runs.
 * This is DAC readability, not systemd sandbox/SELinux or runtime readiness. */
export function verifyNativeRuntimeAccess(root:string,account:NativeRuntimeAccount):void{
    if(!account||![account.uid,account.gid].every(n=>Number.isSafeInteger(n)&&n>0&&n<0xffffffff))throw Error('Unprivileged native runtime account required')
    if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Native runtime access observer requires Linux root')
    const result=execFileSync(process.execPath,['-e',observer,resolve(root),String(account.uid),String(account.gid)],{
        timeout:60000,maxBuffer:8192,encoding:'utf8',env:{},stdio:['ignore','pipe','pipe'],
    })
    if(result!=='readable')throw Error('Native runtime access proof missing')
}
