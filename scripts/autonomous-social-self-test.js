import { spawnSync } from 'node:child_process';
const suites = [
  'model-credentials-self-test.js', 'agent-prompt-self-test.js',
  'public-sticker35-self-test.js', 'owner-guidance-self-test.js',
  'social-delegation-self-test.js', 'owner-social-controller-self-test.js',
  'autonomous-social-migration-self-test.js', 'people-reconstruction-self-test.js',
  'people-reconstruction-host-self-test.js', 'qzone-autonomy35-self-test.js',
  'autonomous-social-ui-self-test.js', 'autonomous-social-host-regression-self-test.js',
  'autonomous-social-bridge-self-test.js'
];
let failed = false;
for (const suite of suites) {
  const child = spawnSync(process.execPath, [`scripts/${suite}`], { encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  process.stdout.write(child.stdout || '');
  if (child.status !== 0 || child.error) { process.stderr.write(child.stderr || 'suite failed'); failed = true; }
}
console.log(JSON.stringify({ ok: !failed, suites: suites.length, evidence: 'isolated synthetic fixtures; not real QQ/model/human acceptance' }));
process.exitCode = failed ? 1 : 0;
