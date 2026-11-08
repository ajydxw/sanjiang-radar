import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { welcomeGreeting, shouldShowWelcome, personalizedGreeting, identityEntryUrl, callName, assistantGreeting } from './welcome.ts';

test('morning varies by weekday and four-week rotation in China time', () => {
 const a = welcomeGreeting(new Date('2026-10-26T00:00:00Z'));
 assert.match(a.text, /^周一/);
 assert.match(welcomeGreeting(new Date('2026-10-27T00:00:00Z')).text, /^周二/);
 assert.notEqual(a.text, welcomeGreeting(new Date('2026-11-02T00:00:00Z')).text);
 assert.equal(a.text, welcomeGreeting(new Date('2026-11-23T00:00:00Z')).text);
});
test('time boundaries and exact poetic evening greeting', () => {
 assert.equal(welcomeGreeting(new Date('2026-10-30T10:00:00Z')).text, '月光下的对话');
 assert.equal(welcomeGreeting(new Date('2026-10-30T16:00:00Z')).text, '月光下的对话');
 assert.equal(welcomeGreeting(new Date('2026-10-30T18:00:00Z')).text, '星光未眠');
 assert.match(welcomeGreeting(new Date('2026-10-30T21:00:00Z')).text, /^周六/);
 assert.doesNotMatch(welcomeGreeting(new Date('2026-10-30T03:00:00Z')).text, /早|月光/);
});
test('only root and radar open once per browsing session; deep links remain direct', () => {
 for (const hash of ['', '#', '#radar']) { assert.equal(shouldShowWelcome(hash, false), true); assert.equal(shouldShowWelcome(hash, true), false); }
 for (const hash of ['#profile', '#saved', '#discover', '#unknown']) assert.equal(shouldShowWelcome(hash, false), false);
});
test('identity placeholder cannot collect inputs or claim authentication; animations respect motion preferences', () => {
 const component = fs.readFileSync('src/components/welcome-screen.tsx', 'utf8');
 assert.doesNotMatch(component, /<input|<form|fetch\(|localStorage/);
 assert.match(component, /暂未开放/);
 const identity = fs.readFileSync('src/components/identity-confirmation.tsx', 'utf8');
 assert.match(identity, /NEXT_PUBLIC_IDENTITY_ENABLED === '1'/);
 assert.doesNotMatch(identity, /localStorage|sessionStorage/);
 assert.match(component, /onCancel/);
 const css = fs.readFileSync('src/app/globals.css','utf8');
 assert.match(css, /prefers-reduced-motion:reduce\)\{\.welcome-screen/);
 assert.doesNotMatch(css.slice(css.indexOf('/* Original lightweight radar welcome')), /infinite/);
});

test('verified identity appends name to the same greeting, guests keep original', () => {
 for (const greeting of ['周一早上好', '月光下的对话', '午间小憩']) {
  assert.equal(personalizedGreeting(greeting), greeting);
  assert.equal(personalizedGreeting(greeting, ''), greeting);
  assert.equal(personalizedGreeting(greeting, ' 张三 '), `${greeting}，张三`);
 }
});

test('private identity entry requires an explicit credential-free HTTPS root', () => {
 assert.equal(identityEntryUrl('https://identity.example/'), 'https://identity.example/');
 for (const value of [undefined, '', '/api/identity', 'http://identity.example/', 'javascript:alert(1)', 'https://user:pass@identity.example/', 'https://identity.example/?token=secret', 'https://identity.example/#name', 'https://identity.example/path']) {
  assert.equal(identityEntryUrl(value), null, value);
 }
});

test('assistant greeting: friendly name, one wish per member per China day, hints from real usage', () => {
 for (const [name, call] of [['王子涵', '子涵'], ['欧阳子涵', '子涵'], ['欧阳娜', '欧阳娜'], ['张伟', '张伟'], ['测试同学', '测试同学'], [' Alex ', 'Alex']]) assert.equal(callName(name), call, name);
 const usage = { budgetMicros: 2142857, spentMicros: 1000, remainingMicros: 2141857 };
 const mondayNoon = new Date('2026-11-09T04:00:00Z');
 const a = assistantGreeting('王子涵', mondayNoon, usage);
 assert.equal(a.title, '中午好，子涵');
 assert.equal(assistantGreeting('王子涵', new Date('2026-11-09T11:00:00Z'), usage).title, '晚上好，子涵');
 assert.equal(assistantGreeting('测试同学', mondayNoon, usage).title, '中午好，测试同学');
 assert.equal(a.initials, '子涵');
 assert.equal(a.hint, '');
 assert.equal(assistantGreeting('王子涵', new Date('2026-11-09T09:00:00Z'), usage).wish, a.wish);
 assert.equal(assistantGreeting('王子涵', mondayNoon, usage).hue, assistantGreeting('王子涵', new Date('2026-12-01T04:00:00Z'), usage).hue);
 assert.ok(new Set(['王子涵', '李明', '张伟', '陈思远', '刘一', '赵小雨', '孙浩然', '周雨桐'].map(name => assistantGreeting(name, mondayNoon, usage).wish)).size > 1);
 assert.match(assistantGreeting('王子涵', new Date('2026-11-08T16:00:00Z'), usage).hint, /夜深/);
 assert.match(assistantGreeting('王子涵', mondayNoon, { ...usage, spentMicros: 0 }).hint, /第一次/);
 assert.match(assistantGreeting('王子涵', mondayNoon, { ...usage, remainingMicros: 100 }).hint, /额度剩余不多/);
 assert.match(assistantGreeting('王子涵', new Date('2026-11-08T04:00:00Z'), usage).hint, /周末/);
 assert.equal(assistantGreeting('alex', mondayNoon, usage).initials, 'A');
});
