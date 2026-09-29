/**
 * Nova AST Security Analyzer
 * 
 * REAL Abstract Syntax Tree analysis using acorn.
 * Unlike regex, this parser understands code STRUCTURE:
 * - Detects obfuscated eval: const e = 'ev'; const a = 'al'; globalThis[e+a](...)
 * - Detects string-split requires: require('chi' + 'ld_process')
 * - Detects dynamic property access: global[varName]()
 * - Detects hidden function construction: new Function(...)
 * 
 * This is the real deal — not glorified regex.
 */

import * as acorn from 'acorn'
import * as walk from 'acorn-walk'

// ============================================
// Types
// ============================================

export interface ASTSecurityFinding {
    severity: 'critical' | 'warning' | 'info'
    category: string
    description: string
    line: number
    column: number
    nodeType: string
    code?: string  // The actual suspicious code snippet
}

export interface ASTSecurityResult {
    safe: boolean
    confidence: number  // 0-100
    findings: ASTSecurityFinding[]
    parseError?: string
}

// ============================================
// AST Analysis
// ============================================

/**
 * Parse and analyze code using a real AST.
 * Catches obfuscation that regex misses.
 */
export interface AnalyzeASTOptions {
    /**
     * Apply the rough regex TypeScript stripper before parsing (default true,
     * kept for legacy callers). Pass false when the input is already plain
     * JavaScript, e.g. the output of the TypeScript compiler API.
     */
    stripTypes?: boolean
}

