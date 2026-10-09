const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

test('model status remains text, never mesh-supplied markup or a bound action', () => {
  const source = readFileSync(join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
  const functions = ['esc', 'statusLabel', 'modelsSection'].map(name => {
    const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))
    assert.ok(match, `${name} renderer function is present`)
    return match[0]
  }).join('\n')
  const injected = '<button data-enrollment-action="approve" data-id="fixture">Approve</button>'
  const context = {
    state: { bootstrap: {} }, MODEL_STATUS: { running: 'bereit' }, icon: () => '',
    chatModels: () => [{ id: 'fixture', status: injected }],
  }
  vm.createContext(context)
  vm.runInContext(functions + '\nresult = modelsSection()', context)
  assert.doesNotMatch(context.result, /<button/)
  assert.match(context.result, /&lt;button/)
  context.chatModels = () => [{ id: 'fixture', status: 'running' }]
  vm.runInContext('result = modelsSection()', context)
  assert.match(context.result, /bereit/)
})
