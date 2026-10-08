import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { basename, dirname, extname, join } from 'node:path'
import { HONEST_NO } from '../learning/capability-learning.js'
import { plateSolverCommand } from '../core/image-identification.js'
import type { NovaTool } from './complete-registry.js'

const run = promisify(execFile)

/** Parse the centre of a solved field from ASTAP (.ini) or solve-field (stdout) output. */
export function parseSolution(text: string): { ra: number; dec: number } | null {
    const ini = /CRVAL1\s*=\s*(-?[\d.]+)[\s\S]*?CRVAL2\s*=\s*(-?[\d.]+)/.exec(text)
    if (ini && /PLTSOLVD\s*=\s*T/i.test(text)) return { ra: Number(ini[1]), dec: Number(ini[2]) }
    const field = /Field center: \(RA,Dec\) = \((-?[\d.]+),\s*(-?[\d.]+)\) deg/.exec(text)
    return field ? { ra: Number(field[1]), dec: Number(field[2]) } : null
}

const HINT = 'Koordinaten belegt; Objektnamen per SIMBAD/Katalog abgleichen.'

export const astroPlateSolveTools: NovaTool[] = [{
    name: 'astro_plate_solve',
    description: 'Bestimmt per Plate-Solving (lokal installiertes ASTAP oder astrometry.net solve-field) die exakten Himmelskoordinaten eines Astrofotos. Nur so lässt sich ein Himmelsobjekt auf einem Bild belegen. Ohne installierten Solver ehrlich „kann ich noch nicht“.',
    category: 'other',
    parameters: [{ name: 'image_path', type: 'string', description: 'Pfad der Bilddatei (FITS, JPG, PNG, TIF)', required: true }],
    handler: async (params) => {
        const solver = plateSolverCommand()
        if (!solver) {
            return { solved: false, solverMissing: true, hinweis: `Kein Plate-Solver (ASTAP oder astrometry.net) installiert. ${HONEST_NO}` }
        }
        const file = String(params.image_path || '')
        if (!file || !existsSync(file)) return { solved: false, solverMissing: false, error: 'Bilddatei nicht gefunden.' }
        try {
            if (solver.kind === 'astap') {
                await run(solver.path, ['-f', file, '-r', '180', '-z', '0'], { timeout: 150_000 })
                const ini = join(dirname(file), basename(file, extname(file)) + '.ini')
                const center = existsSync(ini) ? parseSolution(readFileSync(ini, 'utf8')) : null
                return center ? { solved: true, solver: 'astap', raDeg: center.ra, decDeg: center.dec, hinweis: HINT } : { solved: false, solverMissing: false, error: 'Kein Lösungsergebnis.' }
            }
            const { stdout } = await run(solver.path, ['--overwrite', '--no-plots', '--cpulimit', '90', file], { timeout: 150_000, maxBuffer: 4_000_000 })
            const center = parseSolution(stdout)
            return center ? { solved: true, solver: 'solve-field', raDeg: center.ra, decDeg: center.dec, hinweis: HINT } : { solved: false, solverMissing: false, error: 'Kein Lösungsergebnis.' }
        } catch (error) {
            return { solved: false, solverMissing: false, error: `Solver fehlgeschlagen: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` }
        }
    },
}]
