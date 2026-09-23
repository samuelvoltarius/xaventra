import { execFileSync } from 'node:child_process'

export function assertReleaseSource(cwd = process.cwd()) {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const revision = git('rev-parse', 'HEAD')
    // Include untracked files: unknown build inputs must not be silently allowed.
    if (git('status', '--porcelain', '--untracked-files=all')) throw Error('Release source is dirty')
    return revision
}

if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ sourceRevision: assertReleaseSource(), sourceDirty: false }))
}
