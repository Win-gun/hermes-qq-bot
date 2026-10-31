// Published template only; no live HOME, model, QQ or credential access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { migrateOwnerFirstConfig } from '../src/owner-first-migration.js';

const template = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const original = structuredClone(template);
const absent = migrateOwnerFirstConfig(template);
assert.equal(absent.changed, false, 'no configured owner grants no new authority');
assert.deepEqual(template, original, 'migration is pure');

const configured = structuredClone(template);
configured.privateChats.ownerUserIds = ['21001'];
const migrated = migrateOwnerFirstConfig(configured);
const c = migrated.config;
assert.equal(migrated.changed, true);
assert.equal(c.memory.people.enabled, true);
assert.equal(c.ownerControl.enabled, true);
assert.equal(c.ownerControl.naturalLanguage, true);
assert.equal(c.ownerControl.usageEnabled, true);
assert.equal(c.ownerControl.lowRiskDirect, true, 'template must not masquerade as a user opt-out');
assert.equal(c.ownerControl.targetMode, 'inherited', 'unknown joined groups are resolved by the actual host');
assert.deepEqual(c.ownerControl.allowedTargets, [], 'no fabricated group permission');
assert.equal(c.ownerNotifications.enabled, true);
assert.deepEqual(c.ownerNotifications.times, ['09:00', '21:00']);
assert.equal(c.ownerNotifications.timezone, 'Asia/Shanghai');
assert.deepEqual(c.accounts, configured.accounts);
assert.deepEqual(c.apiCenter, configured.apiCenter);
assert.equal(migrateOwnerFirstConfig(c).changed, false, 'one-shot upgrade is idempotent');

const restricted = structuredClone(configured);
restricted.ownerControl.lowRiskDirect = false;
assert.equal(migrateOwnerFirstConfig(restricted).config.ownerControl.lowRiskDirect, false,
  'a saved user restriction still wins');
console.log(JSON.stringify({ok:true,assertions:17,fixtureOnly:true,realQQ:false,productionIO:false}));
