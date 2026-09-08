// Optional live-model investigation acceptance. No production tools or writes:
// an actual disposable HTTP probe and its config are the only inspected state.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = resolve(import.meta.dirname, '..')
if (!process.env.XAVENTRA_RESEARCH_QA_URL) throw new Error('Set XAVENTRA_RESEARCH_QA_URL to an explicitly authorized OpenAI-compatible local model endpoint')
if (!process.env.XAVENTRA_RESEARCH_QA_CHILD) {
  const base = resolve(process.env.XAVENTRA_RESEARCH_QA_DIR || tmpdir())
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'xaventra-research-'))
  const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]))
  Object.assign(env, { XAVENTRA_RESEARCH_QA_CHILD: root, XAVENTRA_RESEARCH_QA_URL: process.env.XAVENTRA_RESEARCH_QA_URL,
    XAVENTRA_RESEARCH_QA_MODEL: process.env.XAVENTRA_RESEARCH_QA_MODEL || 'qwen', HOME: root, USERPROFILE: root,
    NOVA_RUNTIME_ROOT: root, NOVA_TEST_MODE:'1', NOVA_NO_SIDE_EFFECTS:'1', NOVA_SKIP_MODEL_RESOLVER_INIT:'1',
    NOVA_NO_TELEGRAM:'true', NODE_ENV:'test', NOVA_OTEL_ENABLED:'false', OTEL_SDK_DISABLED:'true' })
  const child = spawnSync(process.execPath, [import.meta.filename], { cwd: root, env, encoding:'utf8', timeout:150_000, windowsHide:true })
  writeFileSync(join(root,'worker.log'), (child.stdout || '') + (child.stderr || ''))
  console.log(`Report directory: ${root}`)
  try { console.log(readFileSync(join(root,'report.json'),'utf8')) } catch { console.error(String(child.error || 'Worker did not produce a report')) }
  process.exit(child.status ?? 1)
}

const root = process.env.XAVENTRA_RESEARCH_QA_CHILD
const load = file => import(pathToFileURL(join(source,'dist',file)).href)
const report = { version:JSON.parse(readFileSync(join(source,'package.json'))).version,
  sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),
  sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:source,encoding:'utf8'}).trim()),
  evidenceClass:'live-model-native-kernel-disposable-http-diagnostics-no-repair-application', platform:process.platform,
  model:process.env.XAVENTRA_RESEARCH_QA_MODEL, cases:[] }
mkdirSync(join(root,'.nova-data'),{recursive:true})
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({healthy:true,marker:'probe-ready'}))})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const actualEndpoint=`http://127.0.0.1:${server.address().port}`
const configPath=join(root,'probe-config.json')
writeFileSync(configPath,JSON.stringify({endpoint:'http://127.0.0.1:0'}))
try {
  const {createNovaLLMClient}=await load('llm/nova-llm-sdk.js')
  const llm=await createNovaLLMClient({provider:'local',model:report.model,baseUrl:process.env.XAVENTRA_RESEARCH_QA_URL,isolated:true})
  const {getToolRegistry}=await load('tools/complete-registry.js')
  const registry=getToolRegistry()
  const original=registry.get('health_status')
  registry.register({...original,handler:async()=>{
    const config=JSON.parse(readFileSync(configPath,'utf8'))
    const actual=await (await fetch(actualEndpoint,{signal:AbortSignal.timeout(1000)})).json()
    let configuredReachable=false
    try { configuredReachable=(await fetch(config.endpoint,{signal:AbortSignal.timeout(1000)})).ok } catch {}
    return {success:true,output:JSON.stringify({configuredEndpoint:config.endpoint,observedListener:actualEndpoint,listenerProbe:actual,configuredReachable})}
  }})
  const {getLifecyclePolicy}=await load('core/lifecycle-policy.js')
  getLifecyclePolicy().register({id:'disposable-diagnostic-fixture',event:'tool.before',priority:-2000,handler:p=>
    p.toolName==='health_status'?undefined:{decision:'deny',reason:'Acceptance fixture allows only its exact local probe'}})
  const {FailureResearchCoordinator}=await load('doctor/failure-research-coordinator.js')
  const {createResearchWorker}=await load('doctor/research-worker.js')
  const coordinator=new FailureResearchCoordinator(join(root,'.nova-data','research.json'))
  coordinator.ingest({id:'disposable-probe',title:'System health probe cannot reach configured listener',detail:'Use health_status to inspect the disposable probe configuration and the observed listener. Explain the discrepancy and propose a testable correction without applying it.',category:'health',severity:'critical',source:'acceptance-fixture',recommendation:'Investigate the current observations',evidence:{},status:'open',createdAt:'',updatedAt:''})
  const result=await coordinator.investigateNext(createResearchWorker(()=>true,llm,['health_status']))
  writeFileSync(join(root,'investigation.json'),JSON.stringify(result,null,2))
  assert.equal(result?.investigation?.status,'verified')
  assert.ok(result.investigation.report.includes(String(server.address().port)), 'Model report did not identify the observed listener port')
  assert.equal(JSON.parse(readFileSync(configPath,'utf8')).endpoint,'http://127.0.0.1:0','Investigation must not mutate configuration')
  assert.equal(result.stage,'researching','A diagnostic report is not proof of repair')
  report.cases.push({id:'live-investigation-current-observations',passed:true,runId:result.investigation.runId})
} catch(error) { report.cases.push({id:'live-investigation-current-observations',passed:false,error:String(error)}); process.exitCode=1 }
finally {
  await new Promise(resolve=>server.close(resolve))
  writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2))
  // Let pending HTTP/native handles drain naturally. Forced process.exit can
  // abort Windows libuv teardown even after the assertions have passed.
}
