export const PUBLIC_FEEDS = ['sanjiang-web.json', 'pu.json', 'wechat.json', 'competitions.json', 'exams.json'];
const itemFields = new Set('id title category summary source sourceType sourcePortal publishedAt firstSeenAt description registrationStart registrationDeadline eventStart eventEnd location freshmanAllowed colleges reward rewardNote importance registrationMethod registrationNote verification demo fetchedAt manuallyVerified eligibilityEvidence dateEvidence attachments eligibleYears activityType capacity registeredCount remainingSlots officialStatus detailRead sourceAvailable'.split(' '));
const sourceFields = new Set('id name url state count lastSuccessAt lastAttemptAt note error sourceType collectedCount observedTotal pagesRead complete archivedCount selector discoveryMode'.split(' '));
const categories = ['PU活动', '竞赛', '学校通知', '讲座', '志愿活动', '校园资讯'];
const sourceTypes = ['school', 'pu', 'wechat', 'competition', 'exam'];
const dates = ['publishedAt', 'firstSeenAt', 'fetchedAt', 'registrationStart', 'registrationDeadline', 'eventStart', 'eventEnd'];
const fail = () => { throw new Error('公开信息格式或链接异常，已停止发布'); };
const string = value => typeof value === 'string' && value.length <= 20000;
const strings = value => Array.isArray(value) && value.length <= 100 && value.every(string);
const date = value => value === undefined || value === null || value === '' || string(value) && Number.isFinite(Date.parse(value));

export function safeExternalUrl(value) {
  if (!string(value) || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password &&
      ![...url.searchParams.keys()].some(key => /^(?:access_token|token|password|authorization|pass_ticket|session)$/i.test(key));
  } catch { return false; }
}

function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) fail();
}

export function assertPublicFeed(feed) {
  record(feed, new Set(['schemaVersion', 'generatedAt', 'items', 'sources', 'statistics']));
  if (feed.schemaVersion !== 1 || !string(feed.generatedAt) || !date(feed.generatedAt) || !Array.isArray(feed.items) || feed.items.length > 5000 || !Array.isArray(feed.sources) || feed.sources.length > 100) fail();
  for (const item of feed.items) {
    record(item, itemFields);
    if (!['id', 'title', 'summary', 'source', 'publishedAt', 'rewardNote', 'registrationMethod', 'verification'].every(key => string(item[key])) || !safeExternalUrl(item.sourcePortal) || !categories.includes(item.category) || !sourceTypes.includes(item.sourceType) || !['allowed', 'excluded', 'unknown'].includes(item.freshmanAllowed) || !['high', 'normal', 'secondary'].includes(item.importance) || !strings(item.colleges) || typeof item.demo !== 'boolean' || !dates.every(key => date(item[key]))) fail();
    for (const key of ['description', 'location', 'registrationNote', 'eligibilityEvidence', 'activityType', 'officialStatus']) if (item[key] != null && !string(item[key])) fail();
    for (const key of ['eligibleYears', 'dateEvidence']) if (item[key] !== undefined && !strings(item[key])) fail();
    for (const key of ['manuallyVerified', 'detailRead', 'sourceAvailable']) if (item[key] !== undefined && typeof item[key] !== 'boolean') fail();
    for (const key of ['capacity', 'registeredCount', 'remainingSlots']) if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || item[key] < 0)) fail();
    if (item.reward !== undefined) {
      record(item.reward, new Set(['kind', 'value', 'unit']));
      if (!string(item.reward.kind) || !string(item.reward.unit) || !Number.isFinite(item.reward.value) || item.reward.value < 0) fail();
    }
    if (item.attachments !== undefined) {
      if (!Array.isArray(item.attachments) || item.attachments.length > 100) fail();
      for (const attachment of item.attachments) {
        record(attachment, new Set(['title', 'url']));
        if (!string(attachment.title) || !safeExternalUrl(attachment.url)) fail();
      }
    }
  }
  for (const source of feed.sources) {
    record(source, sourceFields);
    if (!string(source.id) || !string(source.name) || !safeExternalUrl(source.url) || !['ok', 'partial', 'failed', 'pending'].includes(source.state) || !Number.isSafeInteger(source.count) || source.count < 0 || !date(source.lastSuccessAt) || !date(source.lastAttemptAt)) fail();
    for (const key of ['note', 'error', 'selector', 'discoveryMode']) if (source[key] != null && !string(source[key])) fail();
    if (source.sourceType !== undefined && !sourceTypes.includes(source.sourceType)) fail();
    for (const key of ['collectedCount', 'observedTotal', 'pagesRead', 'archivedCount']) if (source[key] != null && (!Number.isSafeInteger(source[key]) || source[key] < 0)) fail();
    if (source.complete !== undefined && typeof source.complete !== 'boolean') fail();
  }
  if (feed.statistics !== undefined) {
    record(feed.statistics, new Set('new updated unchanged failed totalCollected visible hidden duplicates'.split(' ')));
    if (Object.values(feed.statistics).some(value => !Number.isSafeInteger(value) || value < 0)) fail();
  }
}
