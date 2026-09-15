'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const DATA_DIR = path.join(__dirname, 'data');
const EVENTS_PATH = path.join(DATA_DIR, 'events.jsonl');
const CSV_PATH = path.join(DATA_DIR, 'tesla_fsd_observations.csv');
const TZ = 'America/New_York';

const SEED_ROWS = [
  { date: '2026-09-10', teslas_seen: 7, fsd_count: 3, undetermined_count: 0, fsd_rate_pct: 42.9 },
  { date: '2026-09-11', teslas_seen: 10, fsd_count: 3, undetermined_count: 0, fsd_rate_pct: 30.0 },
  { date: '2026-09-12', teslas_seen: 25, fsd_count: 8, undetermined_count: 0, fsd_rate_pct: 32.0 },
];

const BACKUP_CSV_URL =
  process.env.BACKUP_CSV_URL ||
  'https://raw.githubusercontent.com/samdickinson2026-grokbot/fsd-sightings-logger/main/data/tesla_fsd_observations.csv';

function calcFsdRate(teslas_seen, fsd_count, undetermined_count) {
  const denom = (Number(teslas_seen) || 0) - (Number(undetermined_count) || 0);
  if (denom <= 0) return 0;
  return Math.round((1000 * (Number(fsd_count) || 0)) / denom) / 10;
}

function normalizeStatus(raw) {
  if (raw === 'yes' || raw === 'no' || raw === 'undetermined') return raw;
  return null;
}

/** Resolve fsd_status from new events or legacy fsd_active-only events. */
function eventStatus(e) {
  if (!e) return 'no';
  const s = normalizeStatus(e.fsd_status);
  if (s) return s;
  return e.fsd_active ? 'yes' : 'no';
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_PATH)) fs.writeFileSync(EVENTS_PATH, '');
  if (!fs.existsSync(CSV_PATH) || fs.readFileSync(CSV_PATH, 'utf8').trim() === '') {
    writeCsv(SEED_ROWS);
  } else {
    // Ensure seed days exist even if a partial CSV survived
    mergeRowsIntoCsv(SEED_ROWS);
  }
}

function mergeRowsIntoCsv(incoming) {
  const byDate = new Map();
  for (const r of parseCsv()) byDate.set(r.date, { ...r });
  for (const r of incoming) {
    if (!r || !r.date) continue;
    const seen = Number(r.teslas_seen) || 0;
    const fsd = Number(r.fsd_count) || 0;
    const undet = Number(r.undetermined_count) || 0;
    const cur = byDate.get(r.date);
    if (!cur) {
      byDate.set(r.date, {
        date: r.date,
        teslas_seen: seen,
        fsd_count: fsd,
        undetermined_count: undet,
        fsd_rate_pct: 0,
      });
    } else {
      // Keep the larger totals (backup/phone may be ahead after a wipe)
      cur.teslas_seen = Math.max(cur.teslas_seen, seen);
      cur.fsd_count = Math.max(cur.fsd_count, fsd);
      cur.undetermined_count = Math.max(cur.undetermined_count || 0, undet);
    }
  }
  writeCsv(
    [...byDate.values()].filter(
      (r) => r.teslas_seen > 0 || r.fsd_count > 0 || (r.undetermined_count || 0) > 0
    )
  );
}

async function mergeBackupCsvFromUrl() {
  try {
    const res = await fetch(BACKUP_CSV_URL, { cache: 'no-store' });
    if (!res.ok) {
      console.warn('Backup CSV fetch failed', res.status);
      return;
    }
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/).slice(1);
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(',');
      const date = parts[0];
      const teslas_seen = Number(parts[1]);
      const fsd_count = Number(parts[2]);
      // Old 4-col: date,seen,fsd,rate — new 5-col: date,seen,fsd,undet,rate
      let undetermined_count = 0;
      if (parts.length >= 5) {
        undetermined_count = Number(parts[3]) || 0;
      }
      rows.push({
        date,
        teslas_seen,
        fsd_count,
        undetermined_count,
      });
    }
    if (rows.length) {
      mergeRowsIntoCsv(rows);
      console.log(`Merged ${rows.length} backup CSV rows from GitHub`);
    }
  } catch (err) {
    console.warn('Backup CSV merge error', err.message);
  }
}

function etDateParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  // hour12:false can still give 24 for midnight in some engines — normalize
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    weekday: parts.weekday,
    hour,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function todayET() {
  return etDateParts().dateStr;
}

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Noon UTC avoids DST edge issues for calendar-date formatting
  const dt = new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(dt);
}

/** Monday (ET) of the week containing dateStr YYYY-MM-DD */
function weekBoundsET(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Use a fixed offset trick: get weekday in ET for that calendar date
  const noonish = new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(noonish);
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = map[wd] ?? 0;
  const mon = new Date(Date.UTC(y, m - 1, d - offset));
  const sun = new Date(Date.UTC(y, m - 1, d - offset + 6));
  const fmt = (dt) => {
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };
  return { start: fmt(mon), end: fmt(sun) };
}

function formatWeekLabel(start, end) {
  const parse = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
  };
  const a = parse(start);
  const b = parse(end);
  const mon = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(a);
  const sun = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(b);
  return `${mon}–${sun}`;
}

function readEvents() {
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendEvent(ev) {
  fs.appendFileSync(EVENTS_PATH, JSON.stringify(ev) + '\n');
}

function rewriteEvents(events) {
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(EVENTS_PATH, body ? body + '\n' : '');
}

function parseCsv() {
  if (!fs.existsSync(CSV_PATH)) return [];
  const text = fs.readFileSync(CSV_PATH, 'utf8').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    const date = parts[0];
    const teslas_seen = Number(parts[1]);
    const fsd_count = Number(parts[2]);
    let undetermined_count = 0;
    let fsd_rate_pct;
    // New 5-col: date,teslas_seen,fsd_count,undetermined_count,fsd_rate_pct
    // Old 4-col: date,teslas_seen,fsd_count,fsd_rate_pct
    if (parts.length >= 5) {
      undetermined_count = Number(parts[3]) || 0;
      fsd_rate_pct = Number(parts[4]);
    } else {
      undetermined_count = 0;
      fsd_rate_pct = Number(parts[3]);
    }
    rows.push({
      date,
      teslas_seen,
      fsd_count,
      undetermined_count,
      fsd_rate_pct,
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function writeCsv(rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const lines = ['date,teslas_seen,fsd_count,undetermined_count,fsd_rate_pct'];
  for (const r of sorted) {
    const undet = Number(r.undetermined_count) || 0;
    const rate = calcFsdRate(r.teslas_seen, r.fsd_count, undet);
    lines.push(`${r.date},${r.teslas_seen},${r.fsd_count},${undet},${rate.toFixed(1)}`);
  }
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');
}

/**
 * Upsert daily totals by FSD status.
 * status: 'yes' | 'no' | 'undetermined'
 * All statuses +deltaSeen to teslas_seen.
 * Only 'yes' adjusts fsd_count; only 'undetermined' adjusts undetermined_count.
 */
function upsertDaily(date, status, delta = 1) {
  const rows = parseCsv();
  let row = rows.find((r) => r.date === date);
  if (!row) {
    row = { date, teslas_seen: 0, fsd_count: 0, undetermined_count: 0, fsd_rate_pct: 0 };
    rows.push(row);
  }
  if (row.undetermined_count == null) row.undetermined_count = 0;
  row.teslas_seen = Math.max(0, row.teslas_seen + delta);
  if (status === 'yes') {
    row.fsd_count = Math.max(0, row.fsd_count + delta);
  } else if (status === 'undetermined') {
    row.undetermined_count = Math.max(0, (row.undetermined_count || 0) + delta);
  }
  row.fsd_rate_pct = calcFsdRate(row.teslas_seen, row.fsd_count, row.undetermined_count);
  writeCsv(
    rows.filter(
      (r) => r.teslas_seen > 0 || r.fsd_count > 0 || (r.undetermined_count || 0) > 0
    )
  );
  return row;
}

function todayTotals(date) {
  const rows = parseCsv();
  const row = rows.find((r) => r.date === date);
  return {
    date,
    teslas_seen: row ? row.teslas_seen : 0,
    fsd_count: row ? row.fsd_count : 0,
    undetermined_count: row ? row.undetermined_count || 0 : 0,
    fsd_rate_pct: row ? row.fsd_rate_pct : 0,
  };
}

function formatSinceLabel(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 16, 0, 0));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(dt);
}

function buildStats() {
  const rows = parseCsv();
  const today = todayET();
  const { start, end } = weekBoundsET(today);
  const weekRows = rows.filter((r) => r.date >= start && r.date <= end);
  const week_seen = weekRows.reduce((s, r) => s + r.teslas_seen, 0);
  const week_fsd = weekRows.reduce((s, r) => s + r.fsd_count, 0);
  const week_undet = weekRows.reduce((s, r) => s + (r.undetermined_count || 0), 0);
  const all_time_seen = rows.reduce((s, r) => s + r.teslas_seen, 0);
  const all_time_fsd = rows.reduce((s, r) => s + r.fsd_count, 0);
  const all_time_undet = rows.reduce((s, r) => s + (r.undetermined_count || 0), 0);
  const all_time_pct = Math.round(calcFsdRate(all_time_seen, all_time_fsd, all_time_undet));
  const week_pct = Math.round(calcFsdRate(week_seen, week_fsd, week_undet));
  const since_date = rows.length ? rows[0].date : today;
  const since_label = formatSinceLabel(since_date);
  return {
    today,
    week: {
      start,
      end,
      label: formatWeekLabel(start, end),
      teslas_seen: week_seen,
      fsd_count: week_fsd,
      undetermined_count: week_undet,
      fsd_rate_pct: week_pct,
    },
    all_time: {
      teslas_seen: all_time_seen,
      fsd_count: all_time_fsd,
      undetermined_count: all_time_undet,
      fsd_rate_pct: all_time_pct,
    },
    since: {
      date: since_date,
      label: since_label,
    },
    summary: `Out Of ${all_time_seen} Teslas Observed, ${all_time_pct}% Were Using FSD`,
    title: `Central FL Tesla / FSD observations — Since ${since_label}`,
    footer: '@SamuelD2022  |  Central Florida FSD',
    daily: rows,
    colors: {
      teslas_seen: '#8E8E93',
      on_fsd: '#3B8CFF',
      undetermined: '#ff453a',
    },
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/today', (_req, res) => {
  const date = todayET();
  res.json({
    date,
    display: formatDisplayDate(date),
    timezone: TZ,
    totals: todayTotals(date),
  });
});

app.post('/api/sighting', (req, res) => {
  const body = req.body || {};
  let status = normalizeStatus(body.fsd_status);
  if (!status) {
    // Backward compat: boolean fsd_active
    if (typeof body.fsd_active === 'boolean') {
      status = body.fsd_active ? 'yes' : 'no';
    } else {
      status = 'no';
    }
  }
  const now = new Date();
  const date = todayET();
  const id = body.id && String(body.id) ? String(body.id) : crypto.randomUUID();
  const existing = readEvents();
  if (existing.some((e) => e.id === id)) {
    const row = todayTotals(date);
    return res.json({
      ok: true,
      duplicate: true,
      event: existing.find((e) => e.id === id),
      today: row,
    });
  }
  const ev = {
    id,
    timestamp: body.timestamp || now.toISOString(),
    date,
    fsd_status: status,
  };
  // Keep fsd_active boolean for yes/no only (backward compat)
  if (status === 'yes' || status === 'no') {
    ev.fsd_active = status === 'yes';
  }
  appendEvent(ev);
  const row = upsertDaily(date, status, 1);
  res.json({
    ok: true,
    event: ev,
    today: {
      date,
      teslas_seen: row.teslas_seen,
      fsd_count: row.fsd_count,
      undetermined_count: row.undetermined_count || 0,
      fsd_rate_pct: row.fsd_rate_pct,
    },
  });
});

app.post('/api/undo', (_req, res) => {
  const events = readEvents();
  if (events.length === 0) {
    return res.status(400).json({ ok: false, error: 'No events to undo' });
  }
  const last = events.pop();
  rewriteEvents(events);
  const status = eventStatus(last);
  upsertDaily(last.date, status, -1);
  const totals = todayTotals(todayET());
  res.json({ ok: true, undone: last, today: totals });
});

app.get('/api/daily', (_req, res) => {
  res.json({ rows: parseCsv() });
});

app.get('/api/events', (_req, res) => {
  res.json({ events: readEvents() });
});

app.get('/api/export.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="tesla_fsd_observations.csv"'
  );
  res.send(fs.readFileSync(CSV_PATH, 'utf8'));
});

