import { chromium } from 'playwright-core';
import { dirname } from 'node:path';
import { secureDirectory } from '../../scripts/local-secrets.mjs';

export const PU_SCHOOL_ID = '235207080935424';
export const PU_ORIGIN = 'https://class.pocketuni.net';

// Read from the user's dedicated local browser profile. No credentials or
// account-specific activity status leave the browser execution context.
export async function readPuActivities(profilePath, maxPages = 20, cachedItems = []) {
  await secureDirectory(dirname(profilePath));
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'msedge', headless: true, acceptDownloads: false,
      args: ['--no-proxy-server'],
    });
    const page = context.pages()[0] || await context.newPage();
    const readerUrl = `${PU_ORIGIN}/__sanjiang_radar_readonly__`;
    // A blank, locally fulfilled document prevents the PU SPA's navigation
    // from cancelling read requests. API authentication and CORS still apply.
    await page.route(readerUrl, route => route.fulfill({
      status: 200, contentType: 'text/html',
      body: '<!doctype html><html><head><title>Sanjiang read-only reader</title></head><body></body></html>',
    }));
    await page.goto(readerUrl, { waitUntil: 'load', timeout: 30000 });
    return await page.evaluate(async ({ schoolId, maxPages, cachedItems }) => {
      let user;
      try { user = JSON.parse(localStorage.getItem('user') || 'null'); }
      catch { return { state: 'failed', reason: '登录状态无法读取' }; }
      if (!user?.token) return { state: 'failed', reason: '需要在本机 PU 官方网页重新登录' };
      if (String(user.sid) !== schoolId) return { state: 'failed', reason: '当前登录学校不是三江学院，已停止读取' };
      const authorization = `Bearer ${user.token}:${user.sid}`;
      let lastRequest = 0;
      const read = async (path, body) => {
        const wait = 750 - (Date.now() - lastRequest);
        if (wait > 0) await new Promise(done => setTimeout(done, wait));
        lastRequest = Date.now();
        // Only these two read endpoints are permitted.
        if (!['/apis/activity/list', '/apis/activity/info'].includes(path)) throw new Error('非只读接口');
        const response = await fetch(`https://apis.pocketuni.net${path}`, {
          method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
        });
        const value = await response.json();
        if (!response.ok || value.code !== 0) throw new Error(`读取失败（HTTP ${response.status}，业务码 ${Number(value.code) || '未知'}）`);
        return value.data;
      };
      const scalarKeys = ['name', 'description', 'credit', 'puAmount', 'puType',
        'categoryName', 'levelName', 'address', 'joinStartTime', 'joinEndTime',
        'startTime', 'endTime', 'allowUserCount', 'joinUserCount', 'statusName',
        'allowUserType', 'isZyfwActivity', 'aTime'];
      const select = value => Object.fromEntries(scalarKeys
        .filter(key => value?.[key] !== undefined && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key])))
        .map(key => [key, typeof value[key] === 'string' ? value[key].slice(0, 12000) : value[key]]));
      const selectNames = value => Array.isArray(value) ? value.slice(0, 100)
        .map(item => typeof item === 'string' || typeof item === 'number' ? String(item) : item?.name)
        .filter(name => typeof name === 'string').map(name => name.slice(0, 100)) : [];
      const listed = new Map();
      const cached = new Map(cachedItems.map(item => [item.id.replace(/^pu-/, ''), item]));
      let expectedCount = null;
      let pagesRead = 0;
      let complete = false;
      const errors = [];
      try {
        for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
          const data = await read('/apis/activity/list', { sort: 0, page: pageNumber, limit: 50 });
          if (!Array.isArray(data?.list)) throw new Error('活动列表格式改变，需要检查');
          pagesRead++;
          if (Number.isInteger(data.pageInfo?.count)) expectedCount = data.pageInfo.count;
          for (const entry of data.list) {
            if (typeof entry.id === 'number' && Number.isSafeInteger(entry.id) || typeof entry.id === 'string' && /^\d+$/.test(entry.id)) {
              listed.set(String(entry.id), { id: String(entry.id), base: select(entry) });
            }
          }
          if (!data.list.length || Number.isInteger(data.pageInfo?.total) && pageNumber >= data.pageInfo.total) { complete = true; break; }
        }
      } catch { errors.push('活动列表未完整读取，保留已收集内容'); }
      const activities = [];
      for (const entry of listed.values()) {
        const end = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(entry.base.endTime || '')
          ? Date.parse(entry.base.endTime.replace(' ', 'T') + '+08:00') : NaN;
        const historical = Number.isFinite(end) && end < Date.now() - 7 * 86400000;
        if (historical && cached.get(entry.id)?.detailRead) {
          activities.push({ ...entry, reusePrevious: true });
          continue;
        }
        if (historical) {
          activities.push({ ...entry, archived: true });
          continue;
        }
        try {
          const numericId = Number(entry.id);
          if (!Number.isSafeInteger(numericId)) throw new Error('活动编号需要人工检查');
          const data = await read('/apis/activity/info', { id: numericId });
          if (!data?.baseInfo || typeof data.baseInfo.name !== 'string') throw new Error('活动详情格式改变');
          activities.push({
            id: entry.id, base: { ...entry.base, ...select(data.baseInfo) },
            allowedYears: selectNames(data.baseInfo.allowYear),
            allowedColleges: selectNames(data.baseInfo.allowCollege),
            creditTipContent: typeof data.creditTipContent === 'string' ? data.creditTipContent.slice(0, 1000) : '',
            detailRead: true,
          });
        } catch (error) {
          activities.push({ ...entry, allowedYears: [], allowedColleges: [], creditTipContent: '', detailRead: false });
          errors.push(`活动 ${entry.id} 详情暂未读取${/^读取失败/.test(error.message) ? `：${error.message}` : ''}`);
        }
      }
      if (!complete) errors.push('本次分页有缺失或达到上限，不代表全校全部活动');
      return { state: !pagesRead ? 'failed' : errors.length ? 'partial' : 'ok',
        schoolId, expectedCount, pagesRead, complete, activities, errors };
    }, { schoolId: PU_SCHOOL_ID, maxPages, cachedItems });
  } catch {
    return { state: 'failed', reason: 'PU 会话或连接暂不可用，请检查本机登录窗口是否占用资料' };
  } finally { await context?.close(); }
}
