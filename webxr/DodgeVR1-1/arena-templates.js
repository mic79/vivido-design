/**
 * ARENA OBJECT TEMPLATES - Bulletproof Serialization System
 * 
 * This file defines templates for all arena objects to ensure consistent
 * and complete synchronization across multiplayer clients.
 * 
 * Key features:
 * - Predefined templates for each object type
 * - Automatic attribute extraction
 * - Safe serialization/deserialization
 * - Support for custom components (octahedron-edges, tetrahedron-edges, etc.)
 */

// ============================================================================
// ARENA OBJECT TEMPLATES
// ============================================================================

const ARENA_OBJECT_TEMPLATES = {
  'a-octahedron': {
    tagName: 'a-octahedron',
    geometryAttributes: ['radius', 'detail'],
    components: ['octahedron-edges', 'grab-surface'],
    defaultAttributes: {
      radius: 6,
      detail: 0
    }
  },
  
  'a-tetrahedron': {
    tagName: 'a-tetrahedron',
    geometryAttributes: ['radius', 'detail'],
    components: ['tetrahedron-edges', 'grab-surface'],
    defaultAttributes: {
      radius: 6,
      detail: 0
    }
  },
  
  'a-sphere': {
    tagName: 'a-sphere',
    geometryAttributes: ['radius', 'segments-width', 'segments-height'],
    components: ['grab-surface'],
    defaultAttributes: {
      radius: 1,
      'segments-width': 32,
      'segments-height': 16
    }
  },
  
  'a-box': {
    tagName: 'a-box',
    geometryAttributes: ['width', 'height', 'depth'],
    components: ['grab-surface'],
    defaultAttributes: {
      width: 1,
      height: 1,
      depth: 1
    }
  },
  
  'a-cylinder': {
    tagName: 'a-cylinder',
    geometryAttributes: ['radius', 'height', 'segments-radial', 'segments-height'],
    components: ['grab-surface'],
    defaultAttributes: {
      radius: 1,
      height: 2,
      'segments-radial': 36,
      'segments-height': 18
    }
  },
  
  'a-cone': {
    tagName: 'a-cone',
    geometryAttributes: ['radius-bottom', 'radius-top', 'height', 'segments-radial', 'segments-height'],
    components: ['grab-surface'],
    defaultAttributes: {
      'radius-bottom': 1,
      'radius-top': 0.01,
      height: 2,
      'segments-radial': 36,
      'segments-height': 18
    }
  },
  
  'a-torus': {
    tagName: 'a-torus',
    geometryAttributes: ['radius', 'radius-tubular', 'segments-radial', 'segments-tubular'],
    components: ['grab-surface'],
    defaultAttributes: {
      radius: 1,
      'radius-tubular': 0.2,
      'segments-radial': 36,
      'segments-tubular': 18
    }
  }
};

// Common attributes that apply to all arena objects
const COMMON_ATTRIBUTES = ['color', 'material', 'wireframe'];

// ============================================================================
// SERIALIZATION FUNCTIONS
// ============================================================================

/**
 * Serialize an arena object entity to a data structure
 * @param {Element} entity - The A-Frame entity to serialize
 * @returns {Object|null} Serialized object data or null if invalid
 */
