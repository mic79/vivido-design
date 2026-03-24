/* Branded YYYY-MM-DD picker — native date inputs are not themeable in browsers. */
const { ref, computed, watch, onMounted, onUnmounted, nextTick } = Vue;

function parseISO(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const dt = new Date(y, mo, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return dt;
}

function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export default {
  name: 'ValuDateField',
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: 'Select date' },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const open = ref(false);
    const root = ref(null);
    const popoverRef = ref(null);
    const popoverStyle = ref({});
    let posRaf = 0;
    let listenersBound = false;

    function schedulePosition() {
      cancelAnimationFrame(posRaf);
      posRaf = requestAnimationFrame(() => {
        posRaf = 0;
        updatePosition();
      });
    }

    function bindPositionListeners() {
      if (listenersBound) return;
      listenersBound = true;
      window.addEventListener('scroll', schedulePosition, true);
      window.addEventListener('resize', schedulePosition);
    }

    function unbindPositionListeners() {
      if (!listenersBound) return;
      listenersBound = false;
      window.removeEventListener('scroll', schedulePosition, true);
      window.removeEventListener('resize', schedulePosition);
    }

    function updatePosition() {
      if (!open.value || !root.value) return;
      const el = root.value;
      const pop = popoverRef.value;
      const r = el.getBoundingClientRect();
      const vm = 8;
      const hPad = 20;
      let width = Math.min(window.innerWidth - vm * 2, r.width + hPad * 2);
      let left = r.left - hPad;
      left = Math.max(vm, Math.min(left, window.innerWidth - vm - width));
      const gap = 4;
      const estH = pop && pop.offsetHeight ? pop.offsetHeight : 300;
      const spaceBelow = window.innerHeight - r.bottom - gap - vm;
      /* Match ValuDropdown / ValuCurrencyPicker: flip up unless there is comfortable space below */
      const minComfortBelow = Math.min(estH, 280);
      const preferBelow = spaceBelow >= minComfortBelow || r.top < 200;
      let top;
      let maxH;
      if (preferBelow) {
        top = r.bottom + gap;
        maxH = Math.min(420, window.innerHeight - top - vm);
      } else {
        maxH = Math.min(420, r.top - gap - vm);
        top = r.top - Math.min(estH, maxH) - gap;
        if (top < vm) {
          top = vm;
          maxH = Math.min(420, window.innerHeight - vm - top);
        }
      }
      popoverStyle.value = {
        position: 'fixed',
        left: left + 'px',
        top: top + 'px',
        width: width + 'px',
        maxHeight: maxH + 'px',
        overflowY: 'auto',
        zIndex: 400,
        overscrollBehavior: 'contain',
      };
    }
    const viewY = ref(new Date().getFullYear());
    const viewM = ref(new Date().getMonth());
    const sel = computed(() => parseISO(props.modelValue));

    function syncView() {
      const d = sel.value;
      if (d) {
        viewY.value = d.getFullYear();
        viewM.value = d.getMonth();
      }
    }
    watch(() => props.modelValue, syncView, { immediate: true });

    watch(open, async (v) => {
      if (v) {
        await nextTick();
        updatePosition();
        await nextTick();
        updatePosition();
        bindPositionListeners();
      } else {
        unbindPositionListeners();
        popoverStyle.value = {};
      }
    });

    watch([viewM, viewY], () => {
      if (open.value) nextTick(() => schedulePosition());
    });

    const label = computed(() => {
      const d = sel.value;
      if (!d) return props.placeholder;
      try {
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } catch (e) {
        return props.modelValue;
      }
    });

    const title = computed(() =>
      new Date(viewY.value, viewM.value, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    );

    const weeks = computed(() => {
      const y = viewY.value;
      const m = viewM.value;
      const pad = new Date(y, m, 1).getDay();
      const dim = new Date(y, m + 1, 0).getDate();
      const prevLast = new Date(y, m, 0).getDate();
      const cells = [];
      let i;
      for (i = 0; i < pad; i++) {
        const day = prevLast - pad + i + 1;
        cells.push({ o: true, date: new Date(y, m - 1, day) });
      }
      for (i = 1; i <= dim; i++) cells.push({ o: false, date: new Date(y, m, i) });
      let n = 1;
      while (cells.length % 7) cells.push({ o: true, date: new Date(y, m + 1, n++) });
      const w = [];
      for (i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7));
      return w;
    });

    const today = computed(() => {
      const t = new Date();
      return new Date(t.getFullYear(), t.getMonth(), t.getDate());
    });

    function toggle() {
      open.value = !open.value;
      if (open.value) syncView();
    }

    function pick(c) {
      emit('update:modelValue', toISO(c.date));
      viewY.value = c.date.getFullYear();
      viewM.value = c.date.getMonth();
      open.value = false;
    }

    function prev() {
      if (viewM.value) viewM.value--;
      else {
        viewM.value = 11;
        viewY.value--;
      }
    }

    function next() {
      if (viewM.value < 11) viewM.value++;
      else {
        viewM.value = 0;
        viewY.value++;
      }
    }

    function onToday() {
      const t = today.value;
      emit('update:modelValue', toISO(t));
      viewY.value = t.getFullYear();
      viewM.value = t.getMonth();
      open.value = false;
    }

    function onClear() {
      emit('update:modelValue', '');
      open.value = false;
    }

    function cls(c) {
      const d = c.date;
      return {
        'valu-date-picker-cell--other': c.o,
        'valu-date-picker-cell--selected': sel.value && sameDay(d, sel.value),
        'valu-date-picker-cell--today': sameDay(d, today.value),
      };
    }

    function doc(e) {
      if (!open.value) return;
      const t = e.target;
      if (root.value && root.value.contains(t)) return;
      if (popoverRef.value && popoverRef.value.contains(t)) return;
      open.value = false;
    }

    onMounted(() => document.addEventListener('pointerdown', doc, true));
    onUnmounted(() => {
      document.removeEventListener('pointerdown', doc, true);
      unbindPositionListeners();
      cancelAnimationFrame(posRaf);
    });

    return {
      root,
      popoverRef,
      popoverStyle,
      open,
      toggle,
      label,
      title,
      weeks,
      WD,
      prev,
      next,
      pick,
      onToday,
      onClear,
      cls,
    };
  },
  template:
    '<div ref="root" class="valu-date-field" :class="{ \'valu-date-field--open\': open }">' +
    '<button type="button" class="valu-date-field-trigger" :aria-expanded="open" aria-haspopup="dialog" @click.stop="toggle">' +
    '<span :class="{ \'valu-date-field-placeholder\': !modelValue }">{{ label }}</span>' +
    '<span class="material-icons valu-date-field-icon" aria-hidden="true">calendar_today</span></button>' +
    '<Teleport to="body">' +
    '<div v-if="open" ref="popoverRef" class="valu-date-picker-popover" role="dialog" aria-label="Choose date" @click.stop :style="popoverStyle">' +
    '<div class="valu-date-picker-header">' +
    '<button type="button" class="valu-date-picker-nav" aria-label="Previous month" @click="prev"><span class="material-icons">chevron_left</span></button>' +
    '<div class="valu-date-picker-title">{{ title }}</div>' +
    '<button type="button" class="valu-date-picker-nav" aria-label="Next month" @click="next"><span class="material-icons">chevron_right</span></button>' +
    '</div>' +
    '<div class="valu-date-picker-weekdays"><span v-for="w in WD" :key="w" class="valu-date-picker-wd">{{ w }}</span></div>' +
    '<div class="valu-date-picker-grid">' +
    '<div v-for="(wk, wi) in weeks" :key="wi" class="valu-date-picker-row">' +
    '<button v-for="(c, ci) in wk" :key="ci" type="button" class="valu-date-picker-cell" :class="cls(c)" @click="pick(c)">{{ c.date.getDate() }}</button>' +
    '</div></div>' +
    '<div class="valu-date-picker-footer">' +
    '<button type="button" class="valu-date-picker-link" @click="onClear">Clear</button>' +
    '<button type="button" class="valu-date-picker-link" @click="onToday">Today</button>' +
    '</div></div>' +
    '</Teleport>' +
    '</div>',
};
