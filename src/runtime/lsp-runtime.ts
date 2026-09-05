import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

export type LspOperation = 'definition' | 'references' | 'symbols' | 'diagnostics'
export interface LspRequest { operation: LspOperation; file: string; line?: number; column?: number; query?: string }
export interface LspLocation { file: string; line: number; column: number; text?: string }
export interface LspResponse { provider: string; operation: LspOperation; locations?: LspLocation[]; diagnostics?: Array<{ message: string; category: string; line?: number; column?: number }> }
export interface LspProvider { name: string; extensions: readonly string[]; query(root: string, request: LspRequest): Promise<LspResponse> }

function within(root: string, path: string): boolean {
    const rel = relative(resolve(root), resolve(path))
    return rel === '' || (!rel.startsWith('..') && !rel.includes('..\\') && !rel.includes('../'))
}

function lineColumn(source: ts.SourceFile, position: number): { line: number; column: number } {
    const value = source.getLineAndCharacterOfPosition(position)
    return { line: value.line + 1, column: value.character + 1 }
}

export class TypeScriptLspProvider implements LspProvider {
    readonly name = 'typescript-language-service'
    readonly extensions = ['.ts', '.tsx', '.js', '.jsx'] as const

    async query(root: string, request: LspRequest): Promise<LspResponse> {
        const canonicalRoot = resolve(root)
        const file = resolve(canonicalRoot, request.file)
        if (!within(canonicalRoot, file) || !existsSync(file) || !statSync(file).isFile()) throw new Error('LSP file is outside the workspace or missing')
        if (request.operation === 'symbols') {
            const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
            const locations: LspLocation[] = []
            const visit = (node: ts.Node): void => {
                const named = node as ts.Node & { name?: ts.Node }
                const text = named.name?.getText(source)
                if (text && (!request.query || text.toLowerCase().includes(request.query.toLowerCase()))) {
                    locations.push({ file, ...lineColumn(source, named.name!.getStart(source)), text: `${ts.SyntaxKind[node.kind]}: ${text}` })
                }
                ts.forEachChild(node, visit)
            }
            visit(source)
            return { provider: this.name, operation: request.operation, locations: locations.slice(0, 200) }
        }
        const files = this.projectFiles(canonicalRoot, file)
        const host: ts.LanguageServiceHost = {
            getScriptFileNames: () => files,
            getScriptVersion: () => '1',
            getScriptSnapshot: name => existsSync(name) ? ts.ScriptSnapshot.fromString(readFileSync(name, 'utf8')) : undefined,
            getCurrentDirectory: () => canonicalRoot,
            getCompilationSettings: () => ({ allowJs: true, checkJs: false, noLib: request.operation === 'symbols', target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }),
            getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
            fileExists: ts.sys.fileExists,
            readFile: ts.sys.readFile,
            readDirectory: ts.sys.readDirectory,
        }
        const service = ts.createLanguageService(host)
        const source = service.getProgram()?.getSourceFile(file) || ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
        try {
            if (request.operation === 'diagnostics') {
                const diagnostics = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)]
                return {
                    provider: this.name, operation: request.operation,
                    diagnostics: diagnostics.slice(0, 100).map(item => ({
                        message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
                        category: ts.DiagnosticCategory[item.category].toLowerCase(),
                        ...(item.start === undefined ? {} : lineColumn(source, item.start)),
                    })),
                }
            }
            const position = source.getPositionOfLineAndCharacter(Math.max(0, (request.line || 1) - 1), Math.max(0, (request.column || 1) - 1))
            const spans = request.operation === 'definition'
                ? service.getDefinitionAtPosition(file, position) || []
                : service.getReferencesAtPosition(file, position) || []
            const locations = spans.map(span => {
                const target = service.getProgram()?.getSourceFile(span.fileName)
                const point = target ? lineColumn(target, span.textSpan.start) : { line: 1, column: 1 }
                return { file: span.fileName, ...point, text: 'name' in span ? span.name : undefined }
            })
            return { provider: this.name, operation: request.operation, locations }
        } finally {
            service.dispose()
        }
    }

    private projectFiles(root: string, requested: string): string[] {
        const config = ts.findConfigFile(dirname(requested), ts.sys.fileExists, 'tsconfig.json') || ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
        if (!config) return [requested]
        const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config || {}, ts.sys, dirname(config))
        return parsed.fileNames.includes(requested) ? parsed.fileNames : [...parsed.fileNames, requested]
    }
}

export class LspRuntime {
    private readonly providers = new Map<string, LspProvider>()
    register(provider: LspProvider): () => void { this.providers.set(provider.name, provider); return () => this.providers.delete(provider.name) }
    list(): Array<{ name: string; extensions: readonly string[] }> { return [...this.providers.values()].map(provider => ({ name: provider.name, extensions: provider.extensions })) }
    async query(root: string, request: LspRequest): Promise<LspResponse> {
        const extension = /\.[^.]+$/.exec(request.file)?.[0]?.toLowerCase()
        const provider = [...this.providers.values()].find(item => extension && item.extensions.includes(extension))
        if (!provider) throw new Error(`No LSP provider for ${extension || request.file}`)
        return provider.query(root, request)
    }
}

let runtime: LspRuntime | null = null
export function getLspRuntime(): LspRuntime {
    if (!runtime) { runtime = new LspRuntime(); runtime.register(new TypeScriptLspProvider()) }
    return runtime
}
