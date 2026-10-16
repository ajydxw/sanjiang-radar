export type LikeSummary = { counts: Record<string, number>; likedIds: string[] };

export function readLikeSummary(value: unknown): LikeSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("点赞数据暂不可用");
  const input = value as Partial<LikeSummary>;
  if (!input.counts || typeof input.counts !== "object" || Array.isArray(input.counts) || !Array.isArray(input.likedIds)) throw new Error("点赞数据暂不可用");
  const entries = Object.entries(input.counts);
  const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 200 && !["__proto__", "constructor", "prototype"].includes(id) && !/[\u0000-\u001f\u007f]/.test(id);
  if (entries.length > 25000 || input.likedIds.length > 25000 || entries.some(([id, count]) => !validId(id) || !Number.isSafeInteger(count) || count < 0) || input.likedIds.some(id => !validId(id) || !Object.hasOwn(input.counts!, id) || input.counts![id] < 1)) throw new Error("点赞数据暂不可用");
  return { counts: Object.fromEntries(entries), likedIds: [...new Set(input.likedIds)] };
}
