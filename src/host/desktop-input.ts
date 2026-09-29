import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function desktopInputArgs(value: any): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid desktop action')
    const fields: Record<string,string[]> = { move:['action','x','y'],click:['action','x','y','button'],type:['action','text'],key:['action','key'],scroll:['action','direction','amount'] }
    if (!Object.hasOwn(fields,value.action) || Object.keys(value).some(k=>!fields[value.action].includes(k))) throw Error('Unsupported desktop action')
    if (['move','click'].includes(value.action)) {
        if (![value.x,value.y].every(n=>Number.isInteger(n)&&n>=0&&n<=32767)) throw Error('Invalid desktop coordinates')
        const args=['mousemove','--sync',String(value.x),String(value.y)]
        if(value.action==='click') { if(!['left','middle','right'].includes(value.button))throw Error('Invalid button');args.push('click',String({left:1,middle:2,right:3}[value.button])) }
        return args
    }
    if(value.action==='type') { if(typeof value.text!=='string'||!value.text.length||value.text.length>2000||/[\x00-\x1f\x7f]/.test(value.text))throw Error('Invalid text');return ['type','--clearmodifiers','--delay','1','--',value.text] }
    if(value.action==='key') { if(typeof value.key!=='string'||! /^(?:(?:ctrl|alt|shift|super)\+){0,3}(?:[a-z0-9]|Return|Escape|Tab|BackSpace|Delete|Home|End|Left|Right|Up|Down|Page_Up|Page_Down|space|F(?:[1-9]|1[0-2]))$/.test(value.key))throw Error('Invalid key');return ['key','--clearmodifiers',value.key] }
    if(!['up','down'].includes(value.direction)||!Number.isInteger(value.amount)||value.amount<1||value.amount>20)throw Error('Invalid scroll')
    return ['click','--repeat',String(value.amount),'--delay','50',value.direction==='up'?'4':'5']
}

/** Intent is durable BEFORE input. An uncertain effect is never repeated. */
export async function executeDesktopInputOnce(root:string,requestId:string,action:unknown,execute:(args:string[])=>Promise<void>) {
    if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error('Invalid input request ID')
    const args=desktopInputArgs(action), hash=createHash('sha256').update(JSON.stringify(action)).digest('hex')
    mkdirSync(root,{recursive:true,mode:0o700})
    const file=join(root,requestId+'.json')
    if(existsSync(file)) { const prior=JSON.parse(readFileSync(file,'utf8'));if(prior.hash!==hash||prior.status!=='completed')throw Error('Desktop input uncertain or request conflict; no replay');return {...prior,replayed:true} }
    const fd=openSync(file,'wx',0o600)
    try {writeFileSync(fd,JSON.stringify({requestId,hash,status:'intent'}));fsyncSync(fd)}finally{closeSync(fd)}
    if(process.platform!=='win32'){const dir=openSync(root,'r');try{fsyncSync(dir)}finally{closeSync(dir)}}
    await execute(args)
    const result={requestId,hash,status:'completed',replayed:false}
    const done=openSync(file,'w',0o600);try{writeFileSync(done,JSON.stringify(result));fsyncSync(done)}finally{closeSync(done)}
    return result
}
export async function runDesktopInput(args:string[]) {
    if(process.platform!=='linux'||!process.env.DISPLAY||process.env.XDG_SESSION_TYPE!=='x11')throw Error('Enrolled X11 session required')
    await promisify(execFile)('/usr/bin/xdotool',args,{timeout:10000,maxBuffer:4096})
}
