import { TARGET_ORIGIN, TIME_ZONE } from './config.js';
import { ScrapeError } from './errors.js';

const text = value => typeof value === 'string' ? value.trim() : '';
export function plainText(html) {
  return text(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/p>|<br\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&(?:nbsp|amp|lt|gt|quot|#39|rsquo|lsquo|ldquo|rdquo|ndash|mdash|hellip);/gi, entity => ({
      '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…'
    })[entity.toLowerCase()]).replace(/[ \t]{2,}/g, ' ').trim();
}
export function safeUrl(value) {
  if (!text(value)) return '';
  try { const url = new URL(value, TARGET_ORIGIN); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
const localParts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function partsUTC(date) {
  const p = Object.fromEntries(localParts.formatToParts(date).map(p => [p.type, p.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
// PeopleVine's *_date_local.date is a wall-clock value, not server UTC.
// Resolve using New York's actual offset; flag DST-fold ambiguity, reject gaps.
export function parseEventDate(value) {
  if (!value) return { iso: null, ambiguous: false };
  if (typeof value !== 'string') throw new ScrapeError('INVALID_EVENT');
  if (/(?:Z|[+-]\d\d:?\d\d)$/i.test(value)) {
    const d = new Date(value);
    if (!Number.isFinite(d.valueOf())) throw new ScrapeError('INVALID_EVENT');
    return { iso: d.toISOString(), ambiguous: false };
  }
  const m = value.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?$/);
  if (!m) throw new ScrapeError('INVALID_EVENT');
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const normalized = new Date(wall);
  if (normalized.getUTCFullYear() !== +m[1] || normalized.getUTCMonth() !== +m[2] - 1 || normalized.getUTCDate() !== +m[3] || +m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59) throw new ScrapeError('INVALID_EVENT');
  const candidates = [4, 5].map(offset => wall + offset * 3600000).filter(instant => partsUTC(new Date(instant)) === wall);
  if (!candidates.length) throw new ScrapeError('INVALID_EVENT');
  return { iso: new Date(candidates[0]).toISOString(), ambiguous: candidates.length > 1 };
}
export function mapEvent(ev) {
  const id = ev.id ?? ev.event_id ?? ev.eventId;
  if (!['string', 'number'].includes(typeof id) || String(id).length > 128 || !String(id).trim() || !text(ev.title)) throw new ScrapeError('INVALID_EVENT');
  const sourceStartISO = ev.start_date_local?.date || ev.start_date || null;
  const sourceEndISO = ev.end_date_local?.date || ev.end_date || null;
  const start = parseEventDate(sourceStartISO), end = parseEventDate(sourceEndISO);
  const time = iso => iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' }) : '';
  const startTime = time(start.iso), endTime = time(end.iso);
  const summary = text(ev.summary), html = text(ev.description);
  return {
    id, url: `${TARGET_ORIGIN}/events/${encodeURIComponent(String(id))}`,
    title: text(ev.title), description: summary, summary,
    longDescription: plainText(html || summary),
    // Deliberately preserve source formatting. UNTRUSTED: sanitize in the portal.
    longDescriptionHTML: html,
    date: start.iso ? new Date(start.iso).toLocaleDateString('en-US', { timeZone: TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric' }) : '',
    time: startTime && endTime && startTime !== endTime ? `${startTime} – ${endTime}` : startTime,
    startISO: start.iso, endISO: end.iso, sourceStartISO, sourceEndISO,
    timeZone: TIME_ZONE, ambiguousLocalTime: start.ambiguous || end.ambiguous,
    location: text(ev.venue), bannerImage: safeUrl(ev.graphic), externalLink: safeUrl(ev.external_link),
    categories: Array.isArray(ev.categories) ? ev.categories : [], availability: ev.availability ?? ''
  };
}
