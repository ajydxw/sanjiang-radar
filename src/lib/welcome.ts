export const WELCOME_STORAGE_KEY = 'sanjiang-radar-welcome-v1';
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
  return { text, weekday, period: hour >= 5 && hour < 18 ? 'day' : 'night' };
}

export function shouldShowWelcome(hash: string, seen: boolean) {
  return !seen && (hash === '' || hash === '#' || hash === '#radar');
}

/** Name may only come from a verified server session. Guests pass no name. */
export function personalizedGreeting(greeting: string, verifiedDisplayName?: string) {
  const name = verifiedDisplayName?.trim();
  return name ? `${greeting}，${name}` : greeting;
}
