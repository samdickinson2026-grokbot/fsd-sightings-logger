(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const dateValue = $('#date-value');
  const totSeen = $('#tot-seen');
  const totFsd = $('#tot-fsd');
  const stepMain = $('#step-main');
  const stepChoice = $('#step-choice');
  const btnSaw = $('#btn-saw');
  const btnYes = $('#btn-fsd-yes');
  const btnNo = $('#btn-fsd-no');
  const btnUndo = $('#btn-undo');
  const toastEl = $('#toast');
  const statsSummary = $('#stats-summary');
  const statsTitle = $('#stats-title');
  const chartFooter = $('#chart-footer');
  const dailyTbody = $('#daily-tbody');

  let currentDate = '';
  let hasEvents = false;
  let chart = null;
  let toastTimer = null;
  let busy = false;

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }

  function showToast(title, sub) {
    toastEl.innerHTML =
      title + (sub ? `<span class="sub">${sub}</span>` : '');
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  function setTotals(t) {
    if (!t) return;
    totSeen.textContent = String(t.teslas_seen ?? 0);
    totFsd.textContent = String(t.fsd_count ?? 0);
  }

  function showMain() {
    stepMain.classList.remove('hidden');
    stepChoice.classList.add('hidden');
  }

  function showChoice() {
    stepMain.classList.add('hidden');
    stepChoice.classList.remove('hidden');
  }

  async function refreshToday() {
    const data = await api('/api/today');
    if (currentDate && currentDate !== data.date) {
      // Midnight rollover
      showToast('New day', data.display);
    }
    currentDate = data.date;
    dateValue.textContent = data.display;
    setTotals(data.totals);
  }

  async function refreshUndoState() {
    try {
      const data = await api('/api/events');
      hasEvents = Array.isArray(data.events) && data.events.length > 0;
      btnUndo.disabled = !hasEvents;
    } catch {
      btnUndo.disabled = true;
    }
  }

  async function logSighting(fsd_active) {
    if (busy) return;
    busy = true;
    try {
      const data = await api('/api/sighting', {
        method: 'POST',
        body: JSON.stringify({ fsd_active }),
      });
      setTotals(data.today);
      showMain();
      const label = fsd_active ? 'Logged · FSD active' : 'Logged · FSD not active';
      showToast(
        label,
        `Today: ${data.today.teslas_seen} seen · ${data.today.fsd_count} FSD`
      );
      await refreshUndoState();
      // Refresh stats quietly if that tab may be open later
      if ($('#page-stats').classList.contains('active')) {
        await loadStats();
      }
    } catch (err) {
      showToast('Could not log', err.message);
      showMain();
    } finally {
      busy = false;
    }
  }

  async function undoLast() {
    if (busy || btnUndo.disabled) return;
    busy = true;
    try {
      const data = await api('/api/undo', { method: 'POST', body: '{}' });
      setTotals(data.today);
      const kind = data.undone.fsd_active ? 'FSD active' : 'FSD not active';
      showToast('Undone', kind);
      await refreshUndoState();
      if ($('#page-stats').classList.contains('active')) {
        await loadStats();
      }
    } catch (err) {
      showToast('Undo failed', err.message);
      await refreshUndoState();
    } finally {
      busy = false;
    }
  }

  function renderChart(stats) {
    const ctx = $('#week-chart').getContext('2d');
    const seen = stats.week.teslas_seen;
    const fsd = stats.week.fsd_count;
    const weekPct = stats.week.fsd_rate_pct;

    if (chart) chart.destroy();

    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Teslas Seen', 'On FSD'],
        datasets: [
          {
            data: [seen, fsd],
            backgroundColor: [stats.colors.teslas_seen, stats.colors.on_fsd],
            borderWidth: 0,
            borderRadius: 2,
            barPercentage: 0.55,
            categoryPercentage: 0.55,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: [
              'Central FL Tesla / FSD observations',
              `Week of ${stats.week.label}`,
            ],
            color: '#111111',
            font: { size: 13, weight: '600', family: 'system-ui, sans-serif' },
            padding: { bottom: 8 },
          },
          subtitle: {
            display: true,
            text: `${weekPct}% FSD This Week`,
            color: '#555555',
            font: { size: 12, family: 'system-ui, sans-serif' },
            padding: { bottom: 4 },
          },
          tooltip: { enabled: true },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#333', font: { size: 12, weight: '500' } },
          },
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: 'Count',
              color: '#333',
              font: { size: 11 },
            },
            grid: { color: 'rgba(0,0,0,0.06)' },
            ticks: { color: '#555', precision: 0 },
            suggestedMax: Math.max(seen, fsd, 1) * 1.3,
          },
        },
        animation: { duration: 400 },
      },
      plugins: [
        {
          id: 'valueLabels',
          afterDatasetsDraw(c) {
            const { ctx: g } = c;
            const meta = c.getDatasetMeta(0);
            g.save();
            g.font = 'bold 14px system-ui, sans-serif';
            g.fillStyle = '#111111';
            g.textAlign = 'center';
            g.textBaseline = 'bottom';
            meta.data.forEach((bar, i) => {
              const val = c.data.datasets[0].data[i];
              g.fillText(String(val), bar.x, bar.y - 6);
            });
            g.restore();
          },
        },
      ],
    });
  }

  function renderTable(rows, today) {
    dailyTbody.innerHTML = '';
    const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date));
    for (const r of sorted) {
      const tr = document.createElement('tr');
      if (r.date === today) tr.classList.add('today');
      tr.innerHTML = `
        <td>${r.date}</td>
        <td>${r.teslas_seen}</td>
        <td>${r.fsd_count}</td>
        <td>${Number(r.fsd_rate_pct).toFixed(1)}</td>
      `;
      dailyTbody.appendChild(tr);
    }
    if (!sorted.length) {
      dailyTbody.innerHTML =
        '<tr><td colspan="4" style="text-align:center;color:#9aa3b2">No data yet</td></tr>';
    }
  }

  async function loadStats() {
    try {
      const stats = await api('/api/stats');
      statsSummary.textContent = stats.summary;
      statsTitle.textContent = stats.title;
      chartFooter.textContent = stats.footer;
      renderChart(stats);
      renderTable(stats.daily, stats.today);
    } catch (err) {
      statsSummary.textContent = 'Failed to load stats';
      console.error(err);
    }
  }

  // Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const id = btn.dataset.tab;
      $(`#page-${id}`).classList.add('active');
      if (id === 'stats') await loadStats();
    });
  });

  btnSaw.addEventListener('click', () => showChoice());
  btnYes.addEventListener('click', () => logSighting(true));
  btnNo.addEventListener('click', () => logSighting(false));
  btnUndo.addEventListener('click', () => undoLast());

  // Date refresh: load + interval + visibility
  async function tickDate() {
    try {
      await refreshToday();
    } catch (e) {
      console.error(e);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tickDate();
  });

  // Init
  (async () => {
    await tickDate();
    await refreshUndoState();
    setInterval(tickDate, 30_000);
  })();
})();
