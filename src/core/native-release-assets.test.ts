import { it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { NATIVE_CHECKSUM_ASSET, NATIVE_MANIFEST_ASSET, classifyNativeAsset, formatNativeChecksums, nativeDescriptorAsset, nativeProgramAsset,
    nativeReleaseInventory, parseNativeChecksums, verifyNativeReleaseInventory } from './native-release-assets.js'

const V = '2.79.0'
it('derives fixed descriptor and program names that the manifest name rule accepts only for descriptors',()=>{
    expect(nativeDescriptorAsset(V,'arm64')).toBe('xaventra-native-2.79.0-linux-arm64.tar.gz')
    expect(nativeProgramAsset(V,'x64')).toBe('xaventra-native-program-2.79.0-linux-x64.tar.gz')
    expect(nativeDescriptorAsset(V,'x64')).not.toBe(nativeProgramAsset(V,'x64'))
    // Same pattern github-update.ts applies to signed-manifest artifact names.
    expect(/^xaventra-[a-z0-9.-]+\.tar\.gz$/.test(nativeDescriptorAsset('2.79.0-rc.1','x64'))).toBe(true)
})
it.each([['2.79','x64'],['v2.79.0','x64'],['2.79.0','amd64'],['2.79.0','../x64'],['2.79.0/../1','arm64']])('rejects version %s / arch %s',(version,arch)=>{
    expect(()=>nativeDescriptorAsset(version,arch)).toThrow()
    expect(()=>nativeProgramAsset(version,arch)).toThrow()
})
it('orders the inventory with the manifest last and checksums before it',()=>{
    const names=nativeReleaseInventory(V)
    expect(names).toHaveLength(6)
    expect(names.at(-1)).toBe(NATIVE_MANIFEST_ASSET)
    expect(names.at(-2)).toBe(NATIVE_CHECKSUM_ASSET)
    expect(new Set(names).size).toBe(6)
})
it('classifies names strictly and leaves Docker assets alone',()=>{
    expect(classifyNativeAsset('xaventra-2.79.0-linux-x64.tar.gz')).toBeUndefined()
    expect(classifyNativeAsset('xaventra-update.json')).toBeUndefined()
    expect(classifyNativeAsset(nativeProgramAsset(V,'arm64'))).toEqual({role:'program',version:V,arch:'arm64'})
    expect(classifyNativeAsset(nativeDescriptorAsset(V,'x64'))).toEqual({role:'descriptor',version:V,arch:'x64'})
    for(const bad of ['xaventra-native-2.79.0-linux-x64.tgz','xaventra-native-program-2.79.0-darwin-x64.tar.gz','xaventra-native-2.79.0-linux-x64.tar.gz.sig','xaventra-native'])
        expect(()=>classifyNativeAsset(bad)).toThrow('Malformed')
})
it('accepts one complete native inventory beside Docker assets in any order',()=>{
    const docker=['xaventra-update.json','SHA256SUMS','xaventra-2.79.0-linux-x64.tar.gz','xaventra-2.79.0-linux-arm64.tar.gz']
    expect(verifyNativeReleaseInventory([...docker,...nativeReleaseInventory(V)].reverse(),V)).toEqual(nativeReleaseInventory(V))
})
it.each(['missing-program','missing-manifest','duplicate','extra-arch-version','foreign-version','malformed'])('rejects %s',mode=>{
    let names=nativeReleaseInventory(V)
    if(mode==='missing-program')names=names.filter(n=>n!==nativeProgramAsset(V,'x64'))
    if(mode==='missing-manifest')names=names.filter(n=>n!==NATIVE_MANIFEST_ASSET)
    if(mode==='duplicate')names=[...names,nativeProgramAsset(V,'arm64')]
    if(mode==='extra-arch-version')names=[...names,nativeProgramAsset('2.79.1','arm64')]
    if(mode==='foreign-version')names=names.map(n=>n===nativeDescriptorAsset(V,'x64')?nativeDescriptorAsset('2.78.0','x64'):n)
    if(mode==='malformed')names=[...names,'xaventra-native-2.79.0-linux-x64.zip']
    expect(()=>verifyNativeReleaseInventory(names,V)).toThrow()
})
it('round-trips the checksum file and rejects any deviation',()=>{
    const hashOf=(n:string)=>createHash('sha256').update(n).digest('hex')
    const text=formatNativeChecksums(V,hashOf),sums=parseNativeChecksums(text,V)
    expect([...sums.keys()]).toEqual(nativeReleaseInventory(V).slice(0,4))
    for(const [name,hash] of sums)expect(hash).toBe(hashOf(name))
    const lines=text.trimEnd().split('\n')
    for(const bad of [text.replace(/\n/g,'\r\n'),text.slice(0,-1),lines.slice(1).join('\n')+'\n',[...lines,lines[0]].join('\n')+'\n',
        [lines[1],lines[0],...lines.slice(2)].join('\n')+'\n',text.replace(/^[a-f0-9]/,'G'),text.replace('  ',' ')])
        expect(()=>parseNativeChecksums(bad,V)).toThrow()
    expect(()=>formatNativeChecksums(V,()=>'x')).toThrow()
})
