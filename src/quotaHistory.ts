import * as fs from 'node:fs';
import * as path from 'node:path';

export interface QuotaPoint { at: number; account: string; group: string; bucket: string; label: string; remaining: number; reset?: string }
const FILE = 'quota-history.json';
function read(root: string): QuotaPoint[] {
  const file = path.join(root, FILE);
  if (!fs.existsSync(file)) return [];
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('Invalid quota history');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error('Invalid quota history');
  return data.filter(p => Number.isFinite(p.at) && typeof p.account === 'string' && typeof p.bucket === 'string' && Number.isFinite(p.remaining) && p.remaining >= 0 && p.remaining <= 1);
}
export function recordQuota(root: string, account: string, quota: any): void {
  if (!quota?.groups || typeof account !== 'string') return;
  const now = Number(quota.checkedAt);
  if (!Number.isFinite(now)) return;
  const points = read(root).filter(point => point.at > now - 90 * 86400000);
  for (const group of quota.groups) for (const bucket of group.buckets || []) {
    const remaining = bucket.remainingFraction;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
    const key = `${group.displayName || ''}/${bucket.id}`;
    const previous = [...points].reverse().find(point => point.account === account && `${point.group}/${point.bucket}` === key);
    if (previous && previous.at >= now) continue;
    if (previous && previous.remaining === remaining && previous.reset === bucket.resetTime && now - previous.at < 3600000) continue;
    points.push({ at: now, account, group: String(group.displayName || '').slice(0,120), bucket: String(bucket.id).slice(0,120),
      label: String(bucket.displayName || bucket.id).slice(0,120), remaining, ...(bucket.resetTime ? { reset: String(bucket.resetTime).slice(0,40) } : {}) });
  }
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, FILE), temp = `${file}.${process.pid}.tmp`;
  if (fs.existsSync(temp) && fs.lstatSync(temp).isSymbolicLink()) throw new Error('Linked quota history');
  fs.writeFileSync(temp, JSON.stringify(points.slice(-20000)), { mode: 0o600 }); fs.renameSync(temp, file);
}
export function summarizeQuota(points: QuotaPoint[], now = Date.now()) {
  const grouped = new Map<string, QuotaPoint[]>();
  for (const point of points) { const key = `${point.account}/${point.group}/${point.bucket}`; const rows = grouped.get(key) || []; rows.push(point); grouped.set(key, rows); }
  return [...grouped.values()].map(raw => {
    const rows = raw.sort((a,b) => a.at-b.at), latest = rows[rows.length-1];

    let start = rows.length - 1;
    while (start > 0 && rows[start].remaining <= rows[start-1].remaining && rows[start].reset === rows[start-1].reset && rows[start-1].at >= now - 86400000) start--;
    const first = rows[start], elapsed = latest.at - first.at, drop = first.remaining - latest.remaining;
    const stale = now - latest.at > 15 * 60000;
    const etaMs = !stale && rows.length-start >= 3 && elapsed >= 30 * 60000 && drop >= 0.05 ? latest.remaining * elapsed / drop : null;
    const reset = latest.reset ? Date.parse(latest.reset) : NaN;
    return { ...latest, stale, usedPercent: Math.round((1-latest.remaining)*100),
      warning: stale ? null : latest.remaining <= 0 ? 'exhausted' : latest.remaining <= 0.1 ? 'critical' : latest.remaining <= 0.25 ? 'low' : null,
      etaMs: etaMs !== null && etaMs < 7*86400000 && (!Number.isFinite(reset) || now+etaMs < reset) ? Math.round(etaMs) : null,
      history: rows.slice(-48).map(point => ({ at: point.at, remaining: point.remaining })) };
  });
}
export function getQuotaHistory(root: string, accountIds: string[]) {
  return { success: true, rows: summarizeQuota(read(root).filter(point => accountIds.includes(point.account))) };
}
