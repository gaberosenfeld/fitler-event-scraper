import { ScrapeError } from './errors.js';
import { TARGET_ORIGIN } from './config.js';

export function isEventsApi(value) {
  try { const u = new URL(value); return u.origin === TARGET_ORIGIN && /^\/api\/events\/?$/.test(u.pathname) && u.searchParams.get('group') === 'events'; } catch { return false; }
}
const own = (o, k) => o && Object.hasOwn(o, k);
const positiveInt = value => value !== null && value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export class CatalogCollector {
  constructor({ maxEvents = 500, maxApiResponses = 120, maxCatalogBytes = 12 * 1024 * 1024 } = {}) {
    this.maxEvents = maxEvents; this.maxApiResponses = maxApiResponses; this.maxCatalogBytes = maxCatalogBytes;
    this.events = new Map(); this.responses = 0; this.bytes = 0; this.total = null; this.terminal = false; this.evidence = null; this.error = null;
  }
  accept(data, responseUrl, bytes = 0, pagination = null) {
    if (!isEventsApi(responseUrl)) return;
    if (++this.responses > this.maxApiResponses) throw new ScrapeError('PAGINATION_INCOMPLETE');
    this.bytes += bytes;
    if (this.bytes > this.maxCatalogBytes) throw new ScrapeError('RESPONSE_TOO_LARGE');
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.data) ? data.data : Array.isArray(data?.data?.items) ? data.data.items : null;
    if (!list) throw new ScrapeError('API_SCHEMA_CHANGED');
    const meta = [pagination, data?.pagination, data?.meta, data?.data?.pagination, data?.data?.meta, data?.data, data].filter(v => v && typeof v === 'object' && !Array.isArray(v));
    for (const m of meta) {
      for (const key of ['total', 'total_count', 'totalCount', 'total_items']) {
        if (own(m, key)) {
          const total = positiveInt(m[key]);
          if (total === null) throw new ScrapeError('API_SCHEMA_CHANGED');
          if (this.total !== null && this.total !== total) throw new ScrapeError('PAGINATION_INCOMPLETE');
          this.total = total;
          if (total > this.maxEvents) throw new ScrapeError('EVENT_LIMIT', 422);
        }
      }
    }
    // Enforce cap DURING collection, not by slicing after an unbounded scrape.
    for (const event of list) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new ScrapeError('API_SCHEMA_CHANGED');
      const id = event.id ?? event.event_id ?? event.eventId;
      if (!['number', 'string'].includes(typeof id) || !String(id).trim() || String(id).length > 128) throw new ScrapeError('INVALID_EVENT');
      if (!this.events.has(String(id)) && this.events.size >= this.maxEvents) throw new ScrapeError('EVENT_LIMIT', 422);
      this.events.set(String(id), event);
    }
    let end = list.length === 0 ? 'empty-api-page' : null;
    for (const m of meta) {
      if (m.has_more === false || m.hasMore === false || m.has_next === false || m.has_next_page === false || m.hasNextPage === false) end = 'explicit-last-page';
      if ((own(m, 'next_page_url') && m.next_page_url === null) || (own(m, 'next_cursor') && m.next_cursor === null)) end = 'explicit-last-page';
      const current = positiveInt(m.current_page ?? m.currentPage ?? m.page_number ?? m.pageNumber), last = positiveInt(m.last_page ?? m.lastPage ?? m.total_pages ?? m.totalPages);
      if (current !== null && last !== null && current >= last) end = 'explicit-last-page';
    }
    const params = new URL(responseUrl).searchParams;
    const requestedSize = positiveInt(params.get('limit') ?? params.get('pageSize') ?? params.get('page_size') ?? params.get('take') ?? -1);
    if (requestedSize > 0 && list.length < requestedSize) end = 'short-api-page';
    if (this.total !== null && this.events.size === this.total) end = 'reported-total';
    if (this.total !== null && this.events.size > this.total) throw new ScrapeError('PAGINATION_INCOMPLETE');
    // A later nonterminal response invalidates a prior short/empty response.
    this.terminal = !!end;
    this.evidence = end;
  }
  finish() {
    if (this.error) throw this.error;
    if (!this.responses) throw new ScrapeError('NO_API_RESPONSES');
    if (!this.terminal || (this.total !== null && this.events.size !== this.total)) throw new ScrapeError('PAGINATION_INCOMPLETE');
    return { rawEvents: [...this.events.values()], meta: { apiResponses: this.responses, totalCollected: this.events.size, returned: this.events.size, truncated: false, completionEvidence: this.evidence } };
  }
}
