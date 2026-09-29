// Resolve hook for running reviewed TypeScript sources with Node's built-in type
// stripping, WITHOUT npm, bundlers or downloaded code (the native signing job).
// Only rewrites a relative `./x.js` import to an existing sibling `./x.ts` and
// refuses any bare package import, so the signer runs repository code only.
import { registerHooks,isBuiltin } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
    resolve(specifier, context, next) {
        if (specifier.startsWith('node:') || isBuiltin(specifier)) return next(specifier, context)
        if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:'))
            throw Error(`Signer source may not import packages: ${specifier}`)
        if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
            const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
            if (existsSync(fileURLToPath(ts))) return next(ts.href, context)
        }
        return next(specifier, context)
    },
})
