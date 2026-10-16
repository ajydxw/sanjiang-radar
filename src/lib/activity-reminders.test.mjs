import assert from 'node:assert/strict';
import test from 'node:test';
import { REMINDER_STORAGE_KEY, readReminderPreferences, getReminderOptions, buildReminderEvents, createReminderCalendar } from './activity-reminders.ts';

const now = new Date('2026-10-13T08:00:00+08:00');
const item = (fields = {}) => ({
  id: 'pu-123', title: '校园讲座', category: 'PU活动', summary: '公开通知', source: 'PU官方活动',
  sourceType: 'pu', sourcePortal: 'https://class.pocketuni.net/activity/detail?id=123', publishedAt: '',
  freshmanAllowed: 'unknown', colleges: [], rewardNote: '待确认', importance: 'normal',
  registrationMethod: '查看官方渠道', verification: 'PU官方活动', demo: false,
  registrationStart: '2026-10-14T10:00:00+08:00', registrationDeadline: '2026-10-15T18:00:00+08:00',
  ...fields,
});
const unfold = text => text.replace(/\r\n /g, '');

test('版本化设置过滤坏值和原型键，保留正常项并默认启用', () => {
  assert.equal(REMINDER_STORAGE_KEY, 'sanjiang-radar-reminders-v1');
  for (const raw of [null, '', '{', 'null', '[]', '{}', '{"version":0,"items":{"good":{"start":false,"deadline":false}}}', '{"version":1,"items":[]}']) {
    assert.equal(Object.keys(readReminderPreferences(raw)).length, 0);
  }
  const preferences = readReminderPreferences('{"version":1,"items":{"__proto__":{"start":false,"deadline":false},"constructor":{"start":false,"deadline":false},"prototype":{"start":false,"deadline":false},"bad":{"start":"false","deadline":true},"good":{"start":false,"deadline":true},"alsoGood":{"start":true,"deadline":false}}}');
  assert.deepEqual(Object.keys(preferences), ['good', 'alsoGood']);
  assert.deepEqual(getReminderOptions(preferences, 'good'), { start: false, deadline: true });
  assert.deepEqual(getReminderOptions(preferences, 'missing'), { start: true, deadline: true });
  assert.deepEqual(getReminderOptions(preferences, '__proto__'), { start: true, deadline: true });
  assert.deepEqual(getReminderOptions(Object.create({ inherited: { start: false, deadline: false } }), 'inherited'), { start: true, deadline: true });
  assert.equal(Object.prototype.start, undefined);
});

test('设置大小与数量有界', () => {
  assert.equal(Object.keys(readReminderPreferences(' '.repeat(256001))).length, 0);
  const entries = Object.fromEntries(Array.from({ length: 1005 }, (_, index) => [`id-${index}`, { start: true, deadline: false }]));
  assert.equal(Object.keys(readReminderPreferences(JSON.stringify({ version: 1, items: entries }))).length, 1000);
  assert.equal(Object.keys(readReminderPreferences(JSON.stringify({ version: 1, items: { ['a'.repeat(201)]: { start: true, deadline: true }, ok: { start: false, deadline: false } } }))).length, 1);
});

test('只为可用的未结束活动创建已知未来报名时间，允许资格未知并提醒核对', () => {
  for (const fields of [
    { demo: true }, { freshmanAllowed: 'excluded' }, { sourceAvailable: false }, { remainingSlots: 0 },
    { officialStatus: '已取消' }, { officialStatus: '活动已取消' }, { officialStatus: '禁止报名' },
    { officialStatus: '报名已结束' }, { officialStatus: '报名已满' }, { eventEnd: '2026-10-13T07:59:00+08:00' },
    { registrationDeadline: '2026-10-13T08:00:00+08:00' }, { eventEnd: '2026-10-12' },
    { registrationDeadline: '2026-10-12' }, { registrationStart: undefined, registrationDeadline: undefined },
  ]) assert.equal(buildReminderEvents([item(fields)], {}, now).length, 0, JSON.stringify(fields));
  const events = buildReminderEvents([item({ remainingSlots: undefined }), item({ id: 'pu-456', freshmanAllowed: 'allowed' })], {}, now);
  assert.equal(events.length, 4);
  assert.match(events[0].description, /资格未知/);
  assert.match(events[0].description, /奖励不保证/);
  assert.match(events[0].description, /官方原文：https:/);
  assert.match(events[0].description, /快照，非实时/);
  assert.match(events[0].description, /不会自动同步变更/);
  assert.equal(buildReminderEvents([item({ registrationNote: '如需取消报名请联系主办方' })], {}, now).length, 2);
});

