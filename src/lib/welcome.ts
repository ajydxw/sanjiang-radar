export const WELCOME_STORAGE_KEY = 'sanjiang-radar-welcome-v1';

/** Only an explicitly configured HTTPS root can open the separate private site. */
export function identityEntryUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      ? url.origin + '/' : null;
  } catch { return null; }
}
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const mornings = ['早上好', '，晨光正好', '，与清晨相逢', '，新的一页'];

/** Campus greetings use China time, independent of the device's timezone. */
export function welcomeGreeting(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const day = new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
  const weekday = weekdays[day.getUTCDay()];
  // Monday 1970-01-05 anchors a stable four-week rotation; no API or tracking.
  const week = Math.floor((day.getTime() - Date.UTC(1970, 0, 5)) / 604800000);
  const rotation = ((week % mornings.length) + mornings.length) % mornings.length;
  const hour = value('hour');
  const text = hour >= 5 && hour < 11 ? `${weekday}${mornings[rotation]}`
    : hour >= 11 && hour < 14 ? ['午间小憩', '午安，三江', '正午的片刻', '午后的序章'][rotation]
    : hour >= 14 && hour < 18 ? ['午后微风', '光落在书页上', '与晴光相遇', '日光缓缓'][rotation]
    : hour >= 18 || hour < 2 ? '月光下的对话' : '星光未眠';
  return { text, weekday, hour, day: day.getTime(), period: hour >= 5 && hour < 18 ? 'day' : 'night' };
}

export function shouldShowWelcome(hash: string, seen: boolean) {
  return !seen && (hash === '' || hash === '#' || hash === '#radar');
}

/** Name may only come from a verified server session. Guests pass no name. */
export function personalizedGreeting(greeting: string, verifiedDisplayName?: string) {
  const name = verifiedDisplayName?.trim();
  return name ? `${greeting}，${name}` : greeting;
}

const compoundSurnames = ['欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '长孙', '宇文', '司徒', '夏侯', '轩辕', '令狐', '钟离', '端木', '南宫', '西门', '独孤', '呼延', '申屠', '太史', '闻人', '万俟', '濮阳', '百里', '赫连'];

/** Friendly form of address: a two-character given name when it can be split safely, otherwise the full name. */
export function callName(name: string) {
  const full = name.trim();
  if (!/^\p{Script=Han}{3,4}$/u.test(full)) return full;
  const given = Array.from(full).slice(compoundSurnames.includes(full.slice(0, 2)) ? 2 : 1);
  return given.length === 2 ? given.join('') : full;
}

const hashText = (text: string) => Array.from(text).reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) >>> 0, 7);
const wishes = [
  '今天想弄懂什么，我陪你一起拆开来看。',
  '有卡住的地方就说出来，我们一步一步理清。',
  '好问题是答案的一半，从你最好奇的那个开始。',
  '写作、代码还是课程难点？随时开口。',
  '复杂的事交给我拆解，最后由你来做决定。',
  '慢慢来，一个清楚的问题胜过十个模糊的答案。',
  '今天冒出的灵感，值得被认真对待。',
  '愿你今天有所收获，也有片刻轻松。',
];

/** Per-member greeting for the class assistant; the name must come from the verified server session. */
export function assistantGreeting(name: string, date: Date, usage: { budgetMicros: number; spentMicros: number; remainingMicros: number }) {
  const { weekday, hour, day } = welcomeGreeting(date);
  // Plain greeting so the name stands out; the home page keeps its poetic variants.
  const text = hour >= 5 && hour < 11 ? '早上好' : hour >= 11 && hour < 14 ? '中午好' : hour >= 14 && hour < 18 ? '下午好' : hour >= 18 && hour < 23 ? '晚上好' : '还没睡呀';
  const call = callName(name);
  const chars = Array.from(call);
  const hint = hour >= 23 || hour < 5 ? '夜深了，问完这个就早点休息吧。'
    : usage.spentMicros === 0 ? '第一次来？先用 Luna 问个小问题试试吧。'
    : usage.remainingMicros < usage.budgetMicros * 0.1 ? '额度剩余不多，日常问题优先用 Luna 更省。'
    : weekday === '周六' || weekday === '周日' ? '周末也来充电，给认真的自己点个赞。' : '';
  return {
    lead: text,
    call,
    weekday,
    title: call ? `${text}，${call}` : text,
    // Same member sees one wish per China day; different members usually see different wishes.
    wish: wishes[hashText(`${call}|${day}`) % wishes.length],
    hint,
    initials: /^\p{Script=Han}+$/u.test(call) ? chars.slice(-2).join('') : (chars[0] || '你').toUpperCase(),
    hue: hashText(call) % 360,
  };
}
