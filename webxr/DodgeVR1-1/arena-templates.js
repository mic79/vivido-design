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
const COMMON_ATTRIBUTES = ['color', 'wireframe'];

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
        console.log(`🔍 Serializing component "${compName}":`, fullData);
        console.log(`   ✅ Stringified to:`, data.attributes[compName]);
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
        console.log(`🔍 Serializing component "${compName}" (fallback):`, comp, typeof comp);
        if (typeof comp === 'object') {
          try {
            data.attributes[compName] = JSON.stringify(comp);
            console.log(`   ✅ Stringified to:`, data.attributes[compName]);
          } catch (e) {
            console.warn(`⚠️ Could not stringify component ${compName}:`, e);
            data.attributes[compName] = comp;
          }
        } else if (comp === '' || comp === true) {
          // Empty string or true means component is present with defaults
          data.attributes[compName] = '';
          console.log(`   ✅ Set to empty string (component present with defaults)`);
        } else {
          data.attributes[compName] = comp;
          console.log(`   ✅ Set directly to:`, comp);
        }
      } else {
        console.log(`   ⚠️ Component "${compName}" not found on entity`);
      }
    }
  });
  
  // DIAGNOSTIC LOGGING
  console.log(`📦 SERIALIZED ${tagName} (${entity.id}):`, {
    position: data.position,
    rotation: data.rotation,
    scale: data.scale,
    attributeCount: Object.keys(data.attributes).length,
    attributes: Object.keys(data.attributes),
    FULL_DATA: data.attributes  // Show actual values
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
  
  console.log(`📥 DESERIALIZING ${data.tagName} (${data.id}):`, {
    position: data.position,
    rotation: data.rotation,
    scale: data.scale,
    attributeCount: data.attributes ? Object.keys(data.attributes).length : 0,
    attributes: data.attributes ? Object.keys(data.attributes) : [],
    FULL_DATA: data.attributes  // Show actual values received
  });
  
  const entity = document.createElement(data.tagName);
  
  // Set ID
  if (data.id) {
    entity.setAttribute('id', data.id);
  }
  
  // Apply data to entity
  applyArenaObjectData(entity, data);
  
  console.log(`✅ CREATED ${data.tagName} (${data.id}) with attributes:`, entity.components ? Object.keys(entity.components) : []);
  
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
  
  // Apply transform
  if (data.position) {
    entity.setAttribute('position', data.position);
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
          console.log(`🔍 Deserializing attribute "${key}":`, value, '→ Parsed to:', attrValue);
        } catch (e) {
          // If parsing fails, use as string
          attrValue = value;
          console.log(`⚠️ Could not parse "${key}" JSON, using as string:`, value);
        }
      } else {
        console.log(`🔍 Deserializing attribute "${key}":`, value);
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
// EXPORTS (for debugging/inspection)
// ============================================================================

console.log('✅ Arena Templates System Loaded');
console.log(`   Registered templates: ${Object.keys(ARENA_OBJECT_TEMPLATES).join(', ')}`);