test('提醒选项、去重和时间排序', () => {
  const prefs = { 'pu-123': { start: false, deadline: true }, other: { start: true, deadline: false }, off: { start: false, deadline: false } };
  const events = buildReminderEvents([item(), item(), item({ id: 'other', registrationStart: '2026-10-13T11:00:00+08:00' }), item({ id: 'off' })], prefs, now);
  assert.deepEqual(events.map(event => [event.itemId, event.kind]), [['other', 'start'], ['pu-123', 'deadline']]);
  const dayEvents = buildReminderEvents([item({ registrationStart: undefined }), item({ id: 'day', registrationStart: undefined, registrationDeadline: '2026-10-15' })], {}, now);
  assert.deepEqual(dayEvents.map(event => event.itemId), ['day', 'pu-123']);
});

test('具体时间须包含时区且日期真实，不接受归一化错误日期或未知时间', () => {
  for (const at of [undefined, '', '时间待定', '2026-10-14T10:00:00', '2026-10-14 10:00:00+08:00', '2027-02-30T10:00:00+08:00', '2027-02-29T10:00:00Z', '2027-04-31T10:00:00Z', '2026-13-01T10:00:00Z', '2026-10-14T24:00:00+08:00', '2026-10-14T10:60:00+08:00', '2026-10-14T10:00:60Z', '2026-10-14T10:00:00+24:00', '2026-10-14T10:00:00+08:60', '2027-02-30', '2026-10-14']) {
    assert.equal(buildReminderEvents([item({ registrationStart: at, registrationDeadline: undefined })], {}, now).length, 0, String(at));
  }
  assert.equal(buildReminderEvents([item({ registrationStart: undefined, registrationDeadline: '2027-02-30' })], {}, now).length, 0);
  for (const at of ['2026-10-14T10:00:00+08:00', '2026-10-14T02:00:00Z', '2026-10-13T22:00:00-04:00', '2026-10-14T10:00+08:00', '2026-10-14T10:00:00.123+08:00', '2028-02-29T10:00:00Z']) {
    const [event] = buildReminderEvents([item({ registrationStart: at, registrationDeadline: undefined })], {}, now);
    assert.equal(event.at, at);
    assert.equal(event.dateOnly, false);
  }
  assert.equal(buildReminderEvents([item()], {}, new Date('bad')).length, 0);
});

test('开始提醒前10分钟及开始时，截止前24小时、1小时及截止时，跳过过去提醒点', () => {
  const [start, deadline] = buildReminderEvents([item()], {}, now);
  assert.deepEqual(start.alarmTimes, ['2026-10-14T01:50:00.000Z', '2026-10-14T02:00:00.000Z']);
  assert.deepEqual(deadline.alarmTimes, ['2026-10-14T10:00:00.000Z', '2026-10-15T09:00:00.000Z', '2026-10-15T10:00:00.000Z']);
  const late = new Date('2026-10-15T17:30:00+08:00');
  const [lateDeadline] = buildReminderEvents([item()], {}, late);
  assert.deepEqual(lateDeadline.alarmTimes, ['2026-10-15T10:00:00.000Z']);
  const [nearStart] = buildReminderEvents([item()], {}, new Date('2026-10-14T09:55:00+08:00'));
  assert.deepEqual(nearStart.alarmTimes, ['2026-10-14T02:00:00.000Z']);
  const [lastHour] = buildReminderEvents([item()], {}, new Date('2026-10-15T12:00:00+08:00'));
  assert.deepEqual(lastHour.alarmTimes, ['2026-10-15T09:00:00.000Z', '2026-10-15T10:00:00.000Z']);
});

test('仅日期的截止保留全天日期，09点是检查提醒且只保留未来提醒', () => {
  const [event] = buildReminderEvents([item({ registrationStart: '2026-10-14', registrationDeadline: '2026-10-15' })], {}, now);
  assert.equal(event.at, '2026-10-15');
  assert.equal(event.dateOnly, true);
  assert.match(event.title, /具体时刻未公布/);
  assert.match(event.description, /不代表截止时刻/);
  assert.deepEqual(event.alarmTimes, ['2026-10-14T01:00:00.000Z', '2026-10-15T01:00:00.000Z']);
  const [sameDay] = buildReminderEvents([item({ registrationStart: undefined, registrationDeadline: '2026-10-13' })], {}, now);
  assert.deepEqual(sameDay.alarmTimes, ['2026-10-13T01:00:00.000Z']);
  const [afterNine] = buildReminderEvents([item({ registrationStart: undefined, registrationDeadline: '2026-10-13' })], {}, new Date('2026-10-13T12:00:00+08:00'));
  assert.deepEqual(afterNine.alarmTimes, []);
  assert.equal(buildReminderEvents([item({ registrationStart: undefined, registrationDeadline: '2026-10-13' })], {}, new Date('2026-10-14T00:00:00+08:00')).length, 0);
});