export function analyzeAST(code: string, filename?: string, options: AnalyzeASTOptions = {}): ASTSecurityResult {
    const findings: ASTSecurityFinding[] = []

    // Strip TypeScript-specific syntax for acorn (JS parser)
    const jsCode = options.stripTypes === false ? code : stripTypeScript(code)

    const parseAs = (sourceType: 'module' | 'script') => acorn.parse(jsCode, {
        ecmaVersion: 'latest',
        sourceType,
        allowImportExportEverywhere: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: sourceType === 'script',
        allowHashBang: true,
        locations: true,
        // Don't fail on minor issues
        onComment: () => { },
    })
    let ast: acorn.Node
    try {
        try {
            ast = parseAs('module')
        } catch {
            // CommonJS files may use sloppy-mode constructs; retry as script.
            ast = parseAs('script')
        }
    } catch (err: any) {
        // If we can't parse, fall back to basic checks
        return {
            safe: true,  // Can't prove it's unsafe without parsing
            confidence: 30,  // Low confidence since we couldn't parse
            findings: [],
            parseError: `Parse error: ${err.message?.slice(0, 100)}`,
        }
    }

    // === Walk the AST tree ===

    walk.simple(ast, {
        // 1. Direct eval() calls
        CallExpression(node: any) {
            const callee = node.callee

            // eval(...)
            if (callee.type === 'Identifier' && callee.name === 'eval') {
                findings.push({
                    severity: 'critical',
                    category: 'dynamic-execution',
                    description: 'Direkter eval()-Aufruf — beliebiger Code kann ausgeführt werden',
                    line: node.loc?.start?.line || 0,
                    column: node.loc?.start?.column || 0,
                    nodeType: 'CallExpression',
                    code: 'eval(...)',
                })
            }

            // Function(...) — dynamic function creation
            if (callee.type === 'Identifier' && callee.name === 'Function') {
                findings.push({
                    severity: 'critical',
                    category: 'dynamic-execution',
                    description: 'Function() Constructor — dynamische Code-Generierung',
                    line: node.loc?.start?.line || 0,
                    column: node.loc?.start?.column || 0,
                    nodeType: 'CallExpression',
                    code: 'Function(...)',
                })
            }

            // require('child_process') or require('child' + '_process')
            if (callee.type === 'Identifier' && callee.name === 'require') {
                const arg = node.arguments?.[0]
                if (arg) {
                    const resolved = resolveStringExpression(arg)
                    if (resolved && isDangerousModule(resolved)) {
                        findings.push({
                            severity: 'critical',
                            category: 'dangerous-import',
                            description: `require('${resolved}') — gefährliches Modul importiert`,
                            line: node.loc?.start?.line || 0,
                            column: node.loc?.start?.column || 0,
                            nodeType: 'CallExpression',
                            code: `require('${resolved}')`,
                        })
                    } else if (resolved && isWarningModule(resolved)) {
                        findings.push({
                            severity: 'warning',
                            category: 'suspicious-import',
                            description: `require('${resolved}') — System-Modul (prüfen ob nötig)`,
                            line: node.loc?.start?.line || 0,
                            column: node.loc?.start?.column || 0,
                            nodeType: 'CallExpression',
                        })
                    }
                    // Detect string concatenation in require: require('chi' + 'ld_process')
                    if (arg.type === 'BinaryExpression' && arg.operator === '+') {
                        findings.push({
                            severity: 'critical',
                            category: 'obfuscation',
                            description: 'String-Concatenation in require() — obfuskierter Import!',
                            line: node.loc?.start?.line || 0,
                            column: node.loc?.start?.column || 0,
                            nodeType: 'BinaryExpression',
                            code: 'require(... + ...)',
                        })
                    }
                    // Dynamic require with a non-literal argument we can't resolve
                    // statically: require(varName), require(obj.prop), require(fn()).
                    // The module name is hidden at parse time → can't verify it's
                    // safe, so treat it as dangerous (e.g. const m='child_process';require(m)).
                    if (resolved === null && arg.type !== 'Literal' && arg.type !== 'BinaryExpression') {
                        findings.push({
                            severity: 'critical',
                            category: 'obfuscation',
                            description: 'require() mit dynamischem/variablem Argument — Modulname nicht statisch prüfbar!',
                            line: node.loc?.start?.line || 0,
                            column: node.loc?.start?.column || 0,
                            nodeType: 'CallExpression',
                            code: 'require(variable)',
                        })
                    }
                }
            }

            // fetch() — potential data exfiltration
            if (callee.type === 'Identifier' && callee.name === 'fetch') {
                findings.push({
                    severity: 'warning',
                    category: 'network-access',
                    description: 'fetch() — externer HTTP-Request (Daten-Exfiltration möglich)',
                    line: node.loc?.start?.line || 0,
                    column: node.loc?.start?.column || 0,
                    nodeType: 'CallExpression',
                })
            }

            // setTimeout/setInterval with string argument (hidden eval)
            if (callee.type === 'Identifier' && (callee.name === 'setTimeout' || callee.name === 'setInterval')) {
                const firstArg = node.arguments?.[0]
                if (firstArg?.type === 'Literal' && typeof firstArg.value === 'string') {
                    findings.push({
                        severity: 'critical',
                        category: 'dynamic-execution',
                        description: `${callee.name}() mit String-Argument — versteckter eval()!`,
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'CallExpression',
                        code: `${callee.name}("code string")`,
                    })
                }
            }

            // process.exit() — trying to crash the system
            if (callee.type === 'MemberExpression') {
                const obj = callee.object
                const prop = callee.property

                // process.exit()
                if (obj?.type === 'Identifier' && obj.name === 'process' &&
                    prop?.type === 'Identifier' && prop.name === 'exit') {
                    findings.push({
                        severity: 'warning',
                        category: 'system-control',
                        description: 'process.exit() — Prozess-Terminierung',
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'CallExpression',
                    })
                }

                // process.binding / dlopen — native escape hatches
                if (obj?.type === 'Identifier' && obj.name === 'process' && prop?.type === 'Identifier' &&
                    ['binding', '_linkedBinding', 'dlopen'].includes(prop.name)) {
                    findings.push({
                        severity: 'critical',
                        category: 'sandbox-escape',
                        description: `process.${prop.name}() — Zugriff auf native Bindings`,
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'CallExpression',
                        code: `process.${prop.name}(...)`,
                    })
                }

                // child_process.exec/spawn. `.exec` alone is also RegExp#exec,
                // so it only counts on a child-process-like receiver; the other
                // names are child_process specific.
                const childProcessOnly = ['spawn', 'execSync', 'execFile', 'execFileSync', 'spawnSync', 'fork']
                const receiverName = obj?.type === 'Identifier' ? obj.name
                    : obj?.type === 'MemberExpression' && obj.property?.type === 'Identifier' ? obj.property.name : ''
                const childProcessReceiver = /^(?:cp|child_?process|childProcess|proc|shell)$/i.test(receiverName)
                if (prop?.type === 'Identifier' && (childProcessOnly.includes(prop.name) || (prop.name === 'exec' && childProcessReceiver))) {
                    findings.push({
                        severity: 'critical',
                        category: 'shell-execution',
                        description: `.${prop.name}() — Shell-Befehl-Ausführung`,
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'CallExpression',
                        code: `.${prop.name}(...)`,
                    })
                }
            }
        },

        // 2. new Function(...) — constructor-based eval
        NewExpression(node: any) {
            if (node.callee?.type === 'Identifier' && node.callee.name === 'Function') {
                findings.push({
                    severity: 'critical',
                    category: 'dynamic-execution',
                    description: 'new Function() — dynamische Code-Generierung (wie eval)',
                    line: node.loc?.start?.line || 0,
                    column: node.loc?.start?.column || 0,
                    nodeType: 'NewExpression',
                    code: 'new Function(...)',
                })
            }
        },

        // 3. Dynamic property access on global/globalThis: global[variable]
        MemberExpression(node: any) {
            const obj = node.object
            // globalThis.eval / global.Function — same as the bare identifiers
            if (!node.computed && obj?.type === 'Identifier' &&
                ['global', 'globalThis', 'window', 'self'].includes(obj.name) &&
                node.property?.type === 'Identifier' && ['eval', 'Function'].includes(node.property.name)) {
                findings.push({
                    severity: 'critical',
                    category: 'dynamic-execution',
                    description: `${obj.name}.${node.property.name} — Code-Generierung über das globale Objekt`,
                    line: node.loc?.start?.line || 0,
                    column: node.loc?.start?.column || 0,
                    nodeType: 'MemberExpression',
                    code: `${obj.name}.${node.property.name}`,
                })
            }
            if (node.computed && obj?.type === 'Identifier' &&
                (obj.name === 'global' || obj.name === 'globalThis' || obj.name === 'window' || obj.name === 'self')) {
                findings.push({
                    severity: 'critical',
                    category: 'sandbox-escape',
                    description: `${obj.name}[...] — dynamischer Zugriff auf globales Objekt (Sandbox-Escape)`,
                    line: node.loc?.start?.line || 0,
                    column: node.loc?.start?.column || 0,
                    nodeType: 'MemberExpression',
                    code: `${obj.name}[variable]`,
                })
            }
        },

        // 4. Import declarations for dangerous modules
        ImportDeclaration(node: any) {
            const source = node.source?.value
            if (source && isDangerousModule(source)) {
                findings.push({
                    severity: 'critical',
                    category: 'dangerous-import',
                    description: `import from '${source}' — gefährliches Modul`,
                    line: node.loc?.start?.line || 0,
                    column: node.loc?.start?.column || 0,
                    nodeType: 'ImportDeclaration',
                    code: `import ... from '${source}'`,
                })
            } else if (source && isWarningModule(source)) {
                findings.push({
                    severity: 'warning',
                    category: 'suspicious-import',
                    description: `import from '${source}' — System-Modul (prüfen ob nötig)`,
                    line: node.loc?.start?.line || 0,
                    column: node.loc?.start?.column || 0,
                    nodeType: 'ImportDeclaration',
                })
            }
        },

        // 5. Dynamic import() for dangerous modules
        ImportExpression(node: any) {
            const source = node.source
            if (source) {
                const resolved = resolveStringExpression(source)
                if (resolved && isDangerousModule(resolved)) {
                    findings.push({
                        severity: 'critical',
                        category: 'dangerous-import',
                        description: `import('${resolved}') — dynamischer Import eines gefährlichen Moduls`,
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'ImportExpression',
                    })
                }
                // Module name not statically known: import(variable), import(`x${y}`)
                if (resolved === null && source.type !== 'BinaryExpression') {
                    findings.push({
                        severity: 'critical',
                        category: 'obfuscation',
                        description: 'import() mit dynamischem Argument — Modulname nicht statisch prüfbar!',
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'ImportExpression',
                    })
                }
                // Concatenated dynamic import
                if (source.type === 'BinaryExpression' && source.operator === '+') {
                    findings.push({
                        severity: 'critical',
                        category: 'obfuscation',
                        description: 'String-Concatenation in import() — obfuskierter dynamischer Import!',
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'ImportExpression',
                    })
                }
            }
        },

        // 6. Prototype pollution — assignment anywhere along a member chain that
        //    touches __proto__/prototype/constructor, e.g.:
        //      obj.__proto__ = x
        //      ({}).__proto__.polluted = true   (dangerous prop is in the chain, not the leaf)
        //      a['__proto__']['x'] = 1
        AssignmentExpression(node: any) {
            if (node.left?.type === 'MemberExpression') {
                const hit = memberChainDangerousProp(node.left)
                if (hit) {
                    findings.push({
                        severity: 'critical',
                        category: 'prototype-pollution',
                        description: `Zuweisung über ${hit} — Prototype Pollution Angriff!`,
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'AssignmentExpression',
                    })
                }
            }
        },
    })

    // 6a. Re-exports pull a module in just like an import:
    //     export * from 'child_process', export { exec } from 'node:child_process'
    walk.simple(ast, {
        ExportNamedDeclaration(node: any) { reportReExport(node) },
        ExportAllDeclaration(node: any) { reportReExport(node) },
    } as any)
    function reportReExport(node: any) {
        const source = node.source?.value
        if (typeof source === 'string' && isDangerousModule(source)) {
            findings.push({
                severity: 'critical',
                category: 'dangerous-import',
                description: `export ... from '${source}' — gefährliches Modul`,
                line: node.loc?.start?.line || 0,
                column: node.loc?.start?.column || 0,
                nodeType: node.type,
                code: `export ... from '${source}'`,
            })
        }
    }

    // 6b. eval / Function used as a value: (0, eval)(x), const F = Function,
    //     Reflect.apply(eval, ...). Direct calls are reported above.
    walk.ancestor(ast, {
        Identifier(node: any, _state: unknown, ancestors: any[]) {
            if (node.name !== 'eval' && node.name !== 'Function') return
            const parent = ancestors[ancestors.length - 2]
            if ((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.callee === node) return
            if (parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && parent.right === node) return
            findings.push({
                severity: 'critical',
                category: 'dynamic-execution',
                description: `${node.name} als Wert referenziert — indirekte Code-Generierung`,
                line: node.loc?.start?.line || 0,
                column: node.loc?.start?.column || 0,
                nodeType: 'Identifier',
                code: node.name,
            })
        },
    } as any)

    // === Post-walk: Pattern-based detection for bypass techniques ===
    // These are harder to catch via pure AST visitors

    // 7. Constructor chain: .constructor.constructor('...')
    walk.simple(ast, {
        MemberExpression(node: any) {
            const prop = node.property
            if (prop?.type === 'Identifier' && prop.name === 'constructor') {
                // Check if parent is also .constructor (chain)
                const obj = node.object
                if (obj?.type === 'MemberExpression' && obj.property?.type === 'Identifier' && obj.property.name === 'constructor') {
                    findings.push({
                        severity: 'critical',
                        category: 'sandbox-escape',
                        description: '.constructor.constructor — Constructor-Chain Sandbox-Escape!',
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'MemberExpression',
                        code: '.constructor.constructor(...)',
                    })
                }
            }
        },

        // 8. this.constructor access (sandbox escape via this)
        CallExpression(node: any) {
            const callee = node.callee
            // Detect: this.constructor.constructor(...)()
            if (callee?.type === 'MemberExpression') {
                const obj = callee.object
                if (obj?.type === 'ThisExpression' && callee.property?.name === 'constructor') {
                    findings.push({
                        severity: 'critical',
                        category: 'sandbox-escape',
                        description: 'this.constructor — Sandbox-Escape über this-Kontext!',
                        line: node.loc?.start?.line || 0,
                        column: node.loc?.start?.column || 0,
                        nodeType: 'CallExpression',
                        code: 'this.constructor(...)',
                    })
                }
            }
        },
    })

    // 9. String-based obfuscation patterns (catch in raw code)
    // These bypass AST because the dangerous string is assembled at runtime
    const codeLC = code.toLowerCase()

    // String.fromCharCode — can build 'eval', 'require' etc.
    if (codeLC.includes('string.fromcharcode')) {
        findings.push({
            severity: 'critical',
            category: 'obfuscation',
            description: 'String.fromCharCode() — kann gefährliche Strings zur Laufzeit bauen',
            line: 0, column: 0,
            nodeType: 'CallExpression',
            code: 'String.fromCharCode(...)',
        })
    }

    // Hex escape sequences in strings: \x65\x76\x61\x6c = "eval"
    if (/\\x[0-9a-f]{2}/i.test(code) && /\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}/i.test(code)) {
        findings.push({
            severity: 'warning',
            category: 'obfuscation',
            description: 'Mehrere Hex-Escape-Sequenzen (\\x..) — mögliche String-Obfuskation',
            line: 0, column: 0,
            nodeType: 'Literal',
        })
    }

    // .reverse().join('') — classic string reversal trick
    if (codeLC.includes('.reverse()') && codeLC.includes('.join(')) {
        findings.push({
            severity: 'warning',
            category: 'obfuscation',
            description: '.reverse().join() — String-Umkehrung (mögliche Obfuskation)',
            line: 0, column: 0,
            nodeType: 'CallExpression',
        })
    }

    // === Confidence Calculation ===
    const criticalCount = findings.filter(f => f.severity === 'critical').length
    const warningCount = findings.filter(f => f.severity === 'warning').length

    let confidence = 100
    confidence -= criticalCount * 25
    confidence -= warningCount * 8
    confidence = Math.max(0, Math.min(100, confidence))

    return {
        safe: criticalCount === 0,
        confidence,
        findings,
    }
}

