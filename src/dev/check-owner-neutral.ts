import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Datenschutz (2.91): this repository is public and installed by other people. Runtime text
// (string and template literals, regexes) must never name a fixed owner — another
// installation would address its owner with our owner's name. Comments and provenance
// notes may keep it. The owner is named only via src/memory/owner-profile.ts `ownerName`.
// Real personal identifiers (ids, family, pets, addresses) are checked by
// scripts/check-infra-leaks.mjs against a private denylist that is never committed.

const FIXED_OWNER = /alfred|aigner/i
/** Persisted status ids that predate this rule; renaming them would need a data migration. */
const ALLOWED_LITERALS = new Set(['wartet-auf-alfred'])
const SOURCE = /\.(?:ts|tsx|js|cjs|mjs)$/
const NOT_RUNTIME = /(?:\.test\.|\/e2e\/|\/test-utils\/|^src\/dev\/check-owner-neutral\.ts$)/

export interface OwnerNameLeak { path: string; line: number; text: string }

export function ownerNameLeaks(path: string, source: string): OwnerNameLeak[] {
    if (!FIXED_OWNER.test(source)) return []
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    const leaks: OwnerNameLeak[] = []
    const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
            || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node) || ts.isJsxText(node)) {
            const text = node.getText(file)
            const value = 'text' in node ? String((node as { text: string }).text) : text
            if (FIXED_OWNER.test(text) && !ALLOWED_LITERALS.has(value)) {
                leaks.push({ path, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text: text.slice(0, 120) })
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    return leaks
}

export function runtimeSourceFiles(root: string): string[] {
    return execFileSync('git', ['ls-files', 'src', 'desktop', 'scripts'], { cwd: root, encoding: 'utf8' })
        .split(/\r?\n/).filter(path => SOURCE.test(path) && !NOT_RUNTIME.test(path))
}

export function scanOwnerNeutral(root = process.cwd()): OwnerNameLeak[] {
    return runtimeSourceFiles(root).flatMap(path => ownerNameLeaks(path, readFileSync(resolve(root, path), 'utf8')))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const leaks = scanOwnerNeutral()
    if (leaks.length) {
        for (const leak of leaks) console.error(`${leak.path}:${leak.line}: fester Owner-Name im Laufzeittext — ownerName() aus src/memory/owner-profile.ts benutzen`)
        process.exitCode = 1
    } else console.log('Owner-neutral: kein fester Owner-Name im Laufzeittext.')
}
