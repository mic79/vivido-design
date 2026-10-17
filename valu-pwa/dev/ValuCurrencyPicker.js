/* Searchable currency list — Teleport + fixed position + flip when space below is tight (same idea as ValuDropdown). */
const { ref, watch, onMounted, onUnmounted, nextTick } = Vue;

export default {
  name: 'ValuCurrencyPicker',
  props: {
    open: { type: Boolean, default: false },
    search: { type: String, default: '' },
  },
  emits: ['update:open', 'update:search'],
  setup(props, { emit }) {
    const root = ref(null);
    const panelRef = ref(null);
    const searchInput = ref(null);
    const panelStyle = ref({});
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
      if (!props.open || !root.value) return;
      const trigger = root.value.querySelector('.currency-picker-trigger');
      const panel = panelRef.value;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const vm = 8;
      const hPad = 20;
      const width = Math.min(window.innerWidth - vm * 2, r.width + hPad * 2);
      let left = r.left - hPad;
      left = Math.max(vm, Math.min(left, window.innerWidth - vm - width));
      const gap = 4;
      const estH = panel && panel.offsetHeight ? panel.offsetHeight : 320;
      const spaceBelow = window.innerHeight - r.bottom - gap - vm;
      /* Same flip rule as ValuDateField / ValuDropdown (search + list needs room below) */
      const minComfortBelow = Math.min(estH, 280);
      const preferBelow = spaceBelow >= minComfortBelow || r.top < 200;
      const maxPanel = 420;
      let top;
      let maxH;
      if (preferBelow) {
        top = r.bottom + gap;
        maxH = Math.min(maxPanel, spaceBelow);
      } else {
        maxH = Math.min(maxPanel, r.top - gap - vm);
        top = r.top - Math.min(estH, maxH) - gap;
        if (top < vm) {
          top = vm;
          maxH = Math.min(maxPanel, window.innerHeight - vm - top);
        }
      }
      panelStyle.value = {
        position: 'fixed',
        left: left + 'px',
        top: top + 'px',
        width: width + 'px',
        maxHeight: maxH + 'px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 380,
        overscrollBehavior: 'contain',
      };
    }

    watch(
      () => props.open,
      async (v) => {
        if (v) {
          await nextTick();
          updatePosition();
          await nextTick();
          updatePosition();
          searchInput.value?.focus?.();
          bindPositionListeners();
        } else {
          unbindPositionListeners();
          panelStyle.value = {};
        }
      }
    );

    watch(
      () => props.search,
      () => {
        if (props.open) nextTick(() => schedulePosition());
      }
    );

    function doc(e) {
      if (!props.open) return;
      const t = e.target;
      if (root.value && root.value.contains(t)) return;
      if (panelRef.value && panelRef.value.contains(t)) return;
      emit('update:open', false);
    }

    function onTriggerClick(e) {
      e.stopPropagation();
      const next = !props.open;
      if (next) emit('update:search', '');
      emit('update:open', next);
    }

    onMounted(() => document.addEventListener('pointerdown', doc, true));
    onUnmounted(() => {
      document.removeEventListener('pointerdown', doc, true);
      unbindPositionListeners();
      cancelAnimationFrame(posRaf);
    });

    return { root, panelRef, panelStyle, searchInput, onTriggerClick };
  },
  template:
    '<div ref="root" class="currency-picker" :class="{ \'currency-picker--open\': open }" @click.stop>' +
    '<button type="button" class="currency-picker-trigger" @click="onTriggerClick">' +
    '<span class="currency-picker-label"><slot name="label" /></span>' +
    '<span class="material-icons currency-picker-arrow">expand_more</span></button>' +
    '<Teleport to="body">' +
    '<div v-if="open" ref="panelRef" class="currency-picker-dropdown currency-picker-dropdown--portal" :style="panelStyle" @click.stop>' +
    '<input ref="searchInput" class="currency-picker-search" :value="search" ' +
    '@input="$emit(\'update:search\', $event.target.value)" placeholder="Search currencies..." @click.stop />' +
    '<div class="currency-picker-list currency-picker-list--portal"><slot /></div>' +
    '</div>' +
    '</Teleport>' +
    '</div>',
};
