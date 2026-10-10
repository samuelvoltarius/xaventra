// Rejects internal infrastructure values in tracked files.
//
// Two rules, neither of which needs a real value inside this repository:
//  1. Generic: tailnet/CGNAT addresses (100.64.0.0/10) may only appear from the
//     placeholder block 100.64.0.0/16, the upper-boundary block 100.127.0.0/16
//     or as Tailscale's well-known 100.100.100.100. Real tailnet hosts are
//     spread across the whole /10, so anything else is treated as a leak.
//  2. Private denylist: literal strings (case-insensitive) or `re:<regex>` lines
//     from XAVENTRA_LEAK_DENYLIST (newline-separated, e.g. a CI secret) and the
//     untracked file named by XAVENTRA_LEAK_DENYLIST_FILE (default
//     .leak-denylist). Findings name only the entry number, never the value.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SKIP = [/(^|\/)package-lock\.json$/, /(^|\/)SBOM\.cdx\.json$/, /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|tgz|wasm|node|exe|dll|so|dylib)$/i]
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g

export function isLeakedTailnetAddress(text) {
    const [a, b, c, d] = text.split('.').map(Number)
    if ([a, b, c, d].some(part => part > 255)) return false
    if (a !== 100 || b < 64 || b > 127) return false
    if (b === 64 || b === 127) return false
    return !(b === 100 && c === 100 && d === 100)
}

export function parseDenylist(source) {
    return String(source || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
        .map((line, index) => {
            if (!line.startsWith('re:')) return line.toLowerCase()
            try { return new RegExp(line.slice(3), 'i') }
            catch { throw new Error(`Invalid private denylist expression at entry #${index + 1}`) }
        })
}

export function scanText(path, text, denylist = []) {
    const findings = []
    text.split(/\r?\n/).forEach((line, index) => {
        for (const match of line.matchAll(IPV4)) {
            if (isLeakedTailnetAddress(match[0])) findings.push({ path, line: index + 1, rule: 'tailnet-address', detail: 'CGNAT address outside 100.64.0.0/16 placeholder block' })
        }
        const lower = line.toLowerCase()
        denylist.forEach((entry, entryIndex) => {
            if (typeof entry === 'string' ? lower.includes(entry) : entry.test(line)) findings.push({ path, line: index + 1, rule: 'private-denylist', detail: `entry #${entryIndex + 1}` })
        })
    })
    return findings
}

export function loadDenylist(root = process.cwd(), env = process.env) {
    const file = env.XAVENTRA_LEAK_DENYLIST_FILE || join(root, '.leak-denylist')
    const fromFile = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const entries = parseDenylist(`${env.XAVENTRA_LEAK_DENYLIST || ''}\n${fromFile}`)
    if (env.XAVENTRA_REQUIRE_LEAK_DENYLIST === '1' && !entries.length) throw new Error('Required private infrastructure denylist is unavailable')
    return entries
}

export function scanRepository(root = process.cwd(), denylist = loadDenylist(root)) {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
    const findings = []
    for (const path of files) {
        if (SKIP.some(pattern => pattern.test(path)) || !existsSync(join(root, path))) continue
        const buffer = readFileSync(join(root, path))
        if (buffer.includes(0)) continue
        findings.push(...scanText(path, buffer.toString('utf8'), denylist))
    }
    return { files: files.length, denylistEntries: denylist.length, findings }
}

if (process.argv.includes('--check')) {
    try {
        const { files, denylistEntries, findings } = scanRepository()
        for (const finding of findings) console.error(`${finding.path}:${finding.line}: ${finding.rule} (${finding.detail})`)
        console.log(`infra-leak check: ${files} tracked files, ${denylistEntries} private denylist entries, ${findings.length} findings`)
        if (findings.length) process.exitCode = 1
    } catch {
        // Never print an exception that might include private configuration values.
        console.error('infra-leak check failed: repository or private denylist could not be checked')
        process.exitCode = 1
    }
}
