import { it,expect } from 'vitest'
import { readFileSync } from 'node:fs'
const read=(path:string)=>readFileSync(new URL('../../'+path,import.meta.url),'utf8')
it('keeps the actual Playwright browser provider without the unrelated Tint package',()=>{
    const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'))
    expect(pkg.dependencies.playwright).toBeTruthy()
    expect(lock.packages['node_modules/playwright']).toBeTruthy()
    expect(pkg.dependencies.chromium).toBeUndefined()
    expect(lock.packages[''].dependencies.chromium).toBeUndefined()
    expect(lock.packages['node_modules/chromium']).toBeUndefined()
    for(const path of ['src/tools/browser.ts','src/tools/google-search.ts'])expect(read(path)).toContain("import('playwright')")
    expect(read('scripts/setup.mjs')).toContain("'playwright', 'install', 'chromium'")
})
