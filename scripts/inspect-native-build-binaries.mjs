// Read-only diagnostic against an existing generated build inventory.
import { validateNativeBinaryHeader } from '../src/core/native-build-qualification.ts'
import { readFileSync,openSync,readSync,closeSync } from 'node:fs'
import { join } from 'node:path'
const root=process.argv[2],inventory=JSON.parse(readFileSync(join(root,'inventory.json'),'utf8')),failures=[]
for(const f of inventory.files){
    if(f.path.includes('..')||f.path.startsWith('/')||f.path.includes('\\'))throw Error('Unsafe inventory path')
    const fd=openSync(join(root,'payload',f.path),'r'),b=Buffer.alloc(64);let n
    try{n=readSync(fd,b,0,64,0)}finally{closeSync(fd)}
    try{validateNativeBinaryHeader(f.path,b.subarray(0,n),inventory.arch)}catch(e){failures.push({path:f.path,error:e.message})}
}
const restrictedPaths=inventory.files.filter(f=>f.path.split('/').some(p=>/^\.(?:env|nova)/i.test(p)||(/^\.git/i.test(p)&&!(f.path.startsWith('node_modules/')&&/^\.(?:github|gitkeep|gitattributes|gitignore|gitmodules)$/i.test(p)))||/^(?:PROJECT_MEMORY\.md|(?:nova|xaventra)\.config\.json)$/i.test(p)||/\.(?:pem|key|p12|pfx)$/i.test(p))).map(f=>f.path)
console.log(JSON.stringify({arch:inventory.arch,files:inventory.files.length,failures,restrictedPaths}))