// ============================================
// Helpers
// ============================================

/**
 * Walk a MemberExpression chain (object side) and return the first dangerous
 * property name found — __proto__, prototype, or constructor — whether accessed
 * via dot (a.__proto__) or computed string (a['__proto__']). Used to catch
 * prototype-pollution writes where the dangerous prop is mid-chain, not the leaf.
 */
function memberChainDangerousProp(node: any): string | null {
    const DANGEROUS = ['__proto__', 'prototype', 'constructor']
    let cur = node
    let depth = 0
    while (cur && cur.type === 'MemberExpression' && depth < 30) {
        const p = cur.property
        if (p?.type === 'Identifier' && DANGEROUS.includes(p.name)) return p.name
        if (cur.computed && p?.type === 'Literal' && typeof p.value === 'string' && DANGEROUS.includes(p.value)) return p.value
        cur = cur.object
        depth++
    }
    return null
}

/**
 * Try to resolve a string expression at AST level.
 * Handles: 'string', 'str1' + 'str2', template literals
 */
function resolveStringExpression(node: any): string | null {
    if (!node) return null

    // Simple string literal
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value
    }

    // String concatenation: 'a' + 'b'
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        const left = resolveStringExpression(node.left)
        const right = resolveStringExpression(node.right)
        if (left !== null && right !== null) {
            return left + right
        }
    }

    // Template literal: `string` or `a${'b'}` with statically known parts
    if (node.type === 'TemplateLiteral') {
        let out = ''
        for (let i = 0; i < node.quasis.length; i++) {
            out += node.quasis[i].value.cooked ?? node.quasis[i].value.raw
            if (i < node.expressions.length) {
                const part = resolveStringExpression(node.expressions[i])
                if (part === null) return null
                out += part
            }
        }
        return out
    }

    return null
}

