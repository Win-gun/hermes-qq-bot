import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registryConfig, newAccount } from '../src/account-registry.js';
import { normalizeAccountAutomation, automationForAccount, automationOwnerEntries, patchAccountAutomation, assertAutomationOwnershipTransition } from '../src/account-automation.js';
import { accountIdentityForPrompt } from '../src/bot-capabilities.js';

// Synthetic input only: no files, live config, credentials, model calls or QQ.
let checks = 0;
const check = fn => { fn(); checks++; };
const rule = (id = 'morning') => ({ id, enabled: false, timezone: 'Asia/Shanghai', scope: { conversationIds: ['group:10001'] },
  trigger: { type: 'schedule', time: '08:30', daysOfWeek: [0,1,2,3,4,5,6], windowMinutes: 3 }, action: { kind: 'message' }, prompt: 'fixture' });
const source = registryConfig({ accounts: { version: 2, topology: 'function_split', legacyPrimaryId: 'a', items: [
  { id: 'a', displayName: 'Original', protocol: 'napcat', managed: false, features: { automation: true }, style: { systemPrompt: 'original personality' } },
  { id: 'b', displayName: 'New', protocol: 'napcat', managed: false, features: { automation: true }, style: { systemPrompt: '' } }
], failoverGroups: [] }, automation: { enabled: true, rules: [rule()] },
dailyMessages: { enabled: true, schedules: [{ name: 'morning', mode: 'morning', time: '08:30', prompt: 'old morning', extra: 'retain' }] },
hourlyChat: { enabled: false, ownerUserIds: ['10001'], prompt: 'old owner message' } });
const original = structuredClone(source);
let config = normalizeAccountAutomation(source);
check(() => assert.deepEqual(source, original));
check(() => assert.deepEqual(normalizeAccountAutomation(config), config));
check(() => assert.equal(config.automation.ownershipVersion, 1));
check(() => assert.deepEqual(config.automation.rules, []));
check(() => assert.equal(config.dailyMessages.enabled, false));
check(() => assert.equal(config.automation.accounts.a.routines.daily.schedules[0].extra, 'retain'));
check(() => assert.equal(automationForAccount(config, 'a').rules[0].accountId, 'a'));
check(() => assert.deepEqual(automationForAccount(config, 'b').routines, { version: 1 }));
check(() => assert.deepEqual(automationForAccount(config, 'b').rules, []));
check(() => assert.deepEqual(config.accounts.items.map(item => item.style), original.accounts.items.map(item => item.style)));
check(() => assert.match(accountIdentityForPrompt(config, 'a'), /登记 3 条/));
check(() => assert.match(accountIdentityForPrompt(config, 'b'), /登记 0 条/));
check(() => assert(!accountIdentityForPrompt(config, 'b').includes('定期私聊')));
config.activeAccountId = 'b';
check(() => assert.equal(automationForAccount(config, 'a').owner.key, 'account:a'));
const a = structuredClone(config.automation.accounts.a);
config = patchAccountAutomation(config, 'b', { enabled: false, rules: [rule()] });
check(() => assert.deepEqual(config.automation.accounts.a, a));
check(() => assert.equal(automationForAccount(config, 'a').enabled, true));
check(() => assert.equal(automationForAccount(config, 'b').enabled, false));
check(() => assert.equal(automationForAccount(config, 'b').rules[0].accountId, 'b'));
check(() => assert.deepEqual(config.automation.accounts.b.legacyRuleIds, []));
const b = structuredClone(config.automation.accounts.b);
config = patchAccountAutomation(config, 'a', { routines: { daily: { schedules: [{ id: 'daily-0', time: '09:30' }] } } });
check(() => assert.deepEqual(config.automation.accounts.b, b));
check(() => assert.equal(config.automation.accounts.a.routines.daily.schedules[0].legacyLedgerKey, 'morning'));
check(() => assert.throws(() => patchAccountAutomation(config, 'a', { rules: [{ ...rule(), accountId: 'b' }] }), /其他账号/));
check(() => assert.throws(() => patchAccountAutomation(config, 'a', { routines: { daily: { accountId: 'b' } } }), /归属/));
check(() => assert.throws(() => patchAccountAutomation(config, 'b', { routines: { daily: { enabled: true } } }), /missing/));
check(() => assert.throws(() => patchAccountAutomation(config, 'a', { rules: [rule(), rule()] }), /无效/));
const added = structuredClone(config); added.accounts.items.push(newAccount(config, { id: 'c', displayName: 'Fresh' }));
check(() => assert.deepEqual(automationForAccount(added, 'c').rules, []));
check(() => assert.deepEqual(automationForAccount(added, 'c').routines, { version: 1 }));
const unknown = normalizeAccountAutomation({ ...source, automation: { enabled: true, rules: [{ ...rule(), accountId: 'missing' }] } });
check(() => assert.equal(unknown.automation.unassigned.length, 1));
check(() => assert.deepEqual(automationForAccount(unknown, 'a').rules, []));
check(() => assert.equal(automationOwnerEntries(config).length, 2));
const grouped = structuredClone(source);
grouped.accounts.failoverGroups = [{ id: 'shared', name: 'Explicit same bot', memberIds: ['a','b'], policyAccountId: 'a', policy: {}, settings: {} }];
const shared = normalizeAccountAutomation(grouped);
check(() => assert.equal(automationOwnerEntries(shared).length, 1));
check(() => assert.equal(automationForAccount(shared, 'a').owner.key, 'group:shared'));
check(() => assert.deepEqual(automationForAccount(shared, 'a'), automationForAccount(shared, 'b')));
check(() => assert.throws(() => assertAutomationOwnershipTransition(config, grouped), /迁移/));
check(() => assert.doesNotThrow(() => assertAutomationOwnershipTransition(config, config)));
const cleanInstall = normalizeAccountAutomation(JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
check(() => assert(automationOwnerEntries(cleanInstall).every(owner => owner.rules.length === 0 && !owner.routines.daily && !owner.routines.hourly)));
const reserved = structuredClone(config); reserved.accounts.items.push(newAccount(config, { id: 'constructor' }));
check(() => assert.deepEqual(automationForAccount(reserved, 'constructor').rules, []));
console.log(JSON.stringify({ ok: true, checks, fixtureOnly: true, migration: 'deterministic-account-owner', writes: false }));
