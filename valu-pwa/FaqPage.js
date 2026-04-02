import { FAQ_CATEGORIES, FAQ_ENTRIES, getFaqsByCategory } from './faqData.js';

const { ref, computed } = Vue;

export default {
  emits: ['go-home', 'navigate'],

  setup() {
    const expandedId = ref(null);
    const activeCategory = ref(null);

    const filteredEntries = computed(() => {
      if (!activeCategory.value) return FAQ_ENTRIES;
      return getFaqsByCategory(activeCategory.value);
    });

    function toggle(id) {
      expandedId.value = expandedId.value === id ? null : id;
    }

    function selectCategory(catId) {
      activeCategory.value = activeCategory.value === catId ? null : catId;
      expandedId.value = null;
    }

    function formatAnswer(text) {
      return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
    }

    return {
      FAQ_CATEGORIES, expandedId, activeCategory,
      filteredEntries, toggle, selectCategory, formatAnswer,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
        <div class="subpage-nav">
          <button class="subpage-back" @click="$emit('go-home')">
            <span class="material-icons">arrow_back</span>
          </button>
          <div class="valu-orb-sm subpage-orb" @click="$emit('navigate', 'assistant')">
            <div class="spheres">
              <div class="spheres-group">
                <div class="sphere s1"></div>
                <div class="sphere s2"></div>
                <div class="sphere s3"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="subpage-header">
          <h1 class="subpage-title">FAQ</h1>
        </div>

        <div class="faq-categories">
          <button v-for="cat in FAQ_CATEGORIES" :key="cat.id"
                  class="faq-cat-chip"
                  :class="{ active: activeCategory === cat.id }"
                  @click="selectCategory(cat.id)">
            <span class="material-icons faq-cat-icon">{{ cat.icon }}</span>
            <span>{{ cat.label }}</span>
          </button>
        </div>

        <div style="padding:0 16px 24px;">
          <div v-for="entry in filteredEntries" :key="entry.id"
               class="faq-item" :class="{ expanded: expandedId === entry.id }">
            <button class="faq-question" @click="toggle(entry.id)">
              <span class="faq-q-text">{{ entry.question }}</span>
              <span class="material-icons faq-chevron">{{ expandedId === entry.id ? 'expand_less' : 'expand_more' }}</span>
            </button>
            <div class="faq-answer" v-if="expandedId === entry.id">
              <div v-html="formatAnswer(entry.answer)"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
