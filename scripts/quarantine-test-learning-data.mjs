import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const quarantine = join(root, '.nova-data', 'quarantine', `learning-test-data-${stamp}`)

const targets = [
    {
        file: join(root, '.nova-data', 'self-rules.json'),
        isTest: item => /test pattern xyz|always do x for test/i.test(`${item?.pattern || ''} ${item?.rule || ''}`),
    },
    {
        file: join(root, '.nova-data', 'instincts', 'active-instincts.json'),
        isTest: item => /^(test|stark)-trigger$/i.test(String(item?.trigger || '')) || /^(test|stark)-rule/i.test(String(item?.rule || '')),
    },
    {
        file: join(root, '.nova-learning', 'learned-solutions.json'),
        isTest: item => /^(how to parse json|test problem abc)$/i.test(String(item?.problem || '').trim()),
    },
    {
        file: join(root, '.nova-data', 'learned-solutions.json'),
        isTest: item => /^(how to parse json|test problem abc)$/i.test(String(item?.problem || '').trim()),
    },
]

mkdirSync(quarantine, { recursive: true })
const report = []
for (const target of targets) {
    if (!existsSync(target.file)) continue
    const data = JSON.parse(readFileSync(target.file, 'utf-8'))
    if (!Array.isArray(data)) continue
    const kept = data.filter(item => !target.isTest(item))
    const removed = data.filter(target.isTest)
    const backupName = target.file.includes('.nova-learning')
        ? `nova-learning-${basename(target.file)}`
        : target.file.includes('instincts')
            ? `instincts-${basename(target.file)}`
            : basename(target.file)
    copyFileSync(target.file, join(quarantine, backupName))
    writeFileSync(target.file, JSON.stringify(kept, null, 2) + '\n', 'utf-8')
    report.push({ file: target.file, before: data.length, removed: removed.length, after: kept.length })
}

writeFileSync(join(quarantine, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8')
console.log(JSON.stringify({ quarantine, report }, null, 2))

