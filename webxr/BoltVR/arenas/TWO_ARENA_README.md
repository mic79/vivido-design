# Arena "Two" - Stress Test Arena

## Overview
"Two" is a densely populated stress test arena designed to push the limits of Meta Quest 3 performance.

## Stats
- **Total Octahedrons:** 120
- **Octahedron Radius:** 3 meters each
- **Minimum Spacing:** 2 meters between shapes
- **Layout:** Evenly distributed grid pattern
- **Symmetry:** Perfectly symmetric across Z=0 (Red/Blue sides mirror each other)

## Layout Design

### Blue Side (Z > 0):
- **Z = 35m:** 3 rows × 5 columns = 15 octahedrons
- **Z = 28m:** 2 rows × 8 columns = 16 octahedrons (offset grid)
- **Z = 21m:** 3 rows × 8 columns = 24 octahedrons (offset grid)
- **Z = 14m:** 2 rows × 7 columns = 14 octahedrons (sparse)
- **Total Blue Side:** 69 octahedrons

### Red Side (Z < 0):
- **Z = -35m:** 3 rows × 5 columns = 15 octahedrons
- **Z = -28m:** 2 rows × 4 columns = 8 octahedrons (offset grid)
- **Z = -21m:** 3 rows × 8 columns = 24 octahedrons (offset grid)
- **Z = -14m:** 2 rows × 7 columns = 14 octahedrons (sparse)
- **Total Red Side:** 61 octahedrons

## Arena Dimensions
- **Width:** 30m (-15 to +15 on X axis)
- **Height:** 20m (-10 to +10 on Y axis)
- **Length:** 80m (-40 to +40 on Z axis)
- **Goals:** At Z = ±50m (outside main play area)

## Grid Pattern

### Primary Grid (Z = 35, 21, -35, -21):
```
X positions: -12, -6, 0, 6, 12 (6m spacing)
Y positions: -8, 0, 8 (8m spacing)
```

### Offset Grid (Z = 28, -28, -21):
```
X positions: -9, -3, 3, 9 (6m spacing, offset by 3m)
Y positions: -4, 4 (8m spacing, offset by 4m)
```

### Sparse Grid (Z = 14, -14):
```
X positions: -12, -9, -6, 0, 6, 9, 12
Y positions: -8, 0, 8
```

## Performance Expectations

### Estimated Rendering Cost:

| Component | Count | Draw Calls | Triangles | GPU Cost |
|-----------|-------|------------|-----------|----------|
| **Octahedrons** | 120 | 120 | ~960 | Medium |
| **Point Lights** | 15 | - | - | **High** |
| **Standard Shader** | 120 | - | - | **Very High** |
| **Total** | - | **~135** | **~15,300** | - |

### Expected FPS on Meta Quest 3:

| View Angle | Estimated FPS | Reason |
|------------|---------------|---------|
| **Looking at center** | 60-72 FPS | ~40 objects visible |
| **Looking at goal** | 40-60 FPS | ~80 objects visible |
| **Looking across arena** | 30-45 FPS | 100+ objects visible |

### Key Performance Bottlenecks:

1. 🔴 **Point Lights (15 total)**
   - Dynamic lighting calculations per object
   - Multi-pass rendering
   - **Impact:** -30 to -40 FPS

2. 🔴 **Standard Shader (120 materials)**
   - Metalness + roughness calculations
   - Per-pixel lighting
   - **Impact:** -15 to -20 FPS

3. 🟡 **Fill Rate**
   - 120 overlapping objects on screen
   - Overdraw from transparency
   - **Impact:** -10 to -15 FPS

4. ✅ **Draw Calls (120)**
   - Within Quest 3 budget (< 200)
   - Minimal CPU overhead
   - **Impact:** < -5 FPS

5. ✅ **Triangle Count (~15,300)**
   - Well under Quest 3 budget (< 100,000)
   - Negligible GPU cost
   - **Impact:** < -2 FPS

## How to Load

1. Open the game on Meta Quest 3
2. Press **X button** to open menu
3. Select **ARENAS** tab
4. Choose **Official Arenas**
5. Select **"Two"**
6. Wait for arena to load (~2-3 seconds)

## Comparison with "One" Arena

| Metric | "One" Arena | "Two" Arena | Difference |
|--------|-------------|-------------|------------|
| **Octahedrons** | 17 | 120 | +103 (+606%) |
| **Draw Calls** | ~90 | ~135 | +45 (+50%) |
| **Triangles** | ~14,400 | ~15,300 | +900 (+6%) |
| **Expected FPS** | 60-90 | 30-60 | -30 to -45 |

## Purpose

This arena serves as a **stress test** to:
1. Measure worst-case performance on Meta Quest 3
2. Identify GPU vs CPU bottlenecks
3. Test draw call batching
4. Evaluate occlusion culling effectiveness
5. Validate collision detection performance at scale

## Optimization Opportunities

If performance is poor in "Two" arena, try:

1. **Reduce Point Lights** (biggest impact)
   - From 15 → 4 lights
   - Expected gain: +30-40 FPS

2. **Switch to Flat Shader**
   - Remove metalness/roughness
   - Expected gain: +15-20 FPS

3. **Enable Instancing**
   - Merge identical octahedrons
   - Expected gain: +10-15 FPS

4. **Add Distance Culling**
   - Hide objects > 30m away
   - Expected gain: +5-10 FPS

5. **Reduce Geometry**
   - Lower octahedron detail level
   - Expected gain: +2-5 FPS

## Technical Notes

- All octahedrons use standard material with metalness (0.7) and roughness (0.3)
- No edge rendering (already removed for performance)
- Symmetrical design ensures balanced gameplay
- 2m minimum spacing prevents collision overlaps
- Physics uses analytical collision (not BVH)
- Compatible with level editor for further modifications

## Testing Checklist

When testing "Two" arena, measure:
- [ ] FPS when looking at center
- [ ] FPS when looking at Blue goal
- [ ] FPS when looking at Red goal
- [ ] FPS when looking across full arena
- [ ] Collision detection responsiveness
- [ ] Ball physics stability
- [ ] Bot AI performance
- [ ] Loading time
- [ ] Memory usage

