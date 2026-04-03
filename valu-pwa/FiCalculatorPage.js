import SheetsApi, { TABS } from './sheetsApi.js';

const { ref, computed, watch, inject, onMounted, onUnmounted, nextTick } = Vue;

const WIZARD_DONE_KEY = 'valu_fi_wizard_done';

function erf(x) {
  const a1 = 0.278393, a2 = 0.230389, a3 = 0.000972, a4 = 0.078108;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 + a1*x + a2*x*x + a3*x*x*x + a4*x*x*x*x;
  return sign * (1 - 1 / Math.pow(t, 4));
}

const introArr = [
  'Visualize your path to<br><a href="#fi-explainer" class="color-primary">financial independence <span class="material-icons" style="font-size:inherit;vertical-align:middle">info_outline</span></a>',
  'What do you estimate is your current net worth?',
  'What do you estimate is your average monthly income?',
  'What do you estimate are your average monthly expenses?',
  'What do you estimate will be your annual return on investment?',
];

const stepBtns = [
  { label: 'Get Started', hint: 'Your data is private and not shared with us.' },
  { label: 'Next step', hint: "Don't worry, you can update your inputs later." },
  { label: 'Next step', hint: 'Just 2 more steps left.' },
  { label: 'Next step', hint: 'One more step.' },
  { label: 'See results', hint: 'More options available next.' },
];

