import type { SchoolFeed } from '../src/lib/information';
export const PUBLIC_FEEDS: string[];
export function safeExternalUrl(value: unknown): boolean;
export function assertPublicFeed(feed: unknown): asserts feed is SchoolFeed;