test('ICS采用CRLF、UTC具体时间和绝对提醒，全天日期DTEND为次日', () => {
  const events = buildReminderEvents([item(), item({ id: 'day', registrationStart: undefined, registrationDeadline: '2026-10-15' })], {}, now);
  const calendar = createReminderCalendar(events, now);
  const text = unfold(calendar);
  assert.match(text, /VERSION:2.0\r\n/);
  assert.match(text, /METHOD:PUBLISH\r\n/);
  assert.match(text, /DTSTAMP:20261013T000000Z\r\n/);
  assert.match(text, /DTSTART:20261014T020000Z\r\nDTEND:20261014T020500Z\r\n/);
  assert.match(text, /DTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261016\r\n/);
  assert.match(text, /TRIGGER;VALUE=DATE-TIME:20261014T015000Z/);
  assert.match(text, /ACTION:DISPLAY\r\nDESCRIPTION:/);
  const monthEnd = createReminderCalendar(buildReminderEvents([item({ registrationStart: undefined, registrationDeadline: '2026-10-31' })], {}, now), now);
  assert.match(monthEnd, /DTEND;VALUE=DATE:20261101/);
  assert.equal(calendar.replace(/\r\n/g, '').includes('\n'), false);
  assert.ok(calendar.endsWith('END:VCALENDAR\r\n'));
  const later = createReminderCalendar(events, new Date('2026-10-15T17:30:00+08:00'));
  assert.equal((later.match(/BEGIN:VALARM/g) || []).length, 1);
  assert.match(later, /TRIGGER;VALUE=DATE-TIME:20261015T100000Z/);
});

test('同一来源时间UID稳定、改期有新UID，重复事件只导出一次', () => {
  const events = buildReminderEvents([item()], {}, now);
  const identities = output => [...output.matchAll(/UID:([^\r\n]+)/g)].map(match => match[1]);
  assert.deepEqual(identities(createReminderCalendar(events, now)), identities(createReminderCalendar(events, new Date(now.getTime() + 1000))));
  assert.deepEqual(identities(createReminderCalendar([...events, ...events], now)), identities(createReminderCalendar(events, now)));
  const changed = buildReminderEvents([item({ registrationStart: '2026-10-14T11:00:00+08:00' })], {}, now);
  assert.notEqual(identities(createReminderCalendar(events, now))[0], identities(createReminderCalendar(changed, now))[0]);
});

test('长中文及emoji不拆unicode且每行不超75字节，TEXT转义防换行注入', () => {
  const title = '中文😀'.repeat(50) + '，comma,semi;back\\slash\r\nBEGIN:VEVENT\rEND:VCALENDAR';
  const calendar = createReminderCalendar(buildReminderEvents([item({ title, source: '来源,分号;\\\r\n恶意行' })], {}, now), now);
  for (const line of calendar.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
    assert.equal(line.includes('\ufffd'), false);
  }
  assert.equal(calendar.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length, 2);
  assert.equal(calendar.split('\r\n').filter(line => line === 'END:VCALENDAR').length, 1);
  const decoded = unfold(calendar);
  assert.match(decoded, /comma\\,semi\\;back\\\\slash\\nBEGIN:VEVENT\\nEND:VCALENDAR/);
  assert.match(decoded, /来源\\,分号\\;\\\\\\n恶意行/);
});

test('恶意或含凭据链接不进入description或URL，公开官方原文可导出', () => {
  for (const sourcePortal of ['javascript:alert(1)', 'file:///C:/private', 'https://user:password@example.edu/', 'https://example.edu/\r\nBEGIN:VEVENT', 'https://example.edu/?access_token=private', 'https://example.edu/?accessToken=private', 'https://example.edu/#session=private', 'http://localhost:4398/', 'http://127.0.0.1/', 'http://192.168.1.2/', 'http://[::1]/', 'http://0x7f000001/']) {
    const events = buildReminderEvents([item({ sourcePortal })], {}, now);
    assert.equal(events[0].sourcePortal, '', sourcePortal);
    const calendar = unfold(createReminderCalendar(events, now));
    assert.equal(calendar.includes('\r\nURL:'), false);
    assert.equal(calendar.includes('private'), false);
    assert.match(calendar, /链接不可用/);
    assert.equal(unfold(createReminderCalendar([{ ...events[0], sourcePortal }], now)).includes('\r\nURL:'), false);
  }
  const calendar = unfold(createReminderCalendar(buildReminderEvents([item({ sourcePortal: 'http://www.sju.edu.cn/news?id=3&from=radar' })], {}, now), now));
  assert.match(calendar, /\r\nURL:http:\/\/www.sju.edu.cn\/news\?id=3&from=radar\r\n/);
});
