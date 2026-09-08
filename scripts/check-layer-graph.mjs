// Static reachability only. This must never be reported as functional acceptance.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve('src')
const graph = new Map()
function walk(directory) {
  for (const entry of readdirSync(directory, {withFileTypes:true})) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (/\.tsx?$/.test(path) && !/\.(test|d)\.ts$/.test(path)) {
      const imports = []
      const ast = ts.createSourceFile(path, readFileSync(path,'utf8'), ts.ScriptTarget.Latest, true)
      function visit(node) {
        let specifier
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
        if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
          const base = resolve(dirname(path), specifier.text.replace(/\.js$/, '.ts'))
          const target = [base, base+'.ts', join(base,'index.ts')].find(candidate => existsSync(candidate) && /\.ts$/.test(candidate))
          if (target) imports.push(target)
        }
        ts.forEachChild(node,visit)
      }
      visit(ast)
      graph.set(path,imports)
    }
  }
}
walk(root)
const reached = new Set()
const queue = ['daemon.ts','cli.ts','nova-boot.ts'].map(file => join(root,file))
while(queue.length) {
  const path = queue.pop()
  if (reached.has(path)) continue
  reached.add(path)
  queue.push(...(graph.get(path) || []))
}
const modules = [...graph.keys()].filter(path => dirname(path) === join(root,'layers')).sort()
const report = {
  evidenceClass:'static-import-reachability-not-functional-acceptance',
  modules:modules.map(path => ({module:relative(root,path).replaceAll('\\','/'),reachable:reached.has(path)})),
}
console.log(JSON.stringify(report,null,2))
if (modules.some(path => !reached.has(path))) process.exitCode=1
