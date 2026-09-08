// Compiled APIs with synthetic requests/errors in an isolated data directory.
// No network, live model, production node, or claim of whole-module acceptance.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.cwd()
const load = file => import(pathToFileURL(join(source,'dist',file)).href)
const base = resolve(process.env.XAVENTRA_LAYER_QA_DIR || tmpdir())
mkdirSync(base,{recursive:true})
const runtime = mkdtempSync(join(base,'xaventra-layer-'))
const report = {
  version:JSON.parse(readFileSync('package.json','utf8')).version,
  sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),
  platform:process.platform,
  evidenceClass:'compiled-api-synthetic-input-no-network-or-live-model',
  cases:[],
}
Object.assign(process.env,{NOVA_TEST_MODE:'1',NOVA_NO_SIDE_EFFECTS:'1',NOVA_SKIP_MODEL_RESOLVER_INIT:'1',NOVA_RUNTIME_ROOT:runtime})
process.chdir(runtime)
mkdirSync('.nova-data',{recursive:true})
let networkAttempts=0
globalThis.fetch=async () => { networkAttempts++; throw new Error('Network is not allowed in layer fixtures') }
async function check(name,fn) {
  try { await fn(); report.cases.push({name,passed:true}) }
  catch(error) { report.cases.push({name,passed:false,error:error.message}); process.exitCode=1 }
}
try {
  const {detectActionIntent}=await load('core/action-intent.js')
  const {reflect}=await load('intelligence/self-reflection.js')
  await check('Docker inspection requires evidence; conceptual explanation does not',() => {
    assert.equal(detectActionIntent('schau dir mal local deine docker an und sag mir was du siehst').requiresTool,true)
    assert.equal(detectActionIntent('Erkläre mir das Konzept von Docker').requiresTool,false)
  })
  await check('Failed chat outcome cannot receive a good reflection',() => {
    assert.equal(reflect({userMessage:'Guten Abend',assistantResponse:'Entschuldigung, da ist etwas schiefgelaufen.',toolsUsed:[],toolResults:[],execution:{requiresTool:false,validated:false,failed:true}}).needsImprovement,true)
  })
  const {ToolAutoRepairEngine}=await load('layers/L0-tool-autorepair.js')
  await check('L0 cannot create files, install error-derived packages or retry',async () => {
    const repair=new ToolAutoRepairEngine()
    let retries=0
    for (const error of ['ENOENT','Cannot find module "fixture; echo INJECTION"']) {
      const outcome=await repair.repairAndRetry('read_file',{path:join(runtime,'missing')},{success:false,error},async () => { retries++; return {success:true} })
      assert.equal(outcome.wasRepaired,false)
      assert.equal(outcome.result.repairProposal.executed,false)
    }
    assert.equal(retries,0)
    assert.equal(existsSync('missing'),false)
  })
  await check('Ordinary successful tool handler is preserved',async () => {
    const result={success:true,content:'fixture evidence'}
    assert.equal(await new ToolAutoRepairEngine().wrapToolHandler('read_file',async () => result)({}),result)
  })
  const {AutonomousLearner,recallSolution}=await load('layers/L17-autonomous-learning.js')
  await check('L17 associates sequential results with actual request and principal',() => {
    const learner=new AutonomousLearner()
    for (const marker of ['AMBER','COBALT']) learner.recordVerifiedOutcome({toolName:'read_file',request:`Read ${marker} project report`,result:{success:true,content:marker},success:true,verified:true,userId:'alice'})
    assert.ok(recallSolution('Read AMBER project report','alice').solution.includes('AMBER'))
    assert.ok(!recallSolution('Read AMBER project report','alice').solution.includes('COBALT'))
    assert.equal(recallSolution('Read AMBER project report','bob'),null)
    assert.equal(recallSolution('Read AMBER project report'),null)
  })
  const {default:learning}=await load('layers/L7-tool-learning.js')
  await check('L7 disk reload preserves principal-separated prompts',() => {
    const learner=new learning.ToolUsageLearner()
    learner.recordUsage('read_file','read project',{path:'ALICE_ONLY'},true,'alice')
    learner.recordUsage('read_file','read project',{path:'BOB_ONLY'},true,'bob')
    learner.recordUsage('read_file','read project',{path:'LEGACY_ONLY'},true)
    const prompt=new learning.ToolUsageLearner().buildLearningPrompt('read_file','alice')
    assert.ok(prompt.includes('ALICE_ONLY'))
    assert.ok(!/BOB_ONLY|LEGACY_ONLY/.test(prompt))
  })
  const {readNodeId}=await load('layers/L22-federated-memory.js')
  await check('Canonical federated identity overrides persisted compatibility alias',() => {
    writeFileSync('.nova-data/instance-id.txt','nova-legacy-fixture')
    process.env.NOVA_NODE_ID='xaventra-canonical-fixture'
    assert.equal(readNodeId(),'xaventra-canonical-fixture')
  })
  const {default:fallback,triggerFallbackIfNeeded}=await load('layers/L8-sub-agent.js')
  await check('L8 old/new public callbacks and failure helper cannot execute hidden actions',async () => {
    let calls=0
    const retry=async () => { calls++; return {success:true} }
    const report=async () => {}
    const manager=new fallback.SubAgentManager()
    assert.equal((await manager.spawnSearchAgent('fixture',{},retry,report)).status,'failed')
    assert.equal((await manager.spawnSearchAgent({problem:'fixture'},retry,report)).status,'failed')
    assert.equal((await triggerFallbackIfNeeded(99,'fixture',{},retry,report)).triggered,false)
    assert.equal(calls,0)
    assert.equal(networkAttempts,0)
  })
} finally {
  writeFileSync(join(runtime,'report.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}
