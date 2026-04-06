import SheetsApi, { TABS } from './sheetsApi.js';

const { ref, computed, watch, inject, onMounted, nextTick } = Vue;

const ASSUMPTIONS_PREFIX = 'valu_forecast_';

function loadAssumptions(groupId) {
  try {
    const raw = localStorage.getItem(ASSUMPTIONS_PREFIX + groupId);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}
function saveAssumptions(groupId, a) {
  localStorage.setItem(ASSUMPTIONS_PREFIX + groupId, JSON.stringify(a));
}

function endOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}
function fmtDate(y, m) {
  const d = endOfMonth(y, m);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function getNumberLocale() {
  const pref = localStorage.getItem('valu_number_format') || 'auto';
  return pref === 'auto' ? undefined : pref;
}
function formatCurrency(amount, currency) {
  try {
    const cur = currency || 'USD';
    const numLocale = getNumberLocale();
    const sym = new Intl.NumberFormat(undefined, {
      style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol',
    }).formatToParts(0).find(p => p.type === 'currency')?.value || cur;
    const num = new Intl.NumberFormat(numLocale, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(amount);
    return sym + num;
  } catch { return String(amount); }
}
function fmtNum(val) {
  const numLocale = getNumberLocale();
  return new Intl.NumberFormat(numLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

export default {
  props: ['sheetId', 'settings', 'accounts', 'isDemoGroup'],
  emits: ['navigate', 'go-home'],

  setup(props) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'CAD');
    const enabledLists = computed(() => (props.settings?.listsEnabled || '').split(',').filter(Boolean));

    const loading = ref(true);
    const viewMode = ref('monthly');
    const showAssumptions = ref(false);

    const balanceHistory = ref([]);
    const expenses = ref([]);
    const incomeList = ref([]);

    const assumptionIncome = ref(0);
    const assumptionExpenses = ref(5000);
    const assumptionRoi = ref(2);
    const projectionMonthsMonthly = ref(24);
    const projectionYears = ref(20);
    const goalStart = ref(0);
    const goalIncrement = ref(5000);

    async function fetchData() {
      const sid = getSheetId();
      if (!sid) { loading.value = false; return; }
      loading.value = true;
      try {
        const promises = [];
        if (enabledLists.value.includes('accounts')) {
          promises.push(SheetsApi.getTabData(sid, TABS.BALANCE_HISTORY).then(rows => {
            balanceHistory.value = rows.map(r => ({
              accountId: r[0], year: parseInt(r[1]),
              month: parseInt(r[2]), balance: parseFloat(r[3]) || 0,
            }));
          }).catch(() => { balanceHistory.value = []; }));
        }
        if (enabledLists.value.includes('expenses')) {
          promises.push(SheetsApi.getTabData(sid, TABS.EXPENSES).then(rows => {
            expenses.value = rows.map(r => ({
              amount: parseFloat(r[2]) || 0, date: r[5],
            }));
          }).catch(() => { expenses.value = []; }));
        }
        if (enabledLists.value.includes('income')) {
          promises.push(SheetsApi.getTabData(sid, TABS.INCOME).then(rows => {
            incomeList.value = rows.map(r => ({
              amount: parseFloat(r[2]) || 0, date: r[5],
            }));
          }).catch(() => { incomeList.value = []; }));
        }
        await Promise.all(promises);

        const saved = loadAssumptions(sid);
        if (saved) {
          assumptionIncome.value = saved.income ?? 0;
          assumptionExpenses.value = saved.expenses ?? 5000;
          assumptionRoi.value = saved.roi ?? 2;
          projectionMonthsMonthly.value = saved.monthsMonthly ?? saved.months ?? 24;
          projectionYears.value = saved.years ?? (saved.monthsYearly ? Math.round(saved.monthsYearly / 12) : 20);
          goalStart.value = saved.goalStart ?? 0;
          goalIncrement.value = saved.goalIncrement ?? 5000;
        } else {
          autoDetectAssumptions();
        }
      } catch (err) {
        console.error('Forecast: failed to load data', err);
      } finally {
        loading.value = false;
      }
    }

    function autoDetectAssumptions() {
      const hist = historicalRows.value;
      if (hist.length === 0) return;
      const recent = hist.slice(-12);
      const avgInc = recent.reduce((s, r) => s + r.income, 0) / recent.length;
      const avgExp = recent.reduce((s, r) => s + r.expenses, 0) / recent.length;
      const rois = recent.filter(r => r.prevTotal > 0).map(r => r.roiPct);
      const avgRoi = rois.length > 0 ? rois.reduce((s, v) => s + v, 0) / rois.length : 0;
      assumptionIncome.value = Math.round(avgInc);
      assumptionExpenses.value = Math.round(avgExp);
      assumptionRoi.value = Math.round(avgRoi * 100) / 100;
      goalStart.value = Math.round(hist[0].total);
      goalIncrement.value = 5000;
    }

    function persistAssumptions() {
      const sid = getSheetId();
      if (!sid) return;
      saveAssumptions(sid, {
        income: assumptionIncome.value,
        expenses: assumptionExpenses.value,
        roi: assumptionRoi.value,
        monthsMonthly: projectionMonthsMonthly.value,
        years: projectionYears.value,
        goalStart: goalStart.value,
        goalIncrement: goalIncrement.value,
      });
    }

    const historicalRows = computed(() => {
      const monthTotals = {};
      for (const h of balanceHistory.value) {
        const key = `${h.year}-${String(h.month).padStart(2, '0')}`;
        monthTotals[key] = (monthTotals[key] || 0) + h.balance;
      }

      const monthIncome = {};
      for (const inc of incomeList.value) {
        if (!inc.date) continue;
        const parts = inc.date.split('-');
        if (parts.length < 2) continue;
        const key = `${parts[0]}-${parts[1]}`;
        monthIncome[key] = (monthIncome[key] || 0) + inc.amount;
      }

      const monthExpenses = {};
      for (const exp of expenses.value) {
        if (!exp.date) continue;
        const parts = exp.date.split('-');
        if (parts.length < 2) continue;
        const key = `${parts[0]}-${parts[1]}`;
        monthExpenses[key] = (monthExpenses[key] || 0) + exp.amount;
      }

      const now = new Date();
      const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const balKeys = Object.keys(monthTotals).filter(k => k < currentKey);
      if (balKeys.length === 0) return [];
      const sorted = balKeys.sort();

      const rows = [];
      let prevTotal = null;
      for (const key of sorted) {
        const [y, m] = key.split('-').map(Number);
        const total = monthTotals[key];
        const income = monthIncome[key] || 0;
        const exp = monthExpenses[key] || 0;
        const monthSum = income - exp;
        const roi = prevTotal !== null ? total - prevTotal - monthSum : 0;
        const roiPct = prevTotal && prevTotal !== 0 ? (roi / prevTotal * 100) : 0;

        rows.push({
          date: fmtDate(y, m),
          year: y, month: m, key,
          income, expenses: exp, monthSum, roi, total,
          roiPct, prevTotal: prevTotal ?? 0, isProjected: false,
        });
        prevTotal = total;
      }
      return rows;
    });

    const projectedRows = computed(() => {
      const hist = historicalRows.value;
      if (hist.length === 0) return [];

      const last = hist[hist.length - 1];
      let prevTotal = last.total;
      let y = last.year;
      let m = last.month;
      const rows = [];

      const endYear = last.year + projectionYears.value;
      const yearlyMonths = (endYear - last.year) * 12 + (12 - last.month);
      const maxProjection = Math.max(projectionMonthsMonthly.value, yearlyMonths);
      for (let i = 0; i < maxProjection; i++) {
        m++;
        if (m > 12) { m = 1; y++; }
        const inc = assumptionIncome.value;
        const exp = assumptionExpenses.value;
        const monthSum = inc - exp;
        const balanceAfterCashflow = prevTotal + monthSum;
        const roi = balanceAfterCashflow * (assumptionRoi.value / 100);
        const total = balanceAfterCashflow + roi;
        const roiPct = assumptionRoi.value;
        const key = `${y}-${String(m).padStart(2, '0')}`;

        rows.push({
          date: fmtDate(y, m),
          year: y, month: m, key,
          income: inc, expenses: exp, monthSum, roi, total,
          roiPct, prevTotal, isProjected: true,
        });
        prevTotal = total;
      }
      return rows;
    });

    const allRows = computed(() => {
      const hist = historicalRows.value;
      const proj = projectedRows.value;
      const combined = [...hist, ...proj];
      const gs = goalStart.value != null ? goalStart.value : (hist.length > 0 ? hist[0].total : 0);
      const gi = goalIncrement.value;
      for (let i = 0; i < combined.length; i++) {
        combined[i] = { ...combined[i], goal: gs + gi * i };
      }
      return combined;
    });

    const yearlyRows = computed(() => {
      const byYear = {};
      const hist = historicalRows.value;
      const lastHistRow = hist.length > 0 ? hist[hist.length - 1] : null;
      const maxYear = lastHistRow ? lastHistRow.year + projectionYears.value : 9999;
      for (const r of allRows.value) {
        if (r.year > maxYear) continue;
        if (!byYear[r.year]) byYear[r.year] = { rows: [], isProjected: r.isProjected };
        byYear[r.year].rows.push(r);
        if (r.isProjected) byYear[r.year].isProjected = true;
      }
      const result = [];
      for (const year of Object.keys(byYear).sort()) {
        const allYRows = byYear[year].rows;
        const isMixed = byYear[year].isProjected && allYRows.some(r => !r.isProjected);
        const yRows = isMixed ? allYRows.filter(r => r.isProjected) : allYRows;
        const n = yRows.length;
        if (n === 0) continue;
        const income = yRows.reduce((s, r) => s + r.income, 0) / n;
        const exp = yRows.reduce((s, r) => s + r.expenses, 0) / n;
        const monthSum = yRows.reduce((s, r) => s + r.monthSum, 0) / n;
        const roi = yRows.reduce((s, r) => s + r.roi, 0) / n;
        const last = allYRows[allYRows.length - 1];
        const first = yRows[0];
        const roiPcts = yRows.filter(r => r.prevTotal > 0).map(r => r.roiPct);
        const avgMonthlyRoi = roiPcts.length > 0 ? roiPcts.reduce((s, v) => s + v, 0) / roiPcts.length : 0;
        const roiPct = avgMonthlyRoi * 12;
        result.push({
          date: String(year),
          year: Number(year), month: 12, key: year,
          income, expenses: exp, monthSum, roi,
          total: last.total, goal: last.goal,
          roiPct, prevTotal: first.prevTotal,
          isProjected: byYear[year].isProjected,
        });
      }
      return result;
    });

    const displayRows = computed(() => {
      if (viewMode.value === 'yearly') return yearlyRows.value;
      const hist = historicalRows.value;
      const all = allRows.value;
      const maxRows = hist.length + projectionMonthsMonthly.value;
      return all.slice(0, maxRows);
    });

    // ── Chart helpers ──
    const chartW = 800;
    const chartH = 220;
    const chartPad = { top: 16, bottom: 28, left: 8, right: 8 };
    const selectedChart1 = ref(null);
    const selectedChart2 = ref(null);

    const MIN_LABEL_PX = 70;

    function chartLabel(d) {
      return viewMode.value === 'yearly' ? String(d.year) :
        new Date(d.year, d.month - 1).toLocaleString(undefined, { month: 'short' }) + ' ' + String(d.year).slice(-2);
    }

    function buildDualChart(data, getVal1, getVal2, label1, label2) {
      if (data.length < 2) return { path1: '', path2: '', labels: [], dividerX: null, points: [] };
      const v1 = data.map(getVal1);
      const v2 = data.map(getVal2);
      const allVals = [...v1, ...v2];
      const min = Math.min(...allVals);
      const max = Math.max(...allVals);
      const range = max - min || 1;
      const usableW = chartW - chartPad.left - chartPad.right;
      const usableH = chartH - chartPad.top - chartPad.bottom;

      function getXY(vals) {
        return vals.map((v, i) => ({
          x: chartPad.left + (i / (data.length - 1)) * usableW,
          y: chartPad.top + usableH - ((v - min) / range) * usableH,
        }));
      }

      const pts1 = getXY(v1);
      const pts2 = getXY(v2);

      const path1 = pts1.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const path2 = pts2.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

      let dividerX = null;
      const histIdx = data.findIndex(d => d.isProjected) - 1;
      if (histIdx >= 0) {
        dividerX = pts1[histIdx].x;
      }

      const maxLabels = Math.max(2, Math.floor(usableW / MIN_LABEL_PX));
      const step = Math.max(1, Math.ceil(data.length / maxLabels));
      const labels = [];
      for (let i = 0; i < data.length; i += step) {
        labels.push({ x: pts1[i].x, label: chartLabel(data[i]) });
      }

      const points = data.map((d, i) => ({
        idx: i,
        x: pts1[i].x,
        y1: pts1[i].y, y2: pts2[i].y,
        val1: v1[i], val2: v2[i],
        label: chartLabel(d),
        isProjected: d.isProjected,
        label1, label2,
      }));

      return { path1, path2, labels, dividerX, points };
    }

    const chart1 = computed(() => buildDualChart(displayRows.value, d => d.total, d => d.goal, 'Total', 'Goal'));
    const chart2 = computed(() => buildDualChart(displayRows.value, d => d.monthSum, d => d.roi, 'Sum', 'ROI'));

    function selectPoint(chartRef, idx) {
      chartRef.value = chartRef.value === idx ? null : idx;
    }

    watch(() => getSheetId(), () => fetchData(), { immediate: true });
    watch([assumptionIncome, assumptionExpenses, assumptionRoi, projectionMonthsMonthly, projectionYears, goalStart, goalIncrement], () => {
      persistAssumptions();
    });
    watch(viewMode, () => { selectedChart1.value = null; selectedChart2.value = null; });

    function fc(amount) { return formatCurrency(amount, baseCurrency.value); }

    return {
      loading, viewMode, showAssumptions, displayRows,
      assumptionIncome, assumptionExpenses, assumptionRoi,
      projectionMonthsMonthly, projectionYears, goalStart, goalIncrement,
      chart1, chart2, chartW, chartH, chartPad,
      selectedChart1, selectedChart2, selectPoint,
      fc, fmtNum, baseCurrency,
      autoDetectAssumptions,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">

      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Forecast</h1>
        <div class="valu-orb-sm subpage-orb-inline" @click="$emit('navigate', 'assistant')">
          <div class="spheres"><div class="spheres-group"><div class="sphere s1"></div><div class="sphere s2"></div><div class="sphere s3"></div></div></div>
        </div>
      </div>

      <div v-if="loading" class="loading"><div class="spinner"></div>Loading...</div>

      <template v-else>
        <div style="padding:0 16px;">

          <!-- Monthly / Yearly toggle -->
          <div class="forecast-toggle">
            <button :class="{ active: viewMode === 'monthly' }" @click="viewMode = 'monthly'">Monthly</button>
            <button :class="{ active: viewMode === 'yearly' }" @click="viewMode = 'yearly'">Yearly</button>
          </div>

          <!-- Chart 1: Total vs Goal -->
          <div class="card mb-16" v-if="displayRows.length > 1">
            <div class="card-header"><h3>Net Worth vs Goal</h3></div>
            <div class="forecast-chart-wrap">
              <div v-if="selectedChart1 !== null && chart1.points[selectedChart1]" class="forecast-tooltip">
                <strong>{{ chart1.points[selectedChart1].label }}</strong>
                <span style="color:var(--color-primary);">Total: {{ fc(chart1.points[selectedChart1].val1) }}</span>
                <span style="color:var(--color-text-secondary);">Goal: {{ fc(chart1.points[selectedChart1].val2) }}</span>
              </div>
              <svg :viewBox="'0 0 ' + chartW + ' ' + chartH" preserveAspectRatio="none" class="forecast-chart-svg" @click.self="selectedChart1 = null">
                <line v-if="chart1.dividerX" :x1="chart1.dividerX" :y1="chartPad.top" :x2="chart1.dividerX" :y2="chartH - chartPad.bottom"
                      stroke="var(--color-text-hint)" stroke-width="1" stroke-dasharray="6,4" />
                <path :d="chart1.path1" fill="none" stroke="var(--color-primary)" stroke-width="2.5" stroke-linejoin="round" />
                <path :d="chart1.path2" fill="none" stroke="var(--color-text-hint)" stroke-width="1.5" stroke-dasharray="6,3" stroke-linejoin="round" />
                <template v-if="selectedChart1 !== null && chart1.points[selectedChart1]">
                  <line :x1="chart1.points[selectedChart1].x" :y1="chartPad.top" :x2="chart1.points[selectedChart1].x" :y2="chartH - chartPad.bottom" stroke="var(--color-primary)" stroke-width="1" opacity="0.3" />
                  <circle :cx="chart1.points[selectedChart1].x" :cy="chart1.points[selectedChart1].y1" r="5" fill="var(--color-primary)" />
                  <circle :cx="chart1.points[selectedChart1].x" :cy="chart1.points[selectedChart1].y2" r="4" fill="var(--color-text-hint)" />
                </template>
                <rect v-for="pt in chart1.points" :key="'h1-'+pt.idx"
                      :x="pt.x - chartW / chart1.points.length / 2" :y="chartPad.top"
                      :width="chartW / chart1.points.length" :height="chartH - chartPad.top - chartPad.bottom"
                      fill="transparent" style="cursor:pointer;" @click.stop="selectedChart1 = selectedChart1 === pt.idx ? null : pt.idx" />
              </svg>
              <div class="forecast-chart-labels">
                <span v-for="lbl in chart1.labels" :key="lbl.label" class="forecast-chart-label" :style="{ left: (lbl.x / chartW * 100) + '%' }">{{ lbl.label }}</span>
              </div>
              <div class="forecast-chart-legend">
                <span class="forecast-legend-item"><span class="forecast-legend-dot" style="background:var(--color-primary);"></span>Total</span>
                <span class="forecast-legend-item"><span class="forecast-legend-dot" style="background:var(--color-text-hint);"></span>Goal</span>
              </div>
            </div>
          </div>

          <!-- Chart 2: Month Sum vs ROI -->
          <div class="card mb-16" v-if="displayRows.length > 1">
            <div class="card-header"><h3>{{ viewMode === 'yearly' ? 'Year' : 'Month' }} Sum vs ROI</h3></div>
            <div class="forecast-chart-wrap">
              <div v-if="selectedChart2 !== null && chart2.points[selectedChart2]" class="forecast-tooltip">
                <strong>{{ chart2.points[selectedChart2].label }}</strong>
                <span style="color:#5a9e6f;">{{ chart2.points[selectedChart2].label1 }}: {{ fc(chart2.points[selectedChart2].val1) }}</span>
                <span style="color:#c5a32d;">{{ chart2.points[selectedChart2].label2 }}: {{ fc(chart2.points[selectedChart2].val2) }}</span>
              </div>
              <svg :viewBox="'0 0 ' + chartW + ' ' + chartH" preserveAspectRatio="none" class="forecast-chart-svg" @click.self="selectedChart2 = null">
                <line v-if="chart2.dividerX" :x1="chart2.dividerX" :y1="chartPad.top" :x2="chart2.dividerX" :y2="chartH - chartPad.bottom"
                      stroke="var(--color-text-hint)" stroke-width="1" stroke-dasharray="6,4" />
                <path :d="chart2.path1" fill="none" stroke="#5a9e6f" stroke-width="2.5" stroke-linejoin="round" />
                <path :d="chart2.path2" fill="none" stroke="#c5a32d" stroke-width="2.5" stroke-linejoin="round" />
                <template v-if="selectedChart2 !== null && chart2.points[selectedChart2]">
                  <line :x1="chart2.points[selectedChart2].x" :y1="chartPad.top" :x2="chart2.points[selectedChart2].x" :y2="chartH - chartPad.bottom" stroke="#5a9e6f" stroke-width="1" opacity="0.3" />
                  <circle :cx="chart2.points[selectedChart2].x" :cy="chart2.points[selectedChart2].y1" r="5" fill="#5a9e6f" />
                  <circle :cx="chart2.points[selectedChart2].x" :cy="chart2.points[selectedChart2].y2" r="5" fill="#c5a32d" />
                </template>
                <rect v-for="pt in chart2.points" :key="'h2-'+pt.idx"
                      :x="pt.x - chartW / chart2.points.length / 2" :y="chartPad.top"
                      :width="chartW / chart2.points.length" :height="chartH - chartPad.top - chartPad.bottom"
                      fill="transparent" style="cursor:pointer;" @click.stop="selectedChart2 = selectedChart2 === pt.idx ? null : pt.idx" />
              </svg>
              <div class="forecast-chart-labels">
                <span v-for="lbl in chart2.labels" :key="lbl.label + '2'" class="forecast-chart-label" :style="{ left: (lbl.x / chartW * 100) + '%' }">{{ lbl.label }}</span>
              </div>
              <div class="forecast-chart-legend">
                <span class="forecast-legend-item"><span class="forecast-legend-dot" style="background:#5a9e6f;"></span>{{ viewMode === 'yearly' ? 'Year' : 'Month' }} Sum</span>
                <span class="forecast-legend-item"><span class="forecast-legend-dot" style="background:#c5a32d;"></span>ROI</span>
              </div>
            </div>
          </div>

          <!-- Assumptions Panel -->
          <div class="card mb-16">
            <div class="card-header" style="cursor:pointer;" @click="showAssumptions = !showAssumptions">
              <h3><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;">tune</span>Projection Assumptions</h3>
              <span class="material-icons" style="font-size:20px;color:var(--color-text-secondary);transition:transform 0.2s;" :style="{ transform: showAssumptions ? 'rotate(180deg)' : '' }">expand_more</span>
            </div>
            <div v-if="showAssumptions" class="card-body forecast-assumptions">
              <div class="forecast-input-row">
                <label>Monthly Income</label>
                <input type="number" v-model.number="assumptionIncome" inputmode="decimal" class="form-input" />
              </div>
              <div class="forecast-input-row">
                <label>Monthly Expenses</label>
                <input type="number" v-model.number="assumptionExpenses" inputmode="decimal" class="form-input" />
              </div>
              <div class="forecast-input-row">
                <label>ROI % per Month</label>
                <input type="number" v-model.number="assumptionRoi" step="0.1" inputmode="decimal" class="form-input" />
              </div>
              <div class="forecast-input-row">
                <label>Monthly view horizon</label>
                <input type="number" v-model.number="projectionMonthsMonthly" min="1" max="120" inputmode="numeric" class="form-input" />
              </div>
              <div class="forecast-input-row">
                <label>Yearly view horizon</label>
                <input type="number" v-model.number="projectionYears" min="1" max="50" inputmode="numeric" class="form-input" />
              </div>
              <div class="forecast-input-row">
                <label>Goal Start Value</label>
                <input type="number" v-model.number="goalStart" inputmode="decimal" class="form-input" />
              </div>
              <div class="forecast-input-row">
                <label>Goal Monthly Increment</label>
                <input type="number" v-model.number="goalIncrement" inputmode="decimal" class="form-input" />
              </div>
              <button class="btn btn-text btn-sm" style="margin-top:8px;color:var(--color-primary);" @click="autoDetectAssumptions">
                <span class="material-icons" style="font-size:16px;vertical-align:middle;margin-right:4px;">auto_fix_high</span>Auto-detect from history
              </button>
            </div>
          </div>

          <!-- Data Table -->
          <div class="card mb-16" v-if="displayRows.length > 0">
            <div class="card-header"><h3>{{ viewMode === 'yearly' ? 'Yearly' : 'Monthly' }} Data</h3></div>
            <div class="balance-table-wrap">
              <table class="balance-table forecast-table">
                <thead>
                  <tr>
                    <th class="balance-table-sticky">Date</th>
                    <th>{{ viewMode === 'yearly' ? 'Avg. Income' : 'Income' }}</th>
                    <th>{{ viewMode === 'yearly' ? 'Avg. Expenses' : 'Expenses' }}</th>
                    <th>{{ viewMode === 'yearly' ? 'Avg. Sum' : 'Sum' }}</th>
                    <th>{{ viewMode === 'yearly' ? 'Avg. ROI' : 'ROI' }}</th>
                    <th>Total</th>
                    <th>Goal</th>
                    <th>{{ viewMode === 'yearly' ? 'Interest/yr' : 'ROI %' }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in displayRows" :key="row.key" :class="{ 'forecast-projected': row.isProjected }">
                    <td class="balance-table-sticky balance-table-name">{{ row.date }}</td>
                    <td>{{ fc(row.income) }}</td>
                    <td>{{ fc(row.expenses) }}</td>
                    <td :style="{ color: row.monthSum >= 0 ? 'var(--color-primary)' : 'var(--color-secondary)' }">{{ fc(row.monthSum) }}</td>
                    <td :style="{ color: row.roi >= 0 ? 'var(--color-primary)' : 'var(--color-secondary)' }">{{ fc(row.roi) }}</td>
                    <td style="font-weight:600;">{{ fc(row.total) }}</td>
                    <td>{{ fc(row.goal) }}</td>
                    <td>{{ fmtNum(row.roiPct) }}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="displayRows.length === 0 && !loading" class="empty-state" style="padding:40px 0;">
            <span class="material-icons" style="font-size:48px;color:var(--color-primary);">show_chart</span>
            <h3>No data yet</h3>
            <p>Start tracking your accounts, income, and expenses to see your financial forecast.</p>
          </div>

        </div>
      </template>
      </div>
    </div>
  `,
};