function serializeArenaObject(entity) {
  if (!entity || !entity.object3D) {
    console.warn('⚠️ serializeArenaObject: Invalid entity', entity);
    return null;
  }
  
  const tagName = entity.tagName.toLowerCase();
  const template = ARENA_OBJECT_TEMPLATES[tagName];
  
  if (!template) {
    console.warn(`⚠️ serializeArenaObject: No template for ${tagName}`);
    // Fallback: serialize as generic object
    return serializeGenericArenaObject(entity);
  }
  
  // Get transform data
  const pos = entity.object3D.position;
  const rot = entity.object3D.rotation;
  const scale = entity.object3D.scale;
  
  const data = {
    id: entity.id,
    tagName: tagName,
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: {
      x: THREE.MathUtils.radToDeg(rot.x),
      y: THREE.MathUtils.radToDeg(rot.y),
      z: THREE.MathUtils.radToDeg(rot.z)
    },
    scale: { x: scale.x, y: scale.y, z: scale.z },
    attributes: {}
  };
  
  // Serialize geometry attributes
  template.geometryAttributes.forEach(attrName => {
    const value = entity.getAttribute(attrName);
    if (value !== null && value !== undefined) {
      data.attributes[attrName] = value;
    }
  });
  
  // Serialize common attributes
  COMMON_ATTRIBUTES.forEach(attrName => {
    const value = entity.getAttribute(attrName);
    if (value !== null && value !== undefined) {
      data.attributes[attrName] = value;
    }
  });
  
  // Serialize components (like octahedron-edges, tetrahedron-edges)
  template.components.forEach(compName => {
    // CRITICAL: Get component data from the actual component instance, not getAttribute
    // getAttribute only returns explicitly set values, not defaults from schema
    const compInstance = entity.components[compName];
    
    if (compInstance && compInstance.data) {
      // Component exists - serialize its FULL data including schema defaults
      try {
        // Clone the data to avoid modifying the original
        const fullData = Object.assign({}, compInstance.data);
        data.attributes[compName] = JSON.stringify(fullData);
      } catch (e) {
        console.warn(`⚠️ Could not stringify component ${compName}:`, e);
        // Fallback to getAttribute
        const comp = entity.getAttribute(compName);
        if (comp !== null && comp !== undefined) {
          data.attributes[compName] = typeof comp === 'object' ? JSON.stringify(comp) : comp;
        }
      }
    } else {
      // Component doesn't exist, try getAttribute as fallback
      const comp = entity.getAttribute(compName);
      if (comp !== null && comp !== undefined) {
        if (typeof comp === 'object') {
          try {
            data.attributes[compName] = JSON.stringify(comp);
          } catch (e) {
            console.warn(`⚠️ Could not stringify component ${compName}:`, e);
            data.attributes[compName] = comp;
          }
        } else if (comp === '' || comp === true) {
          // Empty string or true means component is present with defaults
          data.attributes[compName] = '';
        } else {
          data.attributes[compName] = comp;
        }
      }
    }
  });
  
  return data;
}

/**
 * Fallback serialization for objects without templates
 * @param {Element} entity - The entity to serialize
 * @returns {Object} Serialized data
 */
function serializeGenericArenaObject(entity) {
  const pos = entity.object3D.position;
  const rot = entity.object3D.rotation;
  const scale = entity.object3D.scale;
  
  const data = {
    id: entity.id,
    tagName: entity.tagName.toLowerCase(),
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: {
      x: THREE.MathUtils.radToDeg(rot.x),
      y: THREE.MathUtils.radToDeg(rot.y),
      z: THREE.MathUtils.radToDeg(rot.z)
    },
    scale: { x: scale.x, y: scale.y, z: scale.z },
    attributes: {}
  };
  
  // Try to get common geometry attributes
  const commonGeomAttrs = ['radius', 'detail', 'width', 'height', 'depth', 'segments'];
  commonGeomAttrs.forEach(attr => {
    const val = entity.getAttribute(attr);
    if (val !== null && val !== undefined) {
      data.attributes[attr] = val;
    }
  });
  
  // Common attributes
  COMMON_ATTRIBUTES.forEach(attr => {
    const val = entity.getAttribute(attr);
    if (val !== null && val !== undefined) {
      data.attributes[attr] = val;
    }
  });
  
  // Check for grab-surface
  if (entity.hasAttribute('grab-surface')) {
    data.attributes['grab-surface'] = '';
  }
  
  return data;
}

// ============================================================================
// DESERIALIZATION FUNCTIONS
// ============================================================================

/**
 * Create an arena object entity from serialized data
 * @param {Object} data - Serialized object data
 * @returns {Element|null} Created A-Frame entity or null if failed
 */
