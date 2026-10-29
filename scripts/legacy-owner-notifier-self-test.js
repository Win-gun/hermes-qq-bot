/** Node 22+, /usr/bin/python3 and /usr/bin/jq; no services or network required.
 * Run: node scripts/legacy-owner-notifier-self-test.js
 * All children receive a fresh HOME and stub-only PATH, not the user's env.
 * Python replaces urllib and forbids sockets. Bash resolves curl/jq ONLY to
 * instrumented Node stubs; jq delegates allowlisted, file-free filters to the
 * system JSON parser. No actual curl, auth endpoint, QQ, model or launchd runs.
 * Temporary fixtures are removed even on failure. Never print child output,
 * command arguments, headers, generated credentials or private fixture bodies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonFile = path.join(project, 'scripts/status-report.py');
const shellFile = path.join(project, 'scripts/status_report.sh');
const python = '/usr/bin/python3', jq = '/usr/bin/jq', bash = '/bin/bash';
let assertions = 0;
function check(condition, code) {
  assertions++;
  if (!condition) throw Object.assign(new Error('fixture assertion failed'), { fixtureCode: code });
}
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function stateSnapshot(directory) {
  const out = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name), s = fs.lstatSync(p);
      check(!s.isSymbolicLink(), 'FIXTURE_SYMLINK');
      out.push([path.relative(directory, p), s.mode, s.size, s.mtimeMs, s.ctimeMs,
        s.isFile() ? digest(fs.readFileSync(p)) : null]);
      if (s.isDirectory()) visit(p);
    }
  }
  visit(directory);
  return JSON.stringify(out);
}

// Fourteen refusal fixtures + dry run + allowed send + auth race + offline,
// independently exercised against BOTH implementations: 36 total cases.
const deny = [
  ['centralized', 200, '{"centralized":true}'],
  ['missing', 200, '{}'],
  ['wrong-type', 200, '{"centralized":"false"}'],
  ['null', 200, '{"centralized":null}'],
  ['array', 200, '[]'],
  ['malformed', 200, 'not-json'],
  ['old-host', 404, '{}'],
  ['auth-required', 401, '{}'],
  ['host-error', 503, '{}'],
  ['redirect', 302, '{"centralized":false}'],
  ['wrong-status', 201, '{"centralized":false}'],
  ['oversized', 200, JSON.stringify({ centralized: false, padding: 'x'.repeat(4100) })],
  ['multiple-objects', 200, '{"centralized":false}\n{}'],
  ['repeated-objects', 200, '{"centralized":false}\n{"centralized":false}'],
].map(([name, status, body]) => ({ name, mode: 'deny', policies: [{ status, body }] }));
const allowed = { status: 200, body: '{"centralized":false}' };
const cases = [...deny,
  { name: 'dry-run', mode: 'dry', policies: [allowed] },
  { name: 'send', mode: 'send', policies: [allowed] },
  { name: 'auth-race', mode: 'race', policies: [allowed, { status: 200, body: '{"centralized":true}' }] },
  { name: 'offline', mode: 'deny', policies: [{ offline: true }] },
];
const expectedRequests = mode => mode === 'dry' ? ['GET:policy', 'GET:health']
  : mode === 'send' ? ['GET:policy', 'GET:auth', 'GET:policy', 'POST:send']
    : mode === 'race' ? ['GET:policy', 'GET:auth', 'GET:policy'] : ['GET:policy'];

const pythonHarness = String.raw`
import builtins, contextlib, io, json, os, platform, socket, sys, types
import urllib.error, urllib.request
from unittest.mock import patch

payload = json.load(sys.stdin)
with open(sys.argv[1], 'r', encoding='utf-8') as f: source = f.read()
checks = 0
def require(ok, code):
    global checks
    checks += 1
    if not ok: raise AssertionError(code)
def no_socket(*args, **kwargs): raise AssertionError('NETWORK_FORBIDDEN')
socket.socket = no_socket
socket.create_connection = no_socket
results = []
for case in payload['cases']:
    os.environ['HERMES_QQ_HOME'] = case['stateRoot']
    ns = {'__name__':'legacy_fixture', '__file__':sys.argv[1]}
    calls, policy_calls = [], [0]
    class Response:
        def __init__(self, status, body): self.status, self.body = status, body
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, limit=-1): return self.body if limit < 0 else self.body[:limit]
    def respond(req, timeout=None):
        url = req.full_url
        require(url.startswith('http://127.0.0.1:6200/'), 'URL_NOT_ALLOWLISTED')
        suffix = url[len('http://127.0.0.1:6200'):]
        endpoint = {'/api/owner/notification-policy':'policy', '/health':'health',
                    '/api/admin/session':'auth', '/api/send_private':'send'}.get(suffix)
        require(endpoint is not None, 'UNKNOWN_ENDPOINT')
        method = req.get_method()
        calls.append(method+':'+endpoint)
        if endpoint == 'policy':
            require(method == 'GET' and timeout == 5, 'POLICY_TIMEOUT_OR_METHOD')
            headers = {k.lower():v for k,v in req.header_items()}
            require(set(headers) == {'accept'}, 'POLICY_MUST_NOT_AUTHENTICATE')
            p = case['policies'][min(policy_calls[0],len(case['policies'])-1)]
            policy_calls[0] += 1
            if p.get('offline'): raise urllib.error.URLError('fixture offline')
            if 300 <= p['status'] < 400:
                raise urllib.error.HTTPError(url,p['status'],'fixture redirect',{'Location':'https://fixture.invalid/'},None)
            return Response(p['status'],p['body'].encode())
        require(timeout in [10,15], 'UNBOUNDED_REQUEST')
        if endpoint == 'health':
            require(method == 'GET', 'HEALTH_METHOD')
            return Response(200,json.dumps({'ok':True,'onebotConnected':True,
                'token':payload['token'],'qqLogin':{'recent':['FIXTURE_PRIVATE_CANARY']}}).encode())
        if endpoint == 'auth':
            require(method == 'GET', 'AUTH_METHOD')
            return Response(200,json.dumps({'token':payload['token']}).encode())
        require(method == 'POST', 'SEND_METHOD')
        headers = {k.lower():v for k,v in req.header_items()}
        require(headers.get('x-hermes-qq-admin') == payload['token'], 'SEND_AUTH')
        require(headers.get('origin') == 'http://127.0.0.1:6200', 'SEND_ORIGIN')
        body = json.loads(req.data)
        require(body.get('source') == 'legacy-status-report', 'SEND_SOURCE')
        require(body.get('user_id') == 'fixture-owner' and body.get('message') == 'fixture-body', 'SEND_BODY')
        return Response(200,b'{"ok":true}')
    class Opener:
        def open(self, req, timeout=None): return respond(req, timeout)
    def build_opener(*handlers):
        require(len(handlers) == 1 and isinstance(handlers[0],urllib.request.HTTPRedirectHandler), 'REDIRECT_GUARD_REQUIRED')
        require(handlers[0].redirect_request(None,None,302,'fixture',{},'https://fixture.invalid/') is None,
                'REDIRECT_GUARD_REQUIRED')
        return Opener()
    output, errors = io.StringIO(), io.StringIO()
    try:
        with patch.object(urllib.request,'build_opener',build_opener), patch.object(urllib.request,'urlopen',respond), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            exec(compile(source,sys.argv[1],'exec'),ns)
            if case['mode'] in ['send','race']:
                result = ns['http_post']('/api/send_private',{'user_id':'fixture-owner','message':'fixture-body'})
                require((result.get('ok') is True) == (case['mode']=='send'), 'SEND_RESULT')
            else:
                with patch.object(sys,'argv',['fixture']+(['--dry-run'] if case['mode']=='dry' else [])):
                    ns['main']()
        text = output.getvalue()
        require(payload['token'] not in text+errors.getvalue() and 'FIXTURE_PRIVATE_CANARY' not in text+errors.getvalue(), 'OUTPUT_LEAK')
        require(not errors.getvalue(), 'UNEXPECTED_STDERR')
        for line in text.splitlines():
            data = json.loads(line)
            require(set(data) <= {'source','script','state','deliveryAllowed','bridgeReachable','onebotConnected','healthy'}, 'UNSAFE_SUMMARY_KEYS')
            require(data['source']=='legacy-status-report' and data['script']=='python' and data['deliveryAllowed'] is False, 'SUMMARY_METADATA')
            if case['mode']=='dry': require(data['state']=='dry_run' and data['healthy'] and data['onebotConnected'], 'DRY_SUMMARY')
        require(bool(text.strip()) == (case['mode']!='send'), 'EXPECTED_SUMMARY')
        results.append({'name':case['name'],'calls':calls,'ok':True})
    except Exception:
        print(json.dumps({'ok':False,'case':case['name'],'code':'PYTHON_FIXTURE_FAILED'}));sys.exit(1)
print(json.dumps({'ok':True,'version':platform.python_version(),'checks':checks,'results':results}))
`;

// This file is generated ONLY under the disposable test directory. Both names
// run this same dispatcher; neither ever imports a network library or curl.
const stub = String.raw`
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const s=JSON.parse(fs.readFileSync(process.env.FIXTURE_SCENARIO,'utf8'));
const trace=process.env.FIXTURE_TRACE;
const append=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\n',{mode:0o600});
const require=(ok,code)=>{if(!ok){append({tool:'violation',code});process.exit(97);}};
const tool=process.argv[1].endsWith('/curl')?'curl':'jq', args=process.argv.slice(2);
if(tool==='jq') {
  const input=fs.readFileSync(0), normalized=args.at(-1)?.replace(/\s+/g,' ').trim();
  const filters={
    policy:'if length == 1 and (.[0] | type) == "object" and (.[0].centralized | type) == "boolean" then .[0].centralized | tostring else error("invalid policy") end',
    auth:'.token',
    health:'if type == "object" then {source:"legacy-status-report",script:"shell",state:"dry_run",deliveryAllowed:false, healthy:(.ok == true),onebotConnected:(.onebotConnected == true)} else error("invalid health") end',
    payload:'{user_id: $user_id, message: $msg, source: "legacy-status-report"}'
  };
  const role=Object.keys(filters).find(k=>filters[k]===normalized);
  append({tool:'jq',role:role??'unknown'});
  require(Boolean(role),'JQ_FILTER_NOT_ALLOWLISTED');
  const flags={policy:['-esr'],auth:['-er'],health:['-ce'],payload:['-n','--arg','user_id','fixture-owner','--arg','msg','fixture-body']};
  require(JSON.stringify(args.slice(0,-1))===JSON.stringify(flags[role]),'JQ_FILE_OR_FLAGS_NOT_ALLOWLISTED');
  const r=spawnSync(process.env.FIXTURE_JQ,args,{input,env:process.env,maxBuffer:65536});
  require(!r.error,'JQ_EXEC_FAILED');
  process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??96);
}
let url, method='GET', data, writeout=false, limit, timeout, follow=false;
const headers={};
for(let i=0;i<args.length;i++) {
  const a=args[i];
  if(a==='-sf')continue;
  if(a==='-X'){method=args[++i];continue;}
  if(a==='-d'){data=args[++i];continue;}
  if(a==='-H'){const h=args[++i],n=h.indexOf(':');headers[h.slice(0,n).toLowerCase()]=h.slice(n+1).trim();continue;}
  if(a==='-w'){require(args[++i]==='\\n%{http_code}','WRITEOUT_FORMAT');writeout=true;continue;}
  if(a==='--max-filesize'){limit=Number(args[++i]);continue;}
  if(a==='--max-time'){timeout=Number(args[++i]);continue;}
  if(a==='--connect-timeout'){require(args[++i]==='2','CONNECT_TIMEOUT');continue;}
  if(a==='-L'||a==='--location'){follow=true;continue;}
  if(a.startsWith('http://')){require(!url,'MULTIPLE_URLS');url=a;continue;}
  require(false,'CURL_ARGUMENT_NOT_ALLOWLISTED');
}
const endpoints={'http://127.0.0.1:6200/api/owner/notification-policy':'policy',
  'http://127.0.0.1:6200/health':'health','http://127.0.0.1:6200/api/admin/session':'auth',
  'http://127.0.0.1:6200/api/send_private':'send'};
const endpoint=endpoints[url];require(Boolean(endpoint),'URL_NOT_ALLOWLISTED');
const old=fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
const policyIndex=old.filter(x=>x.tool==='curl'&&x.endpoint==='policy').length;
let safe={tool:'curl',endpoint,method};
if(endpoint==='send') {
  const body=JSON.parse(data??'null');
  safe={...safe,sourceTagged:body?.source==='legacy-status-report',authenticated:headers['x-hermes-qq-admin']===s.token,
    safeOrigin:headers.origin==='http://127.0.0.1:6200',bodyMatched:body?.user_id==='fixture-owner'&&body?.message==='fixture-body'};
}
append(safe);
require(!follow&&Number.isFinite(timeout)&&timeout>0&&timeout<=15,'REDIRECT_OR_TIMEOUT');
let status=200,body;
if(endpoint==='policy') {
  require(method==='GET'&&Object.keys(headers).length===0&&timeout===5&&limit===4096&&writeout,'POLICY_AUTH_OR_LIMITS');
  const p=s.policies[Math.min(policyIndex,s.policies.length-1)];
  if(p.offline)process.exit(7);
  status=p.status;body=p.body;
} else if(endpoint==='health') {
  require(method==='GET','HEALTH_METHOD');
  body=JSON.stringify({ok:true,onebotConnected:true,token:s.token,qqLogin:{recent:['FIXTURE_PRIVATE_CANARY']}});
} else if(endpoint==='auth') {
  require(method==='GET','AUTH_METHOD');body=JSON.stringify({token:s.token});
} else {
  require(method==='POST'&&safe.sourceTagged&&safe.authenticated&&safe.safeOrigin&&safe.bodyMatched,'SEND_CONTRACT');
  body='{"ok":true}';
}
if(status>=400)process.exit(22);
if(limit!==undefined&&Buffer.byteLength(body)>limit)process.exit(63);
process.stdout.write(body+(writeout?'\n'+status:''));
`;

let temp;
try {
  check(Number(process.versions.node.split('.')[0]) >= 22, 'NODE22_REQUIRED');
  for (const executable of [python, jq, bash]) fs.accessSync(executable, fs.constants.X_OK);
  const hashes = [pythonFile, shellFile].map(file => digest(fs.readFileSync(file)));
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-owner-notifier-test-'));
  fs.chmodSync(temp, 0o700);
  const bin = path.join(temp, 'bin'), home = path.join(temp, 'home');
  fs.mkdirSync(bin); fs.mkdirSync(home);
  const token = crypto.randomBytes(24).toString('hex');
  for (const tool of ['curl', 'jq']) fs.writeFileSync(path.join(bin, tool),
    `#!${process.execPath}\n${stub}`, { mode: 0o700 });
  const childEnv = { HOME: home, PATH: bin, LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC',
    HERMES_QQ_OWNER_ID: 'fixture-owner', PYTHONDONTWRITEBYTECODE: '1' };
  function fixture(lang, c, index) {
    const dir = path.join(temp, `${lang}-${c.name}`), stateRoot = path.join(dir, 'state');
    fs.mkdirSync(stateRoot, { recursive: true });
    if (index % 2 === 0) {
      fs.mkdirSync(path.join(stateRoot, 'data'));
      fs.writeFileSync(path.join(stateRoot, 'data/.last_status_state'), 'LAST_ONEBOT=true\nLAST_STALE=false\n', { mode: 0o600 });
    }
    return { ...c, stateRoot, dir, before: stateSnapshot(stateRoot) };
  }
  const pyCases = cases.map((c,i) => fixture('python', c, i));
  const py = spawnSync(python, ['-I', '-S', '-B', '-c', pythonHarness, pythonFile], {
    env: childEnv, cwd: temp, input: JSON.stringify({ cases: pyCases, token }), encoding: 'utf8',
    timeout: 60000, maxBuffer: 1024 * 1024,
  });
  check(!py.error && py.status === 0, 'PYTHON_HARNESS_FAILED');
  let pyResult; try { pyResult = JSON.parse(py.stdout); } catch { check(false, 'PYTHON_RESULT_INVALID'); }
  check(pyResult.ok === true && pyResult.results.length === cases.length, 'PYTHON_CASE_COUNT');
  let pythonRequests = 0;
  for (const c of pyCases) {
    const result = pyResult.results.find(row => row.name === c.name);
    check(JSON.stringify(result.calls) === JSON.stringify(expectedRequests(c.mode)), `PYTHON_ORDER_${c.name}`);
    check(stateSnapshot(c.stateRoot) === c.before, `PYTHON_STATE_WRITE_${c.name}`);
    pythonRequests += result.calls.length;
  }
  const shell = fs.readFileSync(shellFile, 'utf8');
  const gateEnd = shell.indexOf('\nlegacy_delivery_allowed || exit 0');
  const sendStart = shell.indexOf('\nsend_msg() {'), sendEnd = shell.indexOf('\n# Dry runs');
  check(gateEnd > 0 && sendStart > gateEnd && sendEnd > sendStart, 'SHELL_FUNCTION_LAYOUT_CHANGED');
  // Extract unmodified functions for send-helper fixtures, avoiding normal
  // reporting/state writes; refusal/dry-run cases run the actual entire file.
  const helpers = shell.slice(0, gateEnd) + shell.slice(sendStart, sendEnd)
    + '\nOWNER_ID=fixture-owner\nsend_msg fixture-body\n';
  let curlInvocations = 0, jqInvocations = 0;
  for (const [index, item] of cases.entries()) {
    const c = fixture('shell', item, index), trace = path.join(c.dir, 'trace.jsonl');
    const scenario = path.join(c.dir, 'scenario.json');
    fs.writeFileSync(scenario, JSON.stringify({ ...item, token }), { mode: 0o600 });
    const helper = c.mode === 'send' || c.mode === 'race';
    const args = helper ? ['--noprofile', '--norc', '-c', helpers]
      : ['--noprofile', '--norc', shellFile, ...(c.mode === 'dry' ? ['--dry-run'] : [])];
    const r = spawnSync(bash, args, { env: { ...childEnv, HERMES_QQ_HOME: c.stateRoot,
      FIXTURE_SCENARIO: scenario, FIXTURE_TRACE: trace, FIXTURE_JQ: jq }, cwd: temp,
    encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    check(!r.error && r.status === (c.mode === 'race' ? 1 : 0), `SHELL_EXIT_${c.name}`);
    const rows = fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const violation = rows.find(row => row.tool === 'violation');
    check(!violation, `STUB_${violation?.code ?? 'CONTRACT'}_${c.name}`);
    const calls = rows.filter(row => row.tool === 'curl');
    check(JSON.stringify(calls.map(row => `${row.method}:${row.endpoint}`)) === JSON.stringify(expectedRequests(c.mode)),
      `SHELL_ORDER_${c.name}`);
    check(!r.stdout.includes(token) && !r.stderr.includes(token)
      && !r.stdout.includes('FIXTURE_PRIVATE_CANARY') && !r.stderr.includes('FIXTURE_PRIVATE_CANARY'), `SHELL_OUTPUT_LEAK_${c.name}`);
    check(r.stderr === '', `SHELL_STDERR_${c.name}`);
    const output = r.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    check(output.length === (c.mode === 'send' ? 0 : 1), `SHELL_SUMMARY_COUNT_${c.name}`);
    for (const row of output) {
      check(Object.keys(row).every(k => ['source','script','state','deliveryAllowed','healthy','onebotConnected'].includes(k)), 'SHELL_SUMMARY_KEYS');
      check(row.source === 'legacy-status-report' && row.script === 'shell' && row.deliveryAllowed === false, 'SHELL_SUMMARY_METADATA');
      if (c.mode === 'dry') check(row.state === 'dry_run' && row.healthy === true && row.onebotConnected === true, 'SHELL_DRY_SUMMARY');
    }
    if (c.mode === 'send') check(calls.at(-1).sourceTagged && calls.at(-1).authenticated
      && calls.at(-1).safeOrigin && calls.at(-1).bodyMatched, 'SHELL_SEND_SOURCE_AUTH');
    check(stateSnapshot(c.stateRoot) === c.before, `SHELL_STATE_WRITE_${c.name}`);
    curlInvocations += calls.length;
    jqInvocations += rows.filter(row => row.tool === 'jq').length;
  }
  check([pythonFile, shellFile].every((file,i) => digest(fs.readFileSync(file)) === hashes[i]), 'LEGACY_SOURCE_CHANGED');
  console.log(JSON.stringify({ ok: true, cases: cases.length * 2, pythonCases: cases.length, shellCases: cases.length,
    assertions: assertions + pyResult.checks, nodeVersion: process.versions.node, pythonVersion: pyResult.version,
    actualInvocations: { node: 1 + curlInvocations + jqInvocations, nodeHarness: 1,
      nodeCurlStub: curlInvocations, nodeJqStub: jqInvocations, python: 1, bash: cases.length, systemJq: jqInvocations },
    stubRequests: { pythonUrllib: pythonRequests, shellCurl: curlInvocations },
    realNetworkRequests: 0, realCurlInvocations: 0, legacyStateWrites: 0, productionActions: 0 }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.fixtureCode ?? 'HARNESS_FAILED' }));
  process.exitCode = 1;
} finally {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
}
