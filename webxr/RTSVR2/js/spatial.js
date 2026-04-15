// ========================================
// RTSVR2 — Spatial Hash Grid
// O(1) neighbor queries for units/buildings
// ========================================

import { SPATIAL_CELL_SIZE, MAP_HALF } from './config.js';

export class SpatialGrid {
  constructor(cellSize = SPATIAL_CELL_SIZE) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  _key(cx, cz) {
    return (cx + 100) * 1000 + (cz + 100); // Numeric key for speed
  }

  clear() {
    this.cells.clear();
  }

  insert(entity) {
    const cx = Math.floor(entity.x / this.cellSize);
    const cz = Math.floor(entity.z / this.cellSize);
    const key = this._key(cx, cz);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = [];
      this.cells.set(key, cell);
    }
    cell.push(entity);
  }

  queryRadius(x, z, radius) {
    const results = [];
    const r2 = radius * radius;
    const minCX = Math.floor((x - radius) / this.cellSize);
    const maxCX = Math.floor((x + radius) / this.cellSize);
    const minCZ = Math.floor((z - radius) / this.cellSize);
    const maxCZ = Math.floor((z + radius) / this.cellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const cell = this.cells.get(this._key(cx, cz));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          const dx = e.x - x;
          const dz = e.z - z;
          if (dx * dx + dz * dz <= r2) {
            results.push(e);
          }
        }
      }
    }
    return results;
  }

  queryRadiusFiltered(x, z, radius, filterFn) {
    const results = [];
    const r2 = radius * radius;
    const minCX = Math.floor((x - radius) / this.cellSize);
    const maxCX = Math.floor((x + radius) / this.cellSize);
    const minCZ = Math.floor((z - radius) / this.cellSize);
    const maxCZ = Math.floor((z + radius) / this.cellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const cell = this.cells.get(this._key(cx, cz));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          const dx = e.x - x;
          const dz = e.z - z;
          if (dx * dx + dz * dz <= r2 && filterFn(e)) {
            results.push(e);
          }
        }
      }
    }
    return results;
  }

  findNearest(x, z, radius, filterFn) {
    let nearest = null;
    let minDist = radius * radius;
    const minCX = Math.floor((x - radius) / this.cellSize);
    const maxCX = Math.floor((x + radius) / this.cellSize);
    const minCZ = Math.floor((z - radius) / this.cellSize);
    const maxCZ = Math.floor((z + radius) / this.cellSize);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const cell = this.cells.get(this._key(cx, cz));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          const dx = e.x - x;
          const dz = e.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < minDist && (!filterFn || filterFn(e))) {
            minDist = d2;
            nearest = e;
          }
        }
      }
    }
    return nearest;
  }
}

// Singleton instances
export const unitGrid = new SpatialGrid();
export const buildingGrid = new SpatialGrid();