function createArenaObjectFromData(data) {
  if (!data || !data.tagName) {
    console.error('❌ createArenaObjectFromData: Invalid data', data);
    return null;
  }
  
  // console.log(`📥 DESERIALIZING ${data.tagName} (${data.id}):`, {
  //   position: data.position,
  //   rotation: data.rotation,
  //   scale: data.scale,
  //   attributeCount: data.attributes ? Object.keys(data.attributes).length : 0,
  //   attributes: data.attributes ? Object.keys(data.attributes) : [],
  //   FULL_DATA: data.attributes  // Show actual values received
  // });
  
  const entity = document.createElement(data.tagName);
  
  // Set ID
  if (data.id) {
    entity.setAttribute('id', data.id);
  }
  
  // Apply data to entity
  applyArenaObjectData(entity, data);
  
  // console.log(`✅ CREATED ${data.tagName} (${data.id}) with attributes:`, entity.components ? Object.keys(entity.components) : []);
  
  return entity;
}

/**
 * Apply serialized data to an existing entity
 * @param {Element} entity - The entity to update
 * @param {Object} data - Serialized object data
 */
function applyArenaObjectData(entity, data) {
  if (!entity || !data) {
    console.warn('⚠️ applyArenaObjectData: Invalid entity or data', entity, data);
    return;
  }
  
  // Apply transform - CRITICAL: Format as strings for A-Frame
  if (data.position) {
    const posStr = `${data.position.x} ${data.position.y} ${data.position.z}`;
    entity.setAttribute('position', posStr);
  }
  
  if (data.rotation) {
    entity.setAttribute('rotation', `${data.rotation.x} ${data.rotation.y} ${data.rotation.z}`);
  }
  
  if (data.scale) {
    entity.setAttribute('scale', `${data.scale.x} ${data.scale.y} ${data.scale.z}`);
  }
  
  // Apply attributes
  if (data.attributes) {
    for (const [key, value] of Object.entries(data.attributes)) {
      // Parse JSON strings back to objects for components
      let attrValue = value;
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
          attrValue = JSON.parse(value);
        } catch (e) {
          // If parsing fails, use as string
          attrValue = value;
        }
      }
      
      entity.setAttribute(key, attrValue);
    }
  }
}

/**
 * Validate that an entity matches its template
 * @param {Element} entity - Entity to validate
 * @returns {boolean} True if valid
 */
