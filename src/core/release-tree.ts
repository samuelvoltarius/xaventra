import { createHash } from 'node:crypto'

export interface ReleaseFileEvidence { path: string; sha256: string; size: number }
/** Existing canonical file inventory digest, without CLI or identity startup. */
export function releaseTreeHash(files: ReleaseFileEvidence[]): string {
    const canonical = files.map(file => `${file.path}\0${file.sha256}\0${file.size}`).join('\n')
    return createHash('sha256').update(canonical).digest('hex')
}
