export function formatBytes(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return String(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function mask(secret) {
  if (!secret) return '';
  const s = String(secret);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}****${s.slice(-2)}`;
}

export function proxyUrl(protocol, username, password, host, port) {
  const scheme = String(protocol).toLowerCase() === 'socks5' ? 'socks5' : 'http';
  return `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
}

export const isoDate = (unixSeconds) => {
  const n = Number(unixSeconds);
  return n > 0 ? new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 16) : '';
};

/** Plain aligned table; columns: [{key, title, align?: 'right'}]. */
export function table(rows, columns) {
  if (!rows.length) return '';
  const cell = (row, c) => String(row[c.key] ?? '');
  const widths = columns.map(c => Math.max(c.title.length, ...rows.map(r => cell(r, c).length)));
  const line = (values) => values.map((v, i) => (columns[i].align === 'right' ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(columns.map(c => c.title)), ...rows.map(r => line(columns.map(c => cell(r, c))))].join('\n');
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
