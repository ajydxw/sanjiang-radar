import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { welcomeGreeting, shouldShowWelcome, personalizedGreeting } from './welcome.ts';

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
