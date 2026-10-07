/**
 * helm-lite: renders the Xaventra chart in tests without the helm binary.
 *
 * Implements the small subset of Go text/template + Sprig the chart uses
 * (define/include, if/else if/else, range, with, variables incl. `=`,
 * pipelines and ~35 functions) with Helm's conventions: `<no value>` prints
 * as empty, toYaml trims the trailing newline, map ranges are key-sorted,
 * and missing nested fields fail like Helm's "nil pointer evaluating".
 * Unknown syntax throws instead of guessing, so the chart cannot silently
 * drift beyond what this renderer understands. CI additionally runs the real
 * `helm template`/`helm lint` when helm is installed.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, parseAllDocuments, stringify as stringifyYaml } from 'yaml'

type Value = any
type Node =
    | { t: 'text'; v: string }
    | { t: 'action'; p: Pipeline }
    | { t: 'if'; branches: Array<{ cond: Pipeline; body: Node[] }>; else?: Node[] }
    | { t: 'range'; p: Pipeline; body: Node[]; else?: Node[] }
    | { t: 'with'; p: Pipeline; body: Node[]; else?: Node[] }
interface Pipeline { decl?: string[]; assign?: string; cmds: Operand[][] }
type Operand =
    | { k: 'lit'; v: Value }
    | { k: 'field'; base: 'dot' | string; path: string[] }   // base: 'dot' or variable name ('$', '$x')
    | { k: 'fn'; name: string }
    | { k: 'sub'; p: Pipeline; path: string[] }

export class HelmLiteError extends Error {}

// ---------------------------------------------------------------------------
// Lexing: text and actions with trim markers
// ---------------------------------------------------------------------------

type Piece = { t: 'text'; v: string } | { t: 'act'; v: string; ltrim: boolean; rtrim: boolean }

function lex(src: string, file: string): Piece[] {
    const out: Piece[] = []
    let i = 0
    while (i < src.length) {
        const open = src.indexOf('{{', i)
        if (open < 0) { out.push({ t: 'text', v: src.slice(i) }); break }
        out.push({ t: 'text', v: src.slice(i, open) })
        let j = open + 2
        const ltrim = src[j] === '-' && /\s/.test(src[j + 1] || '')
        if (ltrim) j += 1
        let quote: string | null = null
        let k = j
        for (; k < src.length; k++) {
            const c = src[k]
            if (quote) { if (c === '\\' && quote === '"') { k++; continue } if (c === quote) quote = null; continue }
            if (c === '"' || c === '`') { quote = c; continue }
            if (c === '}' && src[k + 1] === '}') break
        }
        if (k >= src.length) throw new HelmLiteError(`${file}: unclosed action`)
        let body = src.slice(j, k)
        const rtrim = /\s-$/.test(body)
        if (rtrim) body = body.slice(0, -1)
        out.push({ t: 'act', v: body.trim(), ltrim, rtrim })
        i = k + 2
    }
    // Apply trim markers.
    for (let n = 0; n < out.length; n++) {
        const piece = out[n]
        if (piece.t !== 'act') continue
        const prev = out[n - 1]
        const next = out[n + 1]
        if (piece.ltrim && prev?.t === 'text') prev.v = prev.v.replace(/\s+$/, '')
        if (piece.rtrim && next?.t === 'text') next.v = next.v.replace(/^\s+/, '')
    }
    return out.filter(piece => !(piece.t === 'act' && /^\/\*[\s\S]*\*\/$/.test(piece.v)))
}

// ---------------------------------------------------------------------------
// Parsing pipelines
// ---------------------------------------------------------------------------

function tokenize(src: string): string[] {
    const tokens: string[] = []
    let i = 0
    while (i < src.length) {
        const c = src[i]
        if (/\s/.test(c)) { i++; continue }
        if (c === '"') {
            let j = i + 1
            for (; j < src.length; j++) { if (src[j] === '\\') { j++; continue } if (src[j] === '"') break }
            tokens.push(src.slice(i, j + 1)); i = j + 1; continue
        }
        if (c === '`') { const j = src.indexOf('`', i + 1); tokens.push(src.slice(i, j + 1)); i = j + 1; continue }
        if (c === ')' && src[i + 1] === '.') {
            // (pipeline).Field — only without whitespace, as in Go.
            let j = i + 1
            while (j < src.length && !/[s()|,=]/.test(src[j])) j++
            tokens.push(')', `@${src.slice(i + 1, j)}`); i = j; continue
        }
        if (c === '(' || c === ')' || c === '|' || c === ',') { tokens.push(c); i++; continue }
        if (src.startsWith(':=', i)) { tokens.push(':='); i += 2; continue }
        if (c === '=' ) { tokens.push('='); i++; continue }
        let j = i
        while (j < src.length && !/[\s()|,=]/.test(src[j])) j++
        tokens.push(src.slice(i, j)); i = j
    }
    return tokens
}

function parsePipeline(src: string): Pipeline {
    const tokens = tokenize(src)
    const p: Pipeline = { cmds: [] }
    // Declarations: $a := ... | $a, $b := ... | $a = ...
    const declMatch = (() => {
        const names: string[] = []
        let n = 0
        while (n < tokens.length && /^\$[A-Za-z0-9_]*$/.test(tokens[n])) {
            names.push(tokens[n]); n++
            if (tokens[n] === ',') { n++; continue }
            break
        }
        if (names.length && (tokens[n] === ':=' || tokens[n] === '=')) return { names, op: tokens[n], rest: n + 1 }
        return null
    })()
    let pos = 0
    if (declMatch) {
        if (declMatch.op === ':=') p.decl = declMatch.names
        else { if (declMatch.names.length !== 1) throw new HelmLiteError(`bad assignment: ${src}`); p.assign = declMatch.names[0] }
        pos = declMatch.rest
    }
    const [cmds, end] = parseCommands(tokens, pos)
    if (end !== tokens.length) throw new HelmLiteError(`unexpected token in: ${src}`)
    p.cmds = cmds
    return p
}

function parseCommands(tokens: string[], pos: number): [Operand[][], number] {
    const cmds: Operand[][] = [[]]
    while (pos < tokens.length && tokens[pos] !== ')') {
        const token = tokens[pos]
        if (token === '|') { cmds.push([]); pos++; continue }
        if (token === '(') {
            const [inner, end] = parseCommands(tokens, pos + 1)
            if (tokens[end] !== ')') throw new HelmLiteError('unclosed (')
            pos = end + 1
            let path: string[] = []
            if (tokens[pos]?.startsWith('@.')) { path = tokens[pos].slice(1).split('.').filter(Boolean); pos++ }
            cmds[cmds.length - 1].push({ k: 'sub', p: { cmds: inner }, path })
            continue
        }
        cmds[cmds.length - 1].push(operand(token))
        pos++
    }
    if (cmds.some(cmd => cmd.length === 0)) throw new HelmLiteError('empty command in pipeline')
    return [cmds, pos]
}

function operand(token: string): Operand {
    if (token.startsWith('"')) return { k: 'lit', v: JSON.parse(token) }
    if (token.startsWith('`')) return { k: 'lit', v: token.slice(1, -1) }
    if (/^-?\d+(\.\d+)?$/.test(token)) return { k: 'lit', v: Number(token) }
    if (token === 'true' || token === 'false') return { k: 'lit', v: token === 'true' }
    if (token === 'nil') return { k: 'lit', v: null }
    if (token === '.') return { k: 'field', base: 'dot', path: [] }
    if (token.startsWith('.')) return { k: 'field', base: 'dot', path: token.split('.').filter(Boolean) }
    if (token.startsWith('$')) {
        const [name, ...path] = token.split('.')
        return { k: 'field', base: name, path }
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return { k: 'fn', name: token }
    throw new HelmLiteError(`unknown token ${token}`)
}

// ---------------------------------------------------------------------------
// Parsing control structures
// ---------------------------------------------------------------------------

function parse(pieces: Piece[], defines: Map<string, Node[]>, file: string): Node[] {
    let index = 0
    const block = (stopAt: RegExp): { nodes: Node[]; stop: string } => {
        const nodes: Node[] = []
        while (index < pieces.length) {
            const piece = pieces[index++]
            if (piece.t === 'text') { if (piece.v) nodes.push({ t: 'text', v: piece.v }); continue }
            const action = piece.v
            if (stopAt.test(action)) return { nodes, stop: action }
            const keyword = /^(if|range|with|define|end|else|template|block)\b/.exec(action)?.[1]
            if (!keyword) { nodes.push({ t: 'action', p: parsePipeline(action) }); continue }
            if (keyword === 'if') {
                const branches = [{ cond: parsePipeline(action.slice(2)), body: [] as Node[] }]
                let elseBody: Node[] | undefined
                for (;;) {
                    const inner = block(/^(else|end)\b/)
                    branches[branches.length - 1].body = inner.nodes
                    if (inner.stop === 'end') break
                    const elseIf = /^else\s+if\s+([\s\S]+)$/.exec(inner.stop)
                    if (elseIf) { branches.push({ cond: parsePipeline(elseIf[1]), body: [] }); continue }
                    if (inner.stop !== 'else') throw new HelmLiteError(`${file}: bad else: ${inner.stop}`)
                    const tail = block(/^end$/)
                    elseBody = tail.nodes
                    break
                }
                nodes.push({ t: 'if', branches, else: elseBody })
                continue
            }
            if (keyword === 'range' || keyword === 'with') {
                const p = parsePipeline(action.slice(keyword.length))
                const inner = block(/^(else|end)$/)
                let elseBody: Node[] | undefined
                if (inner.stop === 'else') elseBody = block(/^end$/).nodes
                nodes.push({ t: keyword, p, body: inner.nodes, else: elseBody } as Node)
                continue
            }
            if (keyword === 'define') {
                const name = JSON.parse(action.slice(6).trim())
                const inner = block(/^end$/)
                defines.set(name, inner.nodes)
                continue
            }
            throw new HelmLiteError(`${file}: unsupported or stray action {{ ${action} }}`)
        }
        if (stopAt.source !== '$^') throw new HelmLiteError(`${file}: missing {{ end }}`)
        return { nodes, stop: '' }
    }
    return block(/$^/).nodes
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const isEmpty = (v: Value): boolean => v === null || v === undefined || v === false || v === 0 || v === ''
    || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)

function printValue(v: Value): string {
    if (v === null || v === undefined) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) return `[${v.map(printValue).join(' ')}]`
    return `map[${Object.keys(v).sort().map(key => `${key}:${printValue(v[key])}`).join(' ')}]`
}

function sortKeys(v: Value): Value {
    if (Array.isArray(v)) return v.map(sortKeys)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(key => [key, sortKeys(v[key])]))
    return v
}

function goQuote(s: string): string { return JSON.stringify(s) }

function sprintf(format: string, args: Value[]): string {
    let n = 0
    return format.replace(/%([svdq%])/g, (_m, verb) => {
        if (verb === '%') return '%'
        const arg = args[n++]
        if (verb === 'q') return goQuote(printValue(arg))
        if (verb === 'd') return String(Math.trunc(Number(arg)))
        return printValue(arg)
    })
}

interface Scope { vars: Map<string, Value>; parent?: Scope }
const lookupVar = (scope: Scope, name: string): Scope | null => scope.vars.has(name) ? scope : scope.parent ? lookupVar(scope.parent, name) : null

export class HelmLite {
    private readonly defines = new Map<string, Node[]>()
    private readonly templates = new Map<string, Node[]>()

    constructor(readonly chartDir: string) {
        const dir = join(chartDir, 'templates')
        for (const name of readdirSync(dir).sort()) {
            if (!/\.(ya?ml|tpl|txt)$/.test(name)) continue
            const nodes = parse(lex(readFileSync(join(dir, name), 'utf8'), name), this.defines, name)
            if (!name.startsWith('_')) this.templates.set(name, nodes)
        }
    }

    chart(): Record<string, Value> { return parseYaml(readFileSync(join(this.chartDir, 'Chart.yaml'), 'utf8')) }
    defaultValues(): Record<string, Value> { return parseYaml(readFileSync(join(this.chartDir, 'values.yaml'), 'utf8')) }

    /** Renders every template; returns file → text. */
    render(options: { values?: Record<string, Value>; releaseName?: string; namespace?: string } = {}): Map<string, string> {
        const chart = this.chart()
        const root = {
            Values: deepMerge(this.defaultValues(), options.values || {}),
            Release: { Name: options.releaseName || 'xv', Namespace: options.namespace || 'xaventra', Service: 'Helm', IsInstall: true, IsUpgrade: false },
            Chart: { Name: chart.name, Version: chart.version, AppVersion: chart.appVersion },
            Capabilities: {},
        }
        const out = new Map<string, string>()
        for (const [name, nodes] of this.templates) {
            const rendered = this.exec(nodes, root, { vars: new Map([['$', root]]) }, name)
            out.set(name, rendered.split('<no value>').join(''))
        }
        return out
    }

    /** All rendered Kubernetes objects (NOTES.txt excluded). */
    objects(options: Parameters<HelmLite['render']>[0] = {}): Array<Record<string, Value>> {
        const objects: Array<Record<string, Value>> = []
        for (const [name, text] of this.render(options)) {
            if (name === 'NOTES.txt') continue
            for (const doc of parseAllDocuments(text)) {
                if (doc.errors.length) throw new HelmLiteError(`${name}: YAML error ${doc.errors[0].message}\n${text}`)
                const value = doc.toJS()
                if (value && typeof value === 'object') objects.push({ ...value, __file: name })
            }
        }
        return objects
    }

    private exec(nodes: Node[], dot: Value, scope: Scope, file: string): string {
        let out = ''
        for (const node of nodes) {
            if (node.t === 'text') { out += node.v; continue }
            if (node.t === 'action') {
                const value = this.evalPipeline(node.p, dot, scope, file)
                if (!node.p.decl && !node.p.assign) out += printValue(value)
                continue
            }
            if (node.t === 'if') {
                let done = false
                for (const branch of node.branches) {
                    const inner: Scope = { vars: new Map(), parent: scope }
                    if (!isEmpty(this.evalPipeline(branch.cond, dot, inner, file))) { out += this.exec(branch.body, dot, inner, file); done = true; break }
                }
                if (!done && node.else) out += this.exec(node.else, dot, { vars: new Map(), parent: scope }, file)
                continue
            }
            if (node.t === 'with') {
                const inner: Scope = { vars: new Map(), parent: scope }
                const value = this.evalPipeline({ ...node.p, decl: undefined }, dot, inner, file)
                if (node.p.decl) inner.vars.set(node.p.decl[0], value)
                if (!isEmpty(value)) out += this.exec(node.body, value, inner, file)
                else if (node.else) out += this.exec(node.else, dot, inner, file)
                continue
            }
            if (node.t === 'range') {
                const value = this.evalPipeline({ ...node.p, decl: undefined }, dot, scope, file)
                const entries: Array<[Value, Value]> = Array.isArray(value)
                    ? value.map((item, i) => [i, item])
                    : value && typeof value === 'object' ? Object.keys(value).sort().map(key => [key, value[key]]) : []
                if (value !== null && value !== undefined && typeof value !== 'object') throw new HelmLiteError(`${file}: range over non-collection`)
                if (!entries.length) { if (node.else) out += this.exec(node.else, dot, { vars: new Map(), parent: scope }, file); continue }
                for (const [key, item] of entries) {
                    const inner: Scope = { vars: new Map(), parent: scope }
                    if (node.p.decl?.length === 1) inner.vars.set(node.p.decl[0], item)
                    if (node.p.decl?.length === 2) { inner.vars.set(node.p.decl[0], key); inner.vars.set(node.p.decl[1], item) }
                    out += this.exec(node.body, item, inner, file)
                }
            }
        }
        return out
    }

    private evalPipeline(p: Pipeline, dot: Value, scope: Scope, file: string): Value {
        let value: Value = undefined
        let first = true
        for (const cmd of p.cmds) {
            value = this.evalCommand(cmd, dot, scope, file, first ? undefined : { v: value })
            first = false
        }
        if (p.decl) scope.vars.set(p.decl[0], value)
        if (p.assign) {
            const owner = lookupVar(scope, p.assign)
            if (!owner) throw new HelmLiteError(`${file}: undefined variable ${p.assign}`)
            owner.vars.set(p.assign, value)
        }
        return value
    }

    private evalOperand(op: Operand, dot: Value, scope: Scope, file: string): Value {
        if (op.k === 'lit') return op.v
        if (op.k === 'sub') return this.walk(this.evalPipeline(op.p, dot, scope, file), op.path, file)
        if (op.k === 'field') {
            let base: Value
            if (op.base === 'dot') base = dot
            else {
                const owner = lookupVar(scope, op.base)
                if (!owner) throw new HelmLiteError(`${file}: undefined variable ${op.base}`)
                base = owner.vars.get(op.base)
            }
            return this.walk(base, op.path, file)
        }
        throw new HelmLiteError(`${file}: function ${op.name} used as value`)
    }

    private walk(base: Value, path: string[], file: string): Value {
        let value = base
        for (let i = 0; i < path.length; i++) {
            if (value === null || value === undefined) throw new HelmLiteError(`${file}: nil pointer evaluating .${path.slice(0, i + 1).join('.')}`)
            if (typeof value !== 'object') throw new HelmLiteError(`${file}: can't evaluate field ${path[i]} in ${typeof value}`)
            value = value[path[i]]
        }
        return value
    }

    private evalCommand(cmd: Operand[], dot: Value, scope: Scope, file: string, piped?: { v: Value }): Value {
        const [head, ...rest] = cmd
        if (head.k !== 'fn') {
            if (rest.length || piped) throw new HelmLiteError(`${file}: cannot call a non-function`)
            return this.evalOperand(head, dot, scope, file)
        }
        const args = rest.map(op => this.evalOperand(op, dot, scope, file))
        if (piped) args.push(piped.v)
        return this.call(head.name, args, file)
    }

    private call(name: string, a: Value[], file: string): Value {
        const str = (v: Value) => printValue(v)
        const num = (v: Value) => { const n = Number(v ?? 0); if (!Number.isFinite(n)) throw new HelmLiteError(`${file}: ${name}: not a number`); return n }
        switch (name) {
            case 'include': {
                const nodes = this.defines.get(a[0])
                if (!nodes) throw new HelmLiteError(`${file}: no template "${a[0]}"`)
                return this.exec(nodes, a[1], { vars: new Map([['$', a[1]]]) }, `${file}→${a[0]}`).split('<no value>').join('')
            }
            case 'default': return isEmpty(a[1]) ? a[0] : a[1]
            case 'quote': return a.map(v => goQuote(str(v))).join(' ')
            case 'toYaml': {
                const value = sortKeys(a[0])
                if (value === null || value === undefined) return 'null'
                return stringifyYaml(value, { lineWidth: 0 }).replace(/\n$/, '')
            }
            case 'toJson': return JSON.stringify(sortKeys(a[0]) ?? null)
            case 'nindent': return '\n' + str(a[1]).split('\n').map(line => ' '.repeat(num(a[0])) + line).join('\n')
            case 'indent': return str(a[1]).split('\n').map(line => ' '.repeat(num(a[0])) + line).join('\n')
            case 'trunc': return str(a[1]).slice(0, num(a[0]))
            case 'trimSuffix': return str(a[1]).endsWith(str(a[0])) ? str(a[1]).slice(0, -str(a[0]).length || undefined) : str(a[1])
            case 'contains': return str(a[1]).includes(str(a[0]))
            case 'replace': return str(a[2]).split(str(a[0])).join(str(a[1]))
            case 'lower': return str(a[0]).toLowerCase()
            case 'upper': return str(a[0]).toUpperCase()
            case 'printf': return sprintf(str(a[0]), a.slice(1))
            case 'eq': return a.slice(1).some(v => v === a[0])
            case 'ne': return a[0] !== a[1]
            case 'gt': return num(a[0]) > num(a[1])
            case 'lt': return num(a[0]) < num(a[1])
            case 'ge': return num(a[0]) >= num(a[1])
            case 'le': return num(a[0]) <= num(a[1])
            case 'and': { for (const v of a) if (isEmpty(v)) return v; return a[a.length - 1] }
            case 'or': { for (const v of a) if (!isEmpty(v)) return v; return a[a.length - 1] }
            case 'not': return isEmpty(a[0])
            case 'int': return Math.trunc(num(a[0]))
            case 'add': return a.reduce((sum, v) => sum + Math.trunc(num(v)), 0)
            case 'sub': return Math.trunc(num(a[0])) - Math.trunc(num(a[1]))
            case 'list': return [...a]
            case 'append': return [...(a[0] || []), a[1]]
            case 'dict': { const out: Record<string, Value> = {}; for (let i = 0; i < a.length; i += 2) out[str(a[i])] = a[i + 1]; return out }
            case 'has': return Array.isArray(a[1]) && a[1].includes(a[0])
            case 'hasKey': return Boolean(a[0]) && Object.prototype.hasOwnProperty.call(a[0], str(a[1]))
            case 'index': { let v = a[0]; for (const key of a.slice(1)) v = v?.[key]; return v }
            case 'empty': return isEmpty(a[0])
            case 'ternary': return isEmpty(a[2]) ? a[1] : a[0]
            case 'sha256sum': return createHash('sha256').update(str(a[0])).digest('hex')
            case 'hasPrefix': return str(a[1]).startsWith(str(a[0]))
            case 'join': return (Array.isArray(a[1]) ? a[1] : []).map(str).join(str(a[0]))
            // Sprig: deepCopy returns an independent copy; set mutates the dict and returns it.
            case 'deepCopy': return a[0] === undefined ? undefined : JSON.parse(JSON.stringify(a[0]))
            case 'set': { if (!a[0] || typeof a[0] !== 'object') throw new HelmLiteError(`${file}: set on non-dict`); a[0][str(a[1])] = a[2]; return a[0] }
            case 'fail': throw new HelmLiteError(`fail: ${str(a[0])}`)
            case 'required': if (isEmpty(a[1]) && a[1] !== false && a[1] !== 0) throw new HelmLiteError(`required: ${str(a[0])}`); return a[1]
            default: throw new HelmLiteError(`${file}: unsupported function ${name}`)
        }
    }
}

export function deepMerge(base: Value, override: Value): Value {
    if (override === undefined) return base
    if (!base || typeof base !== 'object' || Array.isArray(base) || !override || typeof override !== 'object' || Array.isArray(override)) return override
    const out: Record<string, Value> = { ...base }
    for (const [key, value] of Object.entries(override)) out[key] = value === null ? undefined : deepMerge(base[key], value)
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
    return out
}
