import { lstatSync,realpathSync,readlinkSync,readFileSync,writeFileSync,renameSync } from 'node:fs'
import { resolve,dirname,relative,sep,join } from 'node:path'
/** Only for a disposable build stage. Never call against installed runtimes.
 * Explicit bin paths come from the stage inventory. Other symlinks still reject.
 * Preserve the original target location so relative module imports keep working. */
export function materializeNativeBin(stage:string,bin:string):{path:string;target:string;mode:0o755}{
    if(process.platform!=='linux')throw Error('Native bin staging requires Linux')
    stage=resolve(stage)
    if(realpathSync(stage)!==stage)throw Error('Native stage root linked')
    if(!/^node_modules\/(?:[A-Za-z0-9_@.+-]+\/)*\.bin\/[A-Za-z0-9_.+-]+$/.test(bin)||bin.split('/').some(p=>p==='.'||p==='..'))throw Error('Native bin path invalid')
    const path=resolve(stage,bin),parent=dirname(path),modules=dirname(parent)
    if(!parent.startsWith(stage+sep)||realpathSync(parent)!==parent||!lstatSync(path).isSymbolicLink())throw Error('Native bin must be an explicit stage symlink')
    const link=readlinkSync(path),target=resolve(parent,link)
    if(target===modules||!target.startsWith(modules+sep)||realpathSync(target)!==target)throw Error('Native bin target escapes or is linked')
    const s=lstatSync(target)
    if(!s.isFile()||s.nlink!==1||!(s.mode&0o111)||s.mode&0o6022)throw Error('Native bin target not a safe executable')
    const rel=relative(modules,target).split(sep).join('/'),parts=rel.split('/')
    const packageParts=parts[0].startsWith('@')?2:1
    if(parts.length<=packageParts)throw Error('Native bin package target missing')
    const packageRoot=join(modules,...parts.slice(0,packageParts)),manifestPath=join(packageRoot,'package.json')
    const ms=lstatSync(manifestPath)
    if(!ms.isFile()||ms.size>1024*1024||realpathSync(manifestPath)!==manifestPath)throw Error('Native bin package metadata invalid')
    const pkg=JSON.parse(readFileSync(manifestPath,'utf8')),name=bin.split('/').at(-1)!
    const declarations=typeof pkg.bin==='string'?{[String(pkg.name).split('/').at(-1)!]:pkg.bin}:pkg.bin
    if(!declarations||!Object.hasOwn(declarations,name)||typeof declarations[name]!=='string'||resolve(packageRoot,declarations[name])!==target)throw Error('Native bin not declared by package')
    const targetRelative=relative(parent,target).split(sep).join('/')
    if(!/^[A-Za-z0-9_@.+/-]+$/.test(targetRelative))throw Error('Native bin target cannot be represented safely')
    const shim=`#!/bin/sh\nexec "$(dirname -- "$0")"/'${targetRelative}' "$@"\n`
    const temp=path+'.native-stage.tmp'
    writeFileSync(temp,shim,{flag:'wx',mode:0o755})
    // Fail closed on a changed link; never overwrite a runtime or regular file.
    if(!lstatSync(path).isSymbolicLink()||readlinkSync(path)!==link)throw Error('Native bin changed during staging')
    renameSync(temp,path)
    return {path:bin,target:relative(stage,target).split(sep).join('/'),mode:0o755}
}