function validateArenaObject(entity) {
  if (!entity || !entity.object3D) {
    return false;
  }
  
  const tagName = entity.tagName.toLowerCase();
  const template = ARENA_OBJECT_TEMPLATES[tagName];
  
  if (!template) {
    console.warn(`⚠️ No template found for ${tagName}, but entity exists`);
    return true; // Allow unknown objects
  }
  
  // Check required components
  for (const comp of template.components) {
    if (comp === 'grab-surface' && !entity.hasAttribute('grab-surface')) {
      console.warn(`⚠️ Entity ${entity.id} missing required component: ${comp}`);
      return false;
    }
  }
  
  return true;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get the template for a given tag name
 * @param {string} tagName - The tag name (e.g., 'a-octahedron')
 * @returns {Object|null} Template object or null
 */
function getArenaObjectTemplate(tagName) {
  return ARENA_OBJECT_TEMPLATES[tagName.toLowerCase()] || null;
}

/**
 * Register a new arena object template
 * @param {string} tagName - The tag name
 * @param {Object} template - Template definition
 */
function registerArenaObjectTemplate(tagName, template) {
  ARENA_OBJECT_TEMPLATES[tagName.toLowerCase()] = template;
  console.log(`✅ Registered arena object template: ${tagName}`);
}

/**
 * Clone an arena object with a new ID
 * @param {Element} entity - Entity to clone
 * @param {string} newId - New ID for the clone
 * @returns {Element|null} Cloned entity or null
 */
function cloneArenaObject(entity, newId) {
  const data = serializeArenaObject(entity);
  if (!data) {
    return null;
  }
  
  data.id = newId;
  return createArenaObjectFromData(data);
}

// ============================================================================
// ARENA LAYOUT MANAGER
// ============================================================================

/**
 * Arena Layout Manager - Save/Load/Sync arena layouts
 */
const ArenaManager = {
  STORAGE_KEY_PREFIX: 'dodgevr_arena_',
  MANIFEST_URL: 'https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/arenas/manifest.json',
  ARENA_BASE_URL: 'https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/arenas/',
  MAX_PERSONAL_SLOTS: 10,
  
  currentArenaName: 'One',
  currentArenaSource: 'official', // 'official' or 'personal'
  officialArenas: [
    { id: 'zero', name: 'Zero', description: 'Empty arena for testing', file: 'zero.json' },
    { id: 'one', name: 'One', description: 'The classic DodgeVR arena', file: 'one.json' }
  ], // Initialize with default arenas immediately
  defaultArenaSnapshot: null, // Will be captured on init
  
  /**
   * Initialize the arena manager
   */
  init: async function() {
    console.log('🗺️ Initializing Arena Manager...');
    
    // Wait for scene to fully load before capturing default snapshot
    const scene = document.querySelector('a-scene');
    if (scene.hasLoaded) {
      this.captureDefaultSnapshot();
    } else {
      scene.addEventListener('loaded', () => {
        this.captureDefaultSnapshot();
      });
    }
    
    // Official arenas are already set above, but try to load from GitHub
    try {
      await this.loadOfficialManifest();
    } catch (e) {
      console.warn('⚠️ Could not load official arenas from GitHub, using defaults', e);
    }
    
    console.log(`✅ Arena Manager initialized with ${this.officialArenas.length} official arenas`);
  },
  
  captureDefaultSnapshot: function() {
    // Capture after a small delay to ensure all object3D positions are set
    setTimeout(() => {
      this.defaultArenaSnapshot = this.getCurrentLayout();
      this.defaultArenaSnapshot.metadata.name = 'One';
      this.defaultArenaSnapshot.metadata.description = 'The classic DodgeVR arena';
    }, 1000);
  },
  
  /**
   * Load official arenas manifest from GitHub
   */
  loadOfficialManifest: async function() {
    // For now, use hardcoded list until GitHub repo is set up
    // NOTE: Don't overwrite if already set - just use what's already there
    if (!this.officialArenas || this.officialArenas.length === 0) {
      this.officialArenas = [
        { id: 'zero', name: 'Zero', description: 'Empty arena for testing', file: 'zero.json' },
        { id: 'one', name: 'One', description: 'The classic DodgeVR arena', file: 'one.json' }
      ];
    }
    return this.officialArenas;
  },
  
  /**
   * Get current arena layout (all arena objects)
   */
  getCurrentLayout: function() {
    // Query for grab-surface objects (arena objects that can be interacted with)
    const arenaObjects = document.querySelectorAll('[grab-surface]');
    const objects = [];
    
    arenaObjects.forEach(entity => {
      // CRITICAL: Don't serialize goal rings or any children of goals
      // They are permanent fixtures and should not be part of custom arenas
      const hasGoalRing = entity.hasAttribute('goal-ring');
      const isChildOfGoal = entity.closest('[goal]') !== null;
      
      if (!hasGoalRing && !isChildOfGoal) {
        try {
          const data = serializeArenaObject(entity);
          objects.push(data);
        } catch (e) {
          console.warn('Failed to serialize arena object:', entity, e);
        }
      }
    });
    
    return {
      metadata: {
        name: this.currentArenaName,
        version: '1.0',
        created: new Date().toISOString(),
        objectCount: objects.length
      },
      objects: objects
    };
  },
  
  /**
   * Load arena layout (replace all current objects)
   */
  loadLayout: function(layoutData, arenaName) {
    console.log(`🗺️ Loading arena: ${arenaName}`);
    
    // Clear existing arena objects
    this.clearArena();
    
    // Get the scene element
    const scene = document.querySelector('a-scene');
    if (!scene) {
      console.error('❌ Cannot load arena: scene not found');
      return;
    }
    
    // Create new objects from layout
    if (layoutData.objects && Array.isArray(layoutData.objects)) {
      layoutData.objects.forEach(objData => {
        try {
          const entity = createArenaObjectFromData(objData);
          if (entity) {
            // CRITICAL: Add the entity to the scene!
            scene.appendChild(entity);
          }
        } catch (e) {
          console.error('Failed to create arena object:', objData, e);
        }
      });
    }
    
    this.currentArenaName = arenaName;
    console.log(`✅ Loaded arena "${arenaName}" with ${layoutData.objects?.length || 0} objects`);
    
    // Update menu display
    this.updateMenuDisplay();
  },
  
  /**
   * Clear all arena objects from scene
   */
  clearArena: function() {
    // Query for grab-surface objects (arena objects that can be interacted with)
    const arenaObjects = document.querySelectorAll('[grab-surface]');
    let removedCount = 0;
    
    console.log(`🗑️ Clearing ${arenaObjects.length} arena objects...`);
    
    arenaObjects.forEach(entity => {
      // CRITICAL: Don't remove goal rings or any children of goals
      // Check if this entity has goal-ring attribute or is a child of a goal
      const hasGoalRing = entity.hasAttribute('goal-ring');
      const isChildOfGoal = entity.closest('[goal]') !== null;
      
      if (!hasGoalRing && !isChildOfGoal && entity.parentNode) {
        // A-Frame will automatically call the remove() lifecycle method
        // of all components when removeChild is called, which will clean up physics bodies
        entity.parentNode.removeChild(entity);
        removedCount++;
      }
    });
    
    console.log(`🗑️ Cleared ${removedCount} arena objects (preserved goal rings)`);
    
    // CRITICAL: Verify physics bodies were actually removed
    // Count physics bodies in the world
    if (typeof world !== 'undefined') {
      const bodyCount = world.bodies.length;
      console.log(`🔍 Physics world now has ${bodyCount} bodies`);
    }
  },
  
  /**
   * Save current layout to personal slot
   */
  saveToPersonalSlot: function(slotNumber, name) {
    if (slotNumber < 1 || slotNumber > this.MAX_PERSONAL_SLOTS) {
      console.error('Invalid slot number:', slotNumber);
      return false;
    }
    
    const layout = this.getCurrentLayout();
    layout.metadata.name = name;
    
    const key = `${this.STORAGE_KEY_PREFIX}personal_${slotNumber}`;
    try {
      localStorage.setItem(key, JSON.stringify(layout));
      console.log(`✅ Saved arena "${name}" to slot ${slotNumber}`);
      return true;
    } catch (e) {
      console.error('Failed to save arena:', e);
      return false;
    }
  },
  
  /**
   * Load from personal slot
   */
  loadFromPersonalSlot: function(slotNumber) {
    const key = `${this.STORAGE_KEY_PREFIX}personal_${slotNumber}`;
    const data = localStorage.getItem(key);
    
    if (!data) {
      console.warn('No arena in slot', slotNumber);
      return null;
    }
    
    try {
      const layout = JSON.parse(data);
      this.loadLayout(layout, layout.metadata.name);
      this.currentArenaSource = 'personal';
      return layout;
    } catch (e) {
      console.error('Failed to load arena from slot:', e);
      return null;
    }
  },
  
  /**
   * Get list of personal arenas
   */
  getPersonalArenas: function() {
    const arenas = [];
    
    for (let i = 1; i <= this.MAX_PERSONAL_SLOTS; i++) {
      const key = `${this.STORAGE_KEY_PREFIX}personal_${i}`;
      const data = localStorage.getItem(key);
      
      if (data) {
        try {
          const layout = JSON.parse(data);
          arenas.push({
            slot: i,
            name: layout.metadata.name,
            created: layout.metadata.created,
            objectCount: layout.metadata.objectCount
          });
        } catch (e) {
          console.warn('Corrupted arena data in slot', i);
        }
      } else {
        arenas.push({
          slot: i,
          name: null,
          empty: true
        });
      }
    }
    
    return arenas;
  },
  
  /**
   * Delete personal arena from slot
   */
  deletePersonalArena: function(slotNumber) {
    const key = `${this.STORAGE_KEY_PREFIX}personal_${slotNumber}`;
    localStorage.removeItem(key);
    console.log(`🗑️ Deleted arena from slot ${slotNumber}`);
  },
  
  /**
   * Load official arena
   */
  loadOfficialArena: async function(arenaId) {
    console.log(`🌐 Loading official arena: ${arenaId}`);
    
    // For now, load from embedded defaults
    // Later, this will fetch from GitHub
    if (arenaId === 'zero') {
      // Empty arena - just clear everything
      const emptyLayout = {
        metadata: {
          name: 'Zero',
          version: '1.0',
          created: new Date().toISOString(),
          objectCount: 0
        },
        objects: []
      };
      this.loadLayout(emptyLayout, 'Zero');
      this.currentArenaSource = 'official';
      return true;
    } else if (arenaId === 'one') {
      const defaultLayout = this.getDefaultArenaLayout();
      this.loadLayout(defaultLayout, 'One');
      this.currentArenaSource = 'official';
      return true;
    }
    
    console.warn('Arena not found:', arenaId);
    return false;
  },
  
  /**
   * Get default arena layout (embedded)
   */
  getDefaultArenaLayout: function() {
    // Return the snapshot captured at initialization
    if (this.defaultArenaSnapshot) {
      console.log(`📸 Returning default arena snapshot: ${this.defaultArenaSnapshot.metadata.objectCount} objects`);
      return this.defaultArenaSnapshot;
    }
    
    // Fallback: try to get current layout (shouldn't happen if init was called)
    console.warn('⚠️ Default arena snapshot not available, using current layout');
    const currentLayout = this.getCurrentLayout();
    currentLayout.metadata.name = 'One';
    currentLayout.metadata.description = 'The classic DodgeVR arena';
    return currentLayout;
  },
  
  /**
   * Export current layout to file
   */
  exportToFile: function(filename) {
    const layout = this.getCurrentLayout();
    const jsonString = JSON.stringify(layout, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.arena.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log(`📥 Exported arena to ${filename}.arena.json`);
  },
  
  /**
   * Import layout from file
   */
  importFromFile: function(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const layout = JSON.parse(e.target.result);
        callback(layout);
      } catch (err) {
        console.error('Failed to parse arena file:', err);
        callback(null);
      }
    };
    reader.readAsText(file);
  },
  
  /**
   * Update menu display with current arena name
   */
  updateMenuDisplay: function() {
    const menuText = document.querySelector('#menu-arena-name');
    if (menuText) {
      menuText.setAttribute('text', 'value', `Arena: ${this.currentArenaName}`);
    }
  },
  
  /**
   * Broadcast arena load to all clients (multiplayer)
   */
  broadcastArenaLoad: function(layoutData) {
    if (typeof connections !== 'undefined' && typeof isHost !== 'undefined' && isHost) {
      const message = {
        type: 'arena-load',
        arenaName: this.currentArenaName,
        arenaSource: this.currentArenaSource,
        arenaData: layoutData
      };
      
      connections.forEach((conn, playerId) => {
        if (conn && conn.open) {
          conn.send(message);
          console.log(`📡 Sent arena to client: ${playerId}`);
        }
      });
    }
  },
  
  /**
   * Handle arena load message from host (client side)
   */
  handleArenaLoadMessage: function(data) {
    console.log(`📡 Received arena from host: ${data.arenaName}`);
    this.loadLayout(data.arenaData, data.arenaName);
    this.currentArenaSource = data.arenaSource;
  }
};

// ============================================================================
// EXPORTS (for debugging/inspection)
// ============================================================================

console.log('✅ Arena Templates System Loaded');
console.log(`   Registered templates: ${Object.keys(ARENA_OBJECT_TEMPLATES).join(', ')}`);
console.log(`   Official arenas: ${ArenaManager.officialArenas.map(a => a.name).join(', ')}`);
