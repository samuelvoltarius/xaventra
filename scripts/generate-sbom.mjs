import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const lockPath = resolve(root, 'package-lock.json')
const outputPath = resolve(root, 'SBOM.cdx.json')
const lockText = readFileSync(lockPath, 'utf8')
const lock = JSON.parse(lockText)

function packageName(path, entry) {
    if (entry.name) return entry.name
    const marker = 'node_modules/'
    const offset = path.lastIndexOf(marker)
    return offset >= 0 ? path.slice(offset + marker.length) : lock.name || '@xaventra/core'
}

function licenseEntries(expression) {
    if (!expression) return [{ license: { name: 'NOASSERTION' } }]
    return [{ expression }]
}

const components = Object.entries(lock.packages || {})
    .filter(([path]) => path !== '')
    .map(([path, entry]) => {
        const name = packageName(path, entry)
        const version = entry.version || '0.0.0-unknown'
        return {
            type: 'library',
            'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}?path=${encodeURIComponent(path)}`,
            name,
            version,
            licenses: licenseEntries(entry.license),
            purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
            properties: [{ name: 'xaventra:lockfile-path', value: path }],
        }
    })
    .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']))

const lockHash = createHash('sha256').update(lockText).digest('hex')
const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${lockHash.slice(0, 8)}-${lockHash.slice(8, 12)}-4${lockHash.slice(13, 16)}-a${lockHash.slice(17, 20)}-${lockHash.slice(20, 32)}`,
    version: 1,
    metadata: {
        component: {
            type: 'application',
            name: lock.name || '@xaventra/core',
            version: lock.version || '0.0.0-unknown',
            licenses: [{ license: { id: 'MIT' } }],
        },
        properties: [{ name: 'xaventra:package-lock-sha256', value: lockHash }],
    },
    components,
}

writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`, 'utf8')
console.log(`Wrote ${components.length} components to ${outputPath}`)
