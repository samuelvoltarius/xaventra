import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertTrustedBrowser, type PathFacts } from './workstation-security.js'

/** A workstation action refused for certain before anything ran or was journaled:
 * the caller may report "nothing happened" and must not retry it unchanged. */
export class DesktopActionRefused extends Error {
    constructor(reason: string) { super(`Desktop action refused: ${reason}`); this.name = 'DesktopActionRefused' }
}

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
    if(value.action==='key') { if(typeof value.key!=='string'||! /^(?:(?:ctrl|alt|shift|super)\+){0,3}(?:[a-z0-9]|Return|Escape|Tab|BackSpace|Delete|Home|End|Left|Right|Up|Down|Page_Up|Page_Down|space|F(?:[1-9]|1[0-2]))$/.test(value.key))throw Error('Invalid key');if(isSessionCriticalKey(value.key))throw Error('Session-critical key combination refused');return ['key','--clearmodifiers',value.key] }
    if(!['up','down'].includes(value.direction)||!Number.isInteger(value.amount)||value.amount<1||value.amount>20)throw Error('Invalid scroll')
    return ['click','--repeat',String(value.amount),'--delay','50',value.direction==='up'?'4':'5']
}

/** Hosts that are never public web pages: local names, tailnet, IP literals.
 * The workstation firewall blocks private networks too; this is the first fence. */
const NON_PUBLIC_HOST=/^(?:localhost|.*\.(?:localhost|local|internal|lan|home|arpa|ts\.net))$/i
/** Workstation plan: every xdotool action plus open_url (a public http(s) page
 * in the workstation browser). Only the dedicated workstation passes this plan. */
export function desktopActionArgs(value: any): string[] {
    if (value?.action!=='open_url') return desktopInputArgs(value)
    if (Object.keys(value).some(k=>!['action','url'].includes(k))||typeof value.url!=='string'||!value.url.length||value.url.length>2000) throw Error('Invalid open_url')
    let url: URL
    try { url=new URL(value.url) } catch { throw Error('Invalid open_url') }
    const host=url.hostname
    if (!['https:','http:'].includes(url.protocol)||url.username||url.password||!host||host.includes(':')||host.startsWith('[')
        ||/^[0-9.]+$/.test(host)||NON_PUBLIC_HOST.test(host)||!host.includes('.')) throw Error('open_url only for public http(s) host names')
    return ['open_url',url.href]
}
/** Operator allowlist (comma-separated host names; a name also covers its subdomains). Empty = nothing allowed. */
export function assertOpenUrlAllowed(href: string, allowList: string|undefined): void {
    const host=new URL(href).hostname.toLowerCase()
    const allowed=String(allowList||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
    if (!allowed.some(entry=>host===entry||host.endsWith('.'+entry))) throw Error(`nicht auf der Erlaubnisliste: ${host}`)
}

/** Everything that can refuse an action for certain, checked BEFORE the journal intent:
 * typed action, and for open_url the operator allowlist and the operator browser. */
export function precheckWorkstationAction(action: unknown, options: { allowList?: string; browser: string; stat: (path: string) => PathFacts }): string[] {
    let args: string[]
    try { args = desktopActionArgs(action) } catch (error) { throw new DesktopActionRefused(error instanceof Error ? error.message : String(error)) }
    if (args[0] !== 'open_url') return args
    try { assertOpenUrlAllowed(args[1], options.allowList) } catch (error) { throw new DesktopActionRefused(error instanceof Error ? error.message : String(error)) }
    if (!options.browser.startsWith('/')) throw new DesktopActionRefused('kein Browser für den Arbeitsplatz eingerichtet')
    try { assertTrustedBrowser(options.browser, options.stat(options.browser)) } catch { throw new DesktopActionRefused('Browser des Arbeitsplatzes fehlt oder ist nicht vertrauenswürdig') }
    return args
}

/** Combos that end, lock or switch away from the X session (server zap,
 * three-finger salute, screen lock, VT switch). alt+F4 stays allowed. */
function isSessionCriticalKey(key:string):boolean {
    const parts=key.split('+'),base=parts.pop()!,mods=new Set(parts)
    if(mods.has('ctrl')&&mods.has('alt')&&(base==='Delete'||base==='BackSpace'||/^F(?:[1-9]|1[0-2])$/.test(base)))return true
    return mods.has('super')&&base==='l'
}

/** Intent is durable BEFORE input. An uncertain effect is never repeated. */
export async function executeDesktopInputOnce(root:string,requestId:string,action:unknown,execute:(args:string[])=>Promise<void>,plan:(action:any)=>string[]=desktopInputArgs) {
    if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error('Invalid input request ID')
    const args=plan(action), hash=createHash('sha256').update(JSON.stringify(action)).digest('hex')
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
    if(args[0]==='open_url')throw Error('open_url needs the workstation browser, not xdotool')
    await promisify(execFile)('/usr/bin/xdotool',args,{timeout:10000,maxBuffer:4096})
}