export default {
  props: ['sheetId', 'settings', 'groupName', 'accounts', 'isDemoGroup'],
  emits: ['navigate', 'go-home'],

  setup(props) {
    const injectedSheetId = inject('activeSheetId', ref(null));
    function getSheetId() { return props.sheetId || injectedSheetId.value; }

    const savings = ref(25);
    const income = ref(4.0);
    const expenses = ref(6.0);
    const rate = ref(5);
    const years = ref(21);
    const withdrawal = ref(4);
    const n = 12;
    let apiFetched = false;

    const wizardDone = ref(localStorage.getItem(WIZARD_DONE_KEY) === '1');
    const currentStep = ref(0);
    const showCalculator = ref(wizardDone.value);

    let rootEl = null;
    let chart = null;
    let chartData = null;
    const chartLoaded = ref(false);
    let tlGraph = null;
    let chartDrawTimeout = null;

    const rotationSnap = 3.6;
    const minVal = 60;
    const maxVal = rotationSnap * 1000 - rotationSnap;

    const savingsRequired = computed(() => {
      const w = rate.value || withdrawal.value;
      if (!expenses.value || !w) return 0;
      return (expenses.value * 12 / (w / 100)).toFixed(0);
    });

    const fiIndex = computed(() => {
      if (!savingsRequired.value || savingsRequired.value == 0) return '0.0';
      const s = Number(savings.value);
      const monthlySavings = (Number(income.value) - Number(expenses.value)) * 1000;
      let fv = s;
      const months = years.value * 12;
      for (let i = 1; i <= months; i++) {
        fv = Number(fv + monthlySavings / 1000) * (1 + rate.value / 100 / n);
      }
      return (Number(fv / savingsRequired.value) * 100).toFixed(1);
    });

    // ── Auto-populate from group data ──
    // Schema: Expenses/Income = [ID, Title, Amount, AccountID, Category, Date, ...]
    // Schema: BalanceHistory   = [AccountID, Year, Month, Balance, UpdatedAt]
    async function autoPopulate() {
      if (apiFetched) return;
      const sid = getSheetId();
      if (!sid) return;
      try {
        const [balRows, expRows, incRows] = await Promise.all([
          SheetsApi.getTabData(sid, TABS.BALANCE_HISTORY).catch(() => []),
          SheetsApi.getTabData(sid, TABS.EXPENSES).catch(() => []),
          SheetsApi.getTabData(sid, TABS.INCOME).catch(() => []),
        ]);
        apiFetched = true;

        if (balRows.length) {
          const activeIds = (props.accounts || []).filter(a => a.discontinued !== 'true').map(a => a.id);
          const latest = {};
          for (const r of balRows) {
            const aid = r[0], ym = (parseInt(r[1]) || 0) * 100 + (parseInt(r[2]) || 0);
            if (activeIds.length && !activeIds.includes(aid)) continue;
            if (!latest[aid] || ym > latest[aid].ym) latest[aid] = { ym, bal: parseFloat(r[3]) || 0 };
          }
          const total = Object.values(latest).reduce((s, v) => s + v.bal, 0);
          if (total) savings.value = Math.round(total / 1000);
        }

        const now = new Date();
        const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);
        if (incRows.length) {
          const recent = incRows.filter(r => new Date(r[5]) >= twelveMonthsAgo);
          if (recent.length) {
            const total = recent.reduce((s, r) => s + (parseFloat(r[2]) || 0), 0);
            const months = Math.max(1, mSpan(recent, 5));
            income.value = Math.round(total / months / 1000 * 10) / 10;
          }
        }
        let expPopulated = false;
        if (expRows.length) {
          const recent = expRows.filter(r => new Date(r[5]) >= twelveMonthsAgo);
          if (recent.length) {
            const total = recent.reduce((s, r) => s + (parseFloat(r[2]) || 0), 0);
            const months = Math.max(1, mSpan(recent, 5));
            expenses.value = Math.round(total / months / 1000 * 10) / 10;
            expPopulated = true;
          }
        }

        if (!expPopulated && balRows.length && incRows.length) {
          const balByMonth = {};
          for (const r of balRows) {
            const ym = `${r[1]}-${String(parseInt(r[2])).padStart(2, '0')}`;
            balByMonth[ym] = (balByMonth[ym] || 0) + (parseFloat(r[3]) || 0);
          }
          const sortedMonths = Object.keys(balByMonth).sort();
          const recentInc = incRows.filter(r => new Date(r[5]) >= twelveMonthsAgo);
          const incByMonth = {};
          for (const r of recentInc) {
            const d = new Date(r[5]);
            if (isNaN(d)) continue;
            const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            incByMonth[ym] = (incByMonth[ym] || 0) + (parseFloat(r[2]) || 0);
          }
          let spendTotal = 0, spendCount = 0;
          for (let i = 1; i < sortedMonths.length; i++) {
            const ym = sortedMonths[i], prevYm = sortedMonths[i - 1];
            if (ym < twelveMonthsAgo.toISOString().slice(0, 7)) continue;
            const inc = incByMonth[ym] || 0;
            const balChange = balByMonth[ym] - balByMonth[prevYm];
            const est = inc - balChange;
            if (est > 0) { spendTotal += est; spendCount++; }
          }
          if (spendCount) {
            expenses.value = Math.round(spendTotal / spendCount / 1000 * 10) / 10;
          }
        }
      } catch (_) {}
    }

    function mSpan(rows, dateIdx) {
      const months = new Set();
      for (const r of rows) {
        const d = new Date(r[dateIdx]);
        if (!isNaN(d)) months.add(d.getFullYear() * 12 + d.getMonth());
      }
      return Math.max(1, months.size);
    }

    function q(sel) { return rootEl ? rootEl.querySelector(sel) : null; }
    function qa(sel) { return rootEl ? rootEl.querySelectorAll(sel) : []; }

    // ── GSAP Graph Animation (from CodePen) ──
    function slowmoGraph() {
      if (!tlGraph) return;
      gsap.fromTo(tlGraph, { timeScale: 2 }, { duration: 2, timeScale: 0.05 });
      gsap.fromTo(tlGraph, { timeScale: 0.05 }, { duration: 15, timeScale: 0.005, delay: 2, repeat: 1, yoyo: true });
    }

    function startGraph() {
      if (typeof gsap === 'undefined' || !rootEl) return;
      if (tlGraph) tlGraph.kill();

      tlGraph = gsap.timeline();
      tlGraph
        .set(qa('.gs1, .gs2, .gs3'), { transformOrigin: 'center center', scale: 1 })
        .to(qa('.graph-spheres-group'), { duration: 1, opacity: 1 })
        .to(qa('.graph-spheres-group'), {
          duration: 1.5, repeat: -1, x: '0%', y: '0%',
          rotate: 360, ease: 'none'
        }, -1)
        .to(qa('.gs3'), { duration: 1, scale: 2.4, visibility: 'visible', ease: 'quad.inOut', repeat: -1, yoyo: true })
        .to(qa('.gs1'), { duration: 1, scale: 3, visibility: 'visible', ease: 'quad.inOut', repeat: -1, yoyo: true }, '-=0.55')
        .to(qa('.gs2'), { duration: 1, scale: 2.6, visibility: 'visible', ease: 'quad.inOut', repeat: -1, yoyo: true }, '-=0.60');

      slowmoGraph();
    }

    function shortGraphAccel() {
      if (!tlGraph) return;
      gsap.to(tlGraph, { duration: 1, timeScale: 2, onComplete: slowmoGraph });
    }

    function graphToIcon() {
      if (typeof gsap === 'undefined' || !rootEl) return;
      gsap.to(tlGraph, { duration: 1, timeScale: 1, onComplete: slowmoGraph });
      gsap.to(qa('.graph-spheres-group'), { duration: 1, scale: 1, x: '0%', y: '0%', height: 160, width: 160 });
      gsap.to(qa('.graph-spheres-group .sphere'), { duration: 1, scale: 1, height: 40, width: 40 });
      gsap.to(qa('.graph-spheres-group .sphere-wrapper'), { duration: 1, scale: 1, height: 160, width: 160 });
    }

    function graphToResults() {
      if (typeof gsap === 'undefined' || !rootEl) return;
      gsap.to(qa('.graph-spheres-group'), {
        duration: 1, repeat: 0, scale: 1, x: '0%', y: '0%',
        height: 240, width: 240, rotate: 720, ease: 'quad.inOut', overwrite: true
      });
      gsap.to(qa('.gs1'), { duration: 1, top: '32%', left: '30%', scale: 1, visibility: 'visible', ease: 'quad.inOut', overwrite: true });
      gsap.to(qa('.gs2'), { duration: 1, top: '32%', left: '70%', scale: 1, visibility: 'visible', ease: 'quad.inOut', overwrite: true });
      gsap.to(qa('.gs3'), { duration: 1, top: '64%', scale: 1, visibility: 'visible', ease: 'quad.inOut', overwrite: true });
      gsap.to(qa('.graph-spheres-group .sphere-wrapper'), { duration: 1, scale: 1, height: 240, width: 240 });
      gsap.to(qa('.gws1'), { duration: 1, top: '32%', left: '30%', visibility: 'visible', ease: 'quad.inOut' });
      gsap.to(qa('.gws2'), { duration: 1, top: '32%', left: '70%', visibility: 'visible', ease: 'quad.inOut' });
      gsap.to(qa('.gws3'), { duration: 1, top: '64%', visibility: 'visible', ease: 'quad.inOut' });
    }

    // ── Knob / Draggable ──
    function graphActivate(num) {
      if (!rootEl) return;
      if (num == 0) {
        qa('.financial-independence-graph').forEach(e => e.classList.remove('is-active'));
        qa('.financial-independence-graph .sphere, .financial-independence-graph .sphere-wrapper').forEach(e => e.classList.remove('current'));
        if (typeof gsap !== 'undefined') {
          if (showCalculator.value) {
            gsap.to(qa('.fi-info-area'), { duration: 0.3, autoAlpha: 1, overwrite: true });
          }
          gsap.to(qa('.fi-display'), { duration: 0.3, autoAlpha: 0, overwrite: true });
        }
        return;
      }

      const typeMap = { 1: 'income', 2: 'expenses', 3: 'savings', 4: 'rate' };
      const type = typeMap[num];
      const inCalc = showCalculator.value;

      if (inCalc) {
        qa('.spheres.financial-independence-graph').forEach(e => e.classList.remove('is-active'));
        qa('.calculator-buttons.financial-independence-graph').forEach(e => e.classList.add('is-active'));
      } else {
        qa('.spheres.financial-independence-graph').forEach(e => e.classList.add('is-active'));
      }

      qa('.financial-independence-graph .sphere, .financial-independence-graph .sphere-wrapper').forEach(e => e.classList.remove('current'));

      if (inCalc) {
        qa('.calculator-buttons .gs' + num + ', .calculator-buttons .gws' + num).forEach(e => e.classList.add('current'));
      } else {
        qa('.spheres.financial-independence-graph .gs' + num + ', .spheres.financial-independence-graph .gws' + num).forEach(e => e.classList.add('current'));
      }

      setKnob();

      const val = type === 'savings' ? savings.value : type === 'rate' ? rate.value : type === 'income' ? income.value : expenses.value;
      const isSavings = type === 'savings';
      const rot = isSavings ? val * rotationSnap : val * 10 * rotationSnap;
      const curKnob = q('.knob.current');
      if (curKnob && rot > 0 && typeof gsap !== 'undefined') {
        gsap.set(curKnob, { rotation: rot });
      }

      if (!inCalc && typeof gsap !== 'undefined') {
        gsap.to(qa('.fi-info-area'), { duration: 0.3, autoAlpha: 0, overwrite: true });
        gsap.fromTo(qa('.fi-display'), { autoAlpha: 0, scale: 0.6 }, { duration: 0.3, autoAlpha: 1, scale: 1, delay: 0.6, overwrite: true });
      }
      updateCountDisplay(type);
    }

    function updateCountDisplay(type) {
      if (!rootEl) return;
      const display = q('.fi-count');
      if (!display) return;
      const val = type === 'savings' ? savings.value : type === 'rate' ? rate.value : type === 'income' ? income.value : expenses.value;
      const isSavings = type === 'savings';
      const isRate = type === 'rate';
      const count = isSavings ? Number(val).toFixed(0) : Number(val).toFixed(1);
      const unit = isRate ? '%' : 'k';
      display.innerHTML = count + "<span class='count-type'>" + unit + "</span>";

      const rotVal = isSavings ? val * rotationSnap : val * 10 * rotationSnap;
      const size = minVal + Math.pow(erf(Math.min(rotVal, maxVal) / maxVal * 6), 0.1) * (240 - minVal);
      if (typeof gsap !== 'undefined') {
        gsap.to(qa('.sphere.current'), { duration: 1, scale: 1, height: size, width: size });
      }
    }

    function setKnob() {
      if (typeof Draggable === 'undefined' || !rootEl) return;
      qa('.knob').forEach(k => { const d = Draggable.get(k); if (d) d.disable(); });
      const cur = q('.knob.current');
      if (!cur) return;
      Draggable.create(cur, {
        trigger: cur.querySelector('.trigger'),
        type: 'rotation',
        inertia: typeof InertiaPlugin !== 'undefined',
        liveSnap: false,
        onPress() { const tr = this.vars.trigger; if (tr) tr.classList.remove('ripple'); },
        onDrag() { knobUpdate(this); },
        onThrowUpdate() { knobUpdate(this); },
        snap(endValue) {
          let v = Math.round(endValue / rotationSnap) * rotationSnap;
          v = Math.max(0, Math.min(3600, v));
          const tr = this.vars ? this.vars.trigger : null;
          if (tr) tr.classList.add('ripple');
          return v;
        }
      });
    }

    function knobUpdate(trgt) {
      const target = trgt.target;
      target.classList.remove('first-interaction');
      let newVal = Math.round(trgt.rotation / rotationSnap) * rotationSnap;
      newVal = Math.max(0, Math.min(3600 - rotationSnap, newVal));

      if (newVal * 10 % 36 === 0 && navigator.vibrate) navigator.vibrate(10);

      const type = target.getAttribute('data-type');
      const isSavings = target.classList.contains('gws3');
      const count = isSavings ? (newVal / rotationSnap).toFixed(0) : (newVal / rotationSnap / 10).toFixed(1);

      if (type === 'savings') savings.value = Number(count);
      else if (type === 'income') income.value = Number(count);
      else if (type === 'expenses') expenses.value = Number(count);
      else if (type === 'rate') rate.value = Number(count);

      const display = q('.fi-count');
      if (display) {
        const unit = type === 'rate' ? '%' : 'k';
        display.innerHTML = count + "<span class='count-type'>" + unit + "</span>";
      }

      const size = minVal + Math.pow(erf(newVal / maxVal * 6), 0.1) * (240 - minVal);
      if (typeof gsap !== 'undefined') {
        gsap.to(qa('.sphere.current'), { duration: 1, scale: 1, height: size, width: size });
      }
    }

    // ── Wizard ──
    function nextStep() {
      try {
        if (currentStep.value >= 4) {
          showCalculator.value = true;
          wizardDone.value = true;
          try { localStorage.setItem(WIZARD_DONE_KEY, '1'); } catch (_) {}
          nextTick(() => {
            syncCalcKnobRotations();
            graphActivate(0);
            graphToResults();
            if (typeof gsap !== 'undefined') {
              gsap.to(qa('.fi-info-area'), { duration: 0.6, autoAlpha: 1, delay: 0.3 });
            }
            drawChart();
          });
          return;
        }

        currentStep.value++;

        const scrollEl = rootEl ? rootEl.closest('.subpage-scroll') || rootEl : null;
        if (scrollEl) scrollEl.scrollTop = 0;

        if (typeof gsap !== 'undefined') graphToResults();

        const stepToGraph = { 1: 3, 2: 1, 3: 2, 4: 4 };
        graphActivate(stepToGraph[currentStep.value] || 0);
      } catch (e) {
        console.error('FI nextStep error:', e);
      }
    }

    function resetWizard() {
      chart = null;
      apiFetched = false;
      showCalculator.value = false;
      wizardDone.value = false;
      currentStep.value = 0;
      try { localStorage.removeItem(WIZARD_DONE_KEY); } catch (_) {}
      autoPopulate();
      nextTick(() => {
        if (typeof gsap !== 'undefined') {
          gsap.to(qa('.fi-info-area'), { duration: 0.3, autoAlpha: 0 });
          gsap.to(qa('.fi-display'), { duration: 0.3, autoAlpha: 0 });
        }
        startGraph();
        graphToIcon();
      });
    }

    function syncCalcKnobRotations() {
      if (typeof gsap === 'undefined' || !rootEl) return;
      const calcBtns = rootEl.querySelector('.calculator-buttons');
      if (!calcBtns) return;
      const savRot = savings.value * rotationSnap;
      const incRot = income.value * 10 * rotationSnap;
      const expRot = expenses.value * 10 * rotationSnap;
      const ratRot = rate.value * 10 * rotationSnap;
      const s3 = calcBtns.querySelector('.gws3'); if (s3) gsap.set(s3, { rotation: savRot });
      const s1 = calcBtns.querySelector('.gws1'); if (s1) gsap.set(s1, { rotation: incRot });
      const s2 = calcBtns.querySelector('.gws2'); if (s2) gsap.set(s2, { rotation: expRot });
      const s4 = calcBtns.querySelector('.gws4'); if (s4) gsap.set(s4, { rotation: ratRot });
    }

    function activateCalcButton(num) {
      if (!rootEl) return;
      const btns = qa('.btn-graph-activate');
      const clicked = q('.btn-graph-activate[data-graph-num="' + num + '"]');
      if (clicked && clicked.classList.contains('current')) {
        btns.forEach(b => b.classList.remove('current'));
        graphActivate(0);
      } else {
        btns.forEach(b => b.classList.remove('current'));
        if (clicked) clicked.classList.add('current');
        graphActivate(num);
      }
    }

    // ── Google Charts ──
    function loadGoogleCharts() {
      return new Promise((resolve) => {
        if (typeof google !== 'undefined' && google.charts) {
          google.charts.load('current', { packages: ['corechart'] });
          google.charts.setOnLoadCallback(() => { chartLoaded.value = true; resolve(); });
          return;
        }
        const s = document.createElement('script');
        s.src = 'https://www.gstatic.com/charts/loader.js';
        s.onload = () => {
          google.charts.load('current', { packages: ['corechart'] });
          google.charts.setOnLoadCallback(() => { chartLoaded.value = true; resolve(); });
        };
        document.head.appendChild(s);
      });
    }

    function drawChart() {
      if (!chartLoaded.value) return;
      const el = document.getElementById('fi-curve-chart');
      if (!el) return;

      const rows = [['Year', 'Savings']];
      const s = Number(savings.value) * 1000;
      const monthSum = (Number(income.value) - Number(expenses.value)) * 1000;
      const r = rate.value / 100;

      for (let i = 0; i < 43; i++) {
        let v;
        if (r === 0) { v = s + monthSum * i * 12; }
        else { v = Math.round(s * Math.pow(1 + r/12, 12*i) + monthSum * ((Math.pow(1 + r/12, 12*i) - 1) / (r/12))); }
        rows.push([i <= 40 ? String(i) : '', v]);
      }

      chartData = google.visualization.arrayToDataTable(rows);
      const showEvery = years.value < 16 ? 1 : 5;
      const options = {
        height: 210, curveType: 'function', legend: { position: 'none' },
        pointsVisible: true, pointSize: 2, tooltip: { trigger: 'focus' },
        colors: ['#C5A32D'], backgroundColor: 'transparent',
        chartArea: { top: 0, bottom: 0, left: 0, right: 0 },
        hAxis: { textPosition: 'in', textStyle: { color: '#a5a4a4' }, viewWindow: { min: 1, max: years.value }, showTextEvery: showEvery },
        vAxis: { baseline: Number(savingsRequired.value) * 1000, baselineColor: '#a5a4a4', format: 'currency', gridlines: { count: 0 }, textPosition: 'none' },
        animation: { duration: 800, easing: 'out' },
      };
      chart = new google.visualization.LineChart(el);
      chart.draw(chartData, options);
      positionChartLabel();
    }

    function positionChartLabel() {
      nextTick(() => {
        const rect = document.querySelector('#fi-curve-chart rect[fill="#a5a4a4"]');
        const label = document.querySelector('.fi-chart-label');
        if (rect && label) {
          label.style.top = (Number(rect.getAttribute('y')) + 2) + 'px';
        }
      });
    }

    watch(() => props.sheetId, (sid) => { if (sid) autoPopulate(); }, { immediate: true });

    watch([savings, income, expenses, rate, years, withdrawal], () => {
      if (showCalculator.value) {
        if (chartDrawTimeout) clearTimeout(chartDrawTimeout);
        chartDrawTimeout = setTimeout(drawChart, 300);
      }
    });

    function handleHashClick(e) {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      e.preventDefault();
      const target = rootEl ? rootEl.querySelector(a.getAttribute('href')) : document.querySelector(a.getAttribute('href'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    onMounted(async () => {
      rootEl = document.querySelector('.fi-page');
      if (rootEl) rootEl.addEventListener('click', handleHashClick);
      autoPopulate();
      loadGoogleCharts();
      nextTick(() => {
        startGraph();
        if (showCalculator.value) {
          graphToResults();
          nextTick(() => {
            syncCalcKnobRotations();
            drawChart();
            if (typeof gsap !== 'undefined') gsap.to(qa('.fi-info-area'), { duration: 0.6, autoAlpha: 1, delay: 0.3 });
          });
        } else {
          graphToIcon();
        }
      });
    });

    onUnmounted(() => {
      if (chartDrawTimeout) clearTimeout(chartDrawTimeout);
      if (tlGraph) tlGraph.kill();
      if (rootEl) rootEl.removeEventListener('click', handleHashClick);
    });

    return {
      savings, income, expenses, rate, years, withdrawal,
      savingsRequired, fiIndex,
      currentStep, showCalculator,
      nextStep, resetWizard, activateCalcButton,
      stepBtns, introArr,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll fi-page">

      <!-- Nav -->
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">FI Calculator</h1>
        <div class="valu-orb-sm subpage-orb-inline" @click="$emit('navigate', 'assistant')">
          <div class="spheres"><div class="spheres-group"><div class="sphere s1"></div><div class="sphere s2"></div><div class="sphere s3"></div></div></div>
        </div>
      </div>

      <!-- Intro text (wizard only) -->
      <div v-if="!showCalculator" class="fi-intro-block">
        <h1 class="fi-subtitle"><br><br></h1>
        <h2 class="fi-heading">Financial<br>Independence</h2>
        <p class="fi-intro-text" v-html="introArr[currentStep]"></p>
      </div>

      <!-- Sphere graph area (wizard only — hidden when calculator shown) -->
      <div v-show="!showCalculator" class="fi-graph-area">
        <div class="fi-results">
          <!-- Count display (visible when dragging knob) -->
          <div class="fi-display">
            <div class="fi-count">0<span class="count-type">k</span></div>
          </div>
          <!-- FI index (visible in calculator mode) -->
          <div class="fi-info-area">
            <div class="fi-intersection-wrapper">
              <svg class="fi-intersection" width="236" height="246" viewBox="0 0 236 246" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M1.53908 33.1842C34.6068 12.4208 73.777 0.405976 115.767 0.40598C159.685 0.405984 200.518 13.5492 234.51 36.0985C235.198 43.0207 235.551 50.0417 235.551 57.1451C235.551 140.026 187.57 211.701 117.869 245.907C48.169 211.701 0.188028 140.026 0.188035 57.145C0.188036 49.0428 0.646563 41.0477 1.53908 33.1842Z" fill="currentColor" />
              </svg>
            </div>
            <div class="fi-index-block">
              <div class="fi-index-value">{{ fiIndex }}<small>%</small></div>
              <div class="fi-index-label">Financial Independence<br/>Index</div>
            </div>
          </div>
          <!-- Animated spheres + knobs -->
          <div class="spheres financial-independence-graph">
            <div class="graph-spheres-group">
              <div class="sphere gs1"></div>
              <div class="sphere gs2"></div>
              <div class="sphere gs3"></div>
              <div class="spheres-wrapper">
                <div class="sphere-wrapper gws1 knob" data-type="income"><div class="trigger ripple"></div></div>
                <div class="sphere-wrapper gws2 knob" data-type="expenses"><div class="trigger ripple"></div></div>
                <div class="sphere-wrapper gws3 knob first-interaction" data-type="savings"><div class="trigger ripple"></div></div>
                <div class="sphere-wrapper gws4 knob" data-type="rate"><div class="trigger ripple"></div></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Wizard steps -->
      <div v-if="!showCalculator" class="fi-steps-wrapper">
        <div class="fi-step-action">
          <button class="fi-step-btn" @click="nextStep">{{ stepBtns[currentStep].label }}</button>
          <div class="fi-step-hint">{{ stepBtns[currentStep].hint }}</div>
        </div>
        <div id="fi-explainer" class="fi-step-explainer" v-if="currentStep === 0">
          <h3>What is Financial Independence?</h3>
          <p>It is the status of having enough income to pay one's living expenses for the rest of one's life without having to be employed or dependent on others.</p>
          <h3>Why this calculator?</h3>
          <p>We believe that anyone can achieve financial independence. The calculator is meant to assist in visualizing your path towards it.</p>
          <p>For example, imagine reaching 50% of your financial independence, meaning your savings/investments could already be generating half of your monthly living expenses, possibly allowing you to work part-time.</p>
        </div>
        <div class="fi-step-explainer" v-else-if="currentStep === 1">
          <h3>What we mean by Current Net Worth?</h3>
          <p>We're referring to the total amount of money that you currently have — for example in cash, on your checking account, savings account, investment account, property value, etc.</p>
        </div>
        <div class="fi-step-explainer" v-else-if="currentStep === 2">
          <h3>What we mean by Average Monthly Income?</h3>
          <p>Try to estimate what you expect to be earning on average per month (e.g. in salary, dividends, etc.) over the amount of years that you are looking to make your calculation.</p>
        </div>
        <div class="fi-step-explainer" v-else-if="currentStep === 3">
          <h3>How to define your Average Monthly Expenses?</h3>
          <p>Try to take into consideration what would be the preferred cost of living for you, as well as what monthly expenses you expect to have towards that goal and try to define a realistic average for you.</p>
        </div>
        <div class="fi-step-explainer" v-else-if="currentStep === 4">
          <h3>What is the average Annual Return on Investment that you expect?</h3>
          <p>As a reference (as of early 2025): savings accounts typically offer around 2%, the average annual increase in Canadian home prices has been roughly 6.3% since 1990, the S&P 500 has averaged around 9–10% annually over the last 30 years, and top-performing tech stocks have seen significantly higher but more volatile returns. Past performance does not guarantee future results.</p>
        </div>
      </div>

      <!-- Calculator panel -->
      <div v-if="showCalculator" class="fi-calculator-panel">
        <h1 class="fi-subtitle"><br><br></h1>
        <h2 class="fi-heading">Financial<br>Independence</h2>
        <div class="fi-chart-area">
          <div class="fi-chart-label"><small>Net worth goal <strong>{{ savingsRequired }}k</strong></small></div>
          <div id="fi-curve-chart"></div>
        </div>
        <div class="fi-calc-inputs">
          <div class="calculator-buttons financial-independence-graph">
            <div class="fi-btn-row">
              <a class="btn-savings btn-graph-activate" data-graph-num="3" @click="activateCalcButton(3)">
                <div class="sphere-wrapper gws3 knob first-interaction" data-type="savings"><div class="trigger ripple"></div></div>
                <span class="fi-btn-inner">
                  <span class="fi-btn-value">{{ savings }}<span class="multiplier">k</span></span>
                  <span class="fi-btn-label color-tertiary">Initial<br/>net worth</span>
                </span>
              </a>
              <a class="btn-income btn-graph-activate" data-graph-num="1" @click="activateCalcButton(1)">
                <div class="sphere-wrapper gws1 knob" data-type="income"><div class="trigger ripple"></div></div>
                <span class="fi-btn-inner">
                  <span class="fi-btn-value">{{ income }}<span class="multiplier">k</span></span>
                  <span class="fi-btn-label color-primary">Average monthly<br/>income</span>
                </span>
              </a>
              <a class="btn-expenses btn-graph-activate" data-graph-num="2" @click="activateCalcButton(2)">
                <div class="sphere-wrapper gws2 knob" data-type="expenses"><div class="trigger ripple"></div></div>
                <span class="fi-btn-inner">
                  <span class="fi-btn-value">{{ expenses }}<span class="multiplier">k</span></span>
                  <span class="fi-btn-label color-secondary">Average monthly<br/>expenses</span>
                </span>
              </a>
            </div>
          </div>
          <div class="fi-sliders">
            <div class="fi-slider-row">
              <div class="fi-slider-header"><small>Annual return on investment</small><small>{{ rate }}%</small></div>
              <input type="range" class="fi-range" min="0" max="50" step="0.5" v-model.number="rate"
                :style="{ background: 'linear-gradient(to right, #729c9c ' + (rate/50*100) + '%, white ' + (rate/50*100) + '%)' }" />
            </div>
            <div class="fi-slider-row">
              <div class="fi-slider-header"><small>Years</small><small>{{ years }}</small></div>
              <input type="range" class="fi-range" min="6" max="41" step="1" v-model.number="years"
                :style="{ background: 'linear-gradient(to right, #729c9c ' + ((years-6)/(41-6)*100) + '%, white ' + ((years-6)/(41-6)*100) + '%)' }" />
            </div>
          </div>
        </div>
        <div class="fi-reset">
          <button class="btn-text-link btn-text-muted" @click="resetWizard">Restart wizard</button>
        </div>
      </div>

      </div>
    </div>
  `
};