app.get('/api/stats', (_req, res) => {
  res.json(buildStats());
});

function eventCountsByDate() {
  const map = new Map();
  for (const e of readEvents()) {
    if (!e || !e.date) continue;
    let row = map.get(e.date);
    if (!row) {
      row = { date: e.date, teslas_seen: 0, fsd_count: 0, undetermined_count: 0 };
      map.set(e.date, row);
    }
    row.teslas_seen += 1;
    const status = eventStatus(e);
    if (status === 'yes') row.fsd_count += 1;
    else if (status === 'undetermined') row.undetermined_count += 1;
  }
  return [...map.values()];
}

app.post('/api/import-events', (req, res) => {
  const list = Array.isArray(req.body && req.body.events) ? req.body.events : [];
  const existing = new Set(readEvents().map((e) => e.id));
  let imported = 0;
  for (const raw of list) {
    if (!raw || !raw.id || existing.has(raw.id)) continue;
    const status = eventStatus(raw);
    const date = String(raw.date || todayET());
    const ev = {
      id: String(raw.id),
      timestamp: raw.timestamp || new Date().toISOString(),
      date,
      fsd_status: status,
    };
    if (status === 'yes' || status === 'no') {
      ev.fsd_active = status === 'yes';
    }
    appendEvent(ev);
    existing.add(ev.id);
    imported += 1;
  }
  // Never +1 CSV per imported event (double-counts after a wipe).
  // Only raise daily totals up to event-derived counts via max-merge.
  if (imported > 0) {
    mergeRowsIntoCsv(eventCountsByDate());
  }
  res.json({
    ok: true,
    imported,
    today: todayTotals(todayET()),
    events: readEvents().length,
  });
});

app.post('/api/set-day', (req, res) => {
  const body = req.body || {};
  const date = String(body.date || todayET());
  const teslas_seen = Math.max(0, Number(body.teslas_seen) || 0);
  const fsd_count = Math.max(0, Number(body.fsd_count) || 0);
  const undetermined_count = Math.max(0, Number(body.undetermined_count) || 0);
  const rows = parseCsv().filter((r) => r.date !== date);
  rows.push({ date, teslas_seen, fsd_count, undetermined_count, fsd_rate_pct: 0 });
  writeCsv(rows);
  res.json({ ok: true, row: todayTotals(date), today: todayTotals(todayET()) });
});

ensureDataDir();
mergeBackupCsvFromUrl().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FSD Logger listening on http://0.0.0.0:${PORT}`);
    console.log(`Data: ${DATA_DIR}`);
    console.log(`Today (ET): ${todayET()}`);
    console.log(`Backup CSV: ${BACKUP_CSV_URL}`);
  });
});