/**
 * Check if a module name is dangerous — two tiers:
 * - critical: child_process, vm, cluster (instant block)
 * - warning: fs, os (Nova uses these, but skills shouldn't abuse them)
 */
const CRITICAL_MODULES = ['child_process', 'cluster', 'worker_threads', 'vm', 'repl', 'dgram', 'net', 'tls']
const WARNING_MODULES = ['fs', 'os', 'path', 'http', 'https', 'http2']

const bareModule = (name: string) => String(name).replace(/^node:/, '').split('/')[0]

function isDangerousModule(name: string): boolean {
    return CRITICAL_MODULES.includes(bareModule(name))
}

function isWarningModule(name: string): boolean {
    return WARNING_MODULES.includes(bareModule(name))
}

/**
 * Strip TypeScript-specific syntax so acorn can parse it.
 * This is a best-effort conversion — not perfect but catches 95%+ of cases.
 */
function stripTypeScript(code: string): string {
    return code
        // Remove type annotations: : string, : number, etc.
        .replace(/:\s*(string|number|boolean|void|never|any|unknown|null|undefined|bigint|symbol)\b(\[\])?/g, '')
        // Remove generic type parameters: <T>, <T, U>
        .replace(/<[A-Z][A-Za-z0-9,\s|&]*>/g, '')
        // Remove interface/type declarations
        .replace(/^\s*(export\s+)?(interface|type)\s+\w+[\s\S]*?^}/gm, '')
        // Remove 'as Type' casts
        .replace(/\bas\s+\w+(\[\])?\b/g, '')
        // Remove access modifiers
        .replace(/\b(private|protected|public|readonly)\s+/g, '')
        // Remove 'declare' statements
        .replace(/^\s*declare\s+.*$/gm, '')
        // Remove 'implements' clauses
        .replace(/\bimplements\s+\w+(\s*,\s*\w+)*/g, '')
        // Remove 'abstract' keyword
        .replace(/\babstract\s+/g, '')
        // Remove non-null assertions
        .replace(/!\./g, '.')
        .replace(/!(?=\s*[;,)\]])/g, '')
        // Remove 'override' keyword
        .replace(/\boverride\s+/g, '')
        // Remove enum declarations (simple ones)
        .replace(/^\s*(export\s+)?enum\s+\w+\s*\{[^}]*\}/gm, '')
}
