/* Custom select list — Teleport + fixed position so sheets/modals never clip the menu. */
const { ref, watch, onMounted, onUnmounted, nextTick } = Vue;

export default {
  name: 'ValuDropdown',
  props: {
    open: { type: Boolean, default: false },
  },
  emits: ['update:open'],
  setup(props, { emit }) {
    const root = ref(null);
    const listRef = ref(null);
    const listStyle = ref({});
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
      const trigger = root.value.querySelector('.valu-dropdown-trigger');
      const list = listRef.value;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const vm = 8;
      const hPad = 20;
      const width = Math.min(window.innerWidth - vm * 2, r.width + hPad * 2);
      let left = r.left - hPad;
      left = Math.max(vm, Math.min(left, window.innerWidth - vm - width));
      const gap = 4;
      const estH = list && list.offsetHeight ? list.offsetHeight : 220;
      const spaceBelow = window.innerHeight - r.bottom - gap - vm;
      const minComfortBelow = Math.min(estH, 280);
      const preferBelow = spaceBelow >= minComfortBelow || r.top < 200;
      const maxList = 340;
      let top;
      let maxH;
      if (preferBelow) {
        top = r.bottom + gap;
        maxH = Math.min(maxList, spaceBelow);
      } else {
        maxH = Math.min(maxList, r.top - gap - vm);
        top = r.top - Math.min(estH, maxH) - gap;
        if (top < vm) {
          top = vm;
          maxH = Math.min(maxList, window.innerHeight - vm - top);
        }
      }
      listStyle.value = {
        position: 'fixed',
        left: left + 'px',
        top: top + 'px',
        width: width + 'px',
        maxHeight: maxH + 'px',
        overflowY: 'auto',
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
          bindPositionListeners();
        } else {
          unbindPositionListeners();
          listStyle.value = {};
        }
      }
    );

    function doc(e) {
      if (!props.open) return;
      const t = e.target;
      if (root.value && root.value.contains(t)) return;
      if (listRef.value && listRef.value.contains(t)) return;
      emit('update:open', false);
    }

    function onTriggerClick(e) {
      e.stopPropagation();
      emit('update:open', !props.open);
    }

    onMounted(() => document.addEventListener('pointerdown', doc, true));
    onUnmounted(() => {
      document.removeEventListener('pointerdown', doc, true);
      unbindPositionListeners();
      cancelAnimationFrame(posRaf);
    });

    return { root, listRef, listStyle, onTriggerClick };
  },
  template:
    '<div ref="root" class="valu-dropdown" :class="{ \'valu-dropdown--open\': open }" @click.stop>' +
    '<button type="button" class="valu-dropdown-trigger" @click="onTriggerClick">' +
    '<span class="valu-dropdown-label"><slot name="label" /></span>' +
    '<span class="material-icons valu-dropdown-arrow">expand_more</span></button>' +
    '<Teleport to="body">' +
    '<div v-if="open" ref="listRef" class="valu-dropdown-list valu-dropdown-list--portal" :style="listStyle" @click.stop>' +
    '<slot />' +
    '</div>' +
    '</Teleport>' +
    '</div>',
};
