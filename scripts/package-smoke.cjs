const { mkdtemp, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
(async () => {
  const executable = resolve(process.argv[2]);
  const root = await mkdtemp(join(tmpdir(), 'dispatch-package-smoke-'));
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/readyz' && req.headers.authorization !== 'Bearer synthetic-smoke-token') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/readyz') return res.end(JSON.stringify({ status: 'ready', version: 'fixture' }));
    if (req.url === '/api/v1/job-options') return res.end(JSON.stringify({role:'developer',permissions:['jobs:read','jobs:submit','jobs:cancel'],models:[],harnesses:[{id:'pi',kind:'pi',version:'1.0.0'}]}));
    if (req.url === '/v1/models') return res.end(JSON.stringify({data:[{id:'fixture-interactive',context_tokens:32768,max_output_tokens:4096,workload_class:'interactive-coding',data_destination:'operator_network'}]}));
    if (req.url === '/api/v1/capabilities') return res.end(JSON.stringify({api_major:1,contract_revision:5,features:['access_preflight','availability_reasons','data_destination','durable_jobs','external_invoke_permission','managed_application_identities','routing_revision','usage_summary','verifier_toolchain']}));
    if (req.url === '/v1/chat/completions') { res.writeHead(404); return res.end(JSON.stringify({error:{code:'unknown_model_profile'}})); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  await writeFile(join(root,'connection.json'),JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,roles:{}}));
  await writeFile(join(root,'connection.secret.json'),JSON.stringify({token:'synthetic-smoke-token'}),{mode:0o600});
  const child = spawn(executable, process.platform === 'linux' ? ['--no-sandbox'] : [], {env:{...process.env,POUNDLOCK_DISPATCH_DATA_DIR:root,POUNDLOCK_CONFIG_DIR:join(root,'config'),POUNDLOCK_DISPATCH_SMOKE:'1',POUNDLOCK_DISPATCH_SMOKE_PROBE:'1',POUNDLOCK_DISPATCH_SMOKE_REFRESH:'1',POUNDLOCK_DISPATCH_SMOKE_LOCAL_MANAGER:'1'},stdio:['ignore','pipe','pipe']});
  let logs=''; for (const stream of [child.stdout,child.stderr]) stream.on('data', b => {logs=(logs+b).slice(-8000);});
  const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
  const code=await new Promise((r,reject)=>{child.on('error',reject);child.on('close',r);}); clearTimeout(timer); server.close();
  const result=JSON.parse(await readFile(join(root,'smoke.json'),'utf8'));
  if(code!==0||!result.ok||!result.probeOk||!result.startupProbeOk||!result.roleSaveKeptCatalog||!result.localManagerOk||!paths.includes('/v1/models')) throw new Error(JSON.stringify({code,result,logs}));
  console.log(JSON.stringify({ok:true,bridge:result.hasApi,probe:result.probeOk,startupDiscovery:result.startupProbeOk,roleSaveKeptCatalog:result.roleSaveKeptCatalog,localManager:result.localManagerOk,requests:paths,platform:process.platform,arch:process.arch}));
})().catch(e=>{console.error(e);process.exitCode=1;});
