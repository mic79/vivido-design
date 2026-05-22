/* VRdrift — Orion Drift–inspired tuning (approximate, not official). */
window.VRDRIFT = {
  /* Locomotion physics sphere (Cannon) — not the visible game ball */
  BODY_BALL_RADIUS: 0.24,
  /* Orion arena game ball — 0.5 m diameter; light mass for snappy palm response */
  GAME_BALL_RADIUS: 0.25,
  GAME_BALL_MASS: 3,
  GAME_BALL_MAX_SPEED: 5,
  GAME_BALL_LINEAR_DAMPING: 0.03,
  GAME_BALL_ANGULAR_DAMPING: 0.08,
  GAME_BALL_FRICTION: 0.45,
  GAME_BALL_RESTITUTION: 0.12,
  /** Post-physics: blend palm Cannon velocity into game ball while touching */
  PALM_GAME_BALL_VELOCITY_BLEND: 14,
  PALM_GAME_BALL_MAX_DV: 1.4,
  /** Pre-physics palm chase while rolling on game ball (full 3D, not floor-tangent) */
  PALM_GAME_BALL_CHASE_GAIN: 28,
  /** Airborne palm follow — velocity only (never teleport through dynamic bodies) */
  PALM_AIR_CHASE_GAIN: 22,
  PLAYER_BALL_FRICTION: 0.52,
  PLAYER_BALL_RESTITUTION: 0.08,
  PALM_PHYSICS_RADIUS: 0.085,
  /** Dynamic palm collider spheres (m) — roll on contact; replace kinematic palm boxes */
  PALM_SPHERE_RADIUS: 0.05,
  PALM_SPHERE_MASS: 1.5,
  /** Soft hand follow while rolling on surfaces (not a launch spring) */
  PALM_HAND_CHASE_GAIN: 4.5,
  PALM_CHASE_MAX_SPEED: 2.2,
  /**
   * While palm Cannon body touches a surface: rig moves opposite tracked controller
   * palm delta (1 = push hand down 1 cm → rig up 1 cm). Not an impulse gain.
   */
  PALM_CONTACT_COUPLING: 1,
  PALM_CONTACT_MAX_STEP: 0.055,
  PALM_CONTACT_MIN_INTO: 0.0004,
  /** Open-hand floor: hand drive per frame to blend coupling (never snap velocity). */
  PALM_FLOOR_SKATE_MIN_TANGENT: 0.018,
  /** Open-hand floor: min push into floor per frame (fast slap). */
  PALM_FLOOR_SKATE_MIN_INTO: 0.003,
  /** Open-hand floor: min coupling step before swipe adds velocity (not passive coast). */
  PALM_FLOOR_SKATE_MIN_DRIVE: 0.02,
  /** Target coupling speed cap (m/s) while swiping open-hand. */
  PALM_FLOOR_SKATE_MAX_DV: 0.55,
  /** Per-frame blend toward swipe direction (0.15 = gradual turn, 0.35 = snappier). */
  PALM_FLOOR_SKATE_STEER_BLEND: 0.22,
  /** Looser gap when Cannon palm already touches drift-floor (ramps). */
  PALM_STATIC_FLOOR_GAP: 0.028,
  /** Geometric wall touch — tight, matches floor touch (not a 2.8 cm air gap). */
  PALM_WALL_TOUCH_GAP: 0.008,
  /** Raise rig when tracked palms sink below Cannon palm on floor (position only, no impulse). */
  PALM_RIG_SUPPORT_TOLERANCE: 0.018,
  PALM_RIG_SUPPORT_MAX_STEP: 0.028,
  PALM_RIG_SUPPORT_BLEND: 0.22,
  /** Pull rig back when tracked palms push past Cannon palm into a wall. */
  PALM_RIG_WALL_TOLERANCE: 0.01,
  PALM_RIG_WALL_MAX_STEP: 0.055,
  PALM_RIG_WALL_BLEND: 0.68,
  /** Open-hand wall: inverse palm delta → body velocity (same model as floor skate). */
  PALM_WALL_COUPLE: 1,
  PALM_WALL_MAX_STEP: 0.085,
  PALM_WALL_SKATE_STEER_BLEND: 1,
  PALM_WALL_SKATE_MAX_DV: 9,
  /** Hand speed (m/s) above which solid-contact position fix is skipped — push uses velocity. */
  PALM_WALL_SOLID_MAX_HAND_SPEED: 0.35,
  PALM_WALL_COAST_SPEED: 0.32,
  MAX_COLLISION_CORRECTION: 0.045,
  /** Only snap/support floor within this height above the body center (prevents ramp face teleports). */
  MAX_FLOOR_SUPPORT_REACH: 0.55,
  /** Max floor lift per frame for large gaps only (m). */
  MAX_FLOOR_CORRECTION: 0.08,
  /** Snap to deck when gap is below this (stops micro-bounce). */
  FLOOR_SNAP_TOLERANCE: 0.12,
  /** Surface normal.y below this = incline (ramps); lower swipe threshold. */
  PALM_FLOOR_SKATE_INCLINE_NY: 0.92,
  PALM_FLOOR_SKATE_INCLINE_TANGENT: 0.012,
  PALM_FLOOR_SKATE_COAST_SPEED: 0.35,
  PALM_FLOOR_TOUCH_MAX_GAP: 0.012,
  /** Slightly looser than touch — floor grip can latch on squeeze */
  PALM_FLOOR_GRIP_MAX_GAP: 0.022,
  /* Flat palm box half-extents (local: X=width, Y=thin, Z=fingers) */
  /* Palm collider on mixamo hand bone (local offsets, meters) */
  PALM_COLLIDER_OFFSET_X: 0,
  PALM_COLLIDER_OFFSET_Y: 0,
  PALM_COLLIDER_OFFSET_Z: 0.02,
  /* Degrees — palm box on #left-palm (controller-local), Quest grip */
  PALM_LOCAL_ROT_X: -90,
  PALM_LOCAL_ROT_Y: 0,
  PALM_LOCAL_ROT_Z: 0,
  /* Extra meters past knuckle center toward fingertips */
  PALM_BONE_CENTER_ALONG_FINGERS: 0.02,
  /* Mirrored fixed tilt on hand bone (deg); roll uses same value × ±1 per side */
  PALM_BONE_LOCAL_ROT_X: -90,
  PALM_BONE_LOCAL_ROT_Y: 0,
  PALM_BONE_LOCAL_ROT_Z: 90,
  /* +90° tip (local Z, along fingers) — lays box flat on the palm */
  PALM_BONE_TIP_DEG: 90,
  PALM_BONE_TIP_AXIS: 'z',
  PALM_BONE_ROLL_DEG: -16,
  PALM_PHYSICS_HALF_WIDTH: 0.07,
  PALM_PHYSICS_HALF_THICK: 0.014,
  PALM_PHYSICS_HALF_LENGTH: 0.052,
  /* Fallback when avatar bone not ready — controller palm child */
  PALM_ANCHOR_Y: -0.03,
  PALM_ANCHOR_Z: -0.07,
  SHOW_BODY_COLLISION_DEBUG: false,
  /** Wireframe 5 cm spheres at Cannon palm body positions */
  SHOW_PALM_SPHERE_DEBUG: true,
  SHOW_HAND_COLLISION_DEBUG: false,
  PALM_BALL_FRICTION: 0.62,
  PALM_BALL_RESTITUTION: 0,
  PALM_MAX_DRIVE_SPEED: 1.5,
  PALM_SCOOP_LIFT_BIAS: 0.12,
  CHEST_TRAP_RADIUS: 0.22,
  CHEST_TRAP_OFFSET_Y: -0.42,
  CHEST_TRAP_BACK_OFFSET: 0.12,

  PALM_RADIUS: 0.075,
  /** Max gap (m) between palm sphere surface and mesh — not air-range proximity */
  PALM_CONTACT_DIST: 0.008,
  PALM_TOUCH_MAX_GAP: 0.008,
  /* Game ball: palm must be within this gap (m) of sphere surface — no long-range push */
  GAME_BALL_TOUCH_MAX_GAP: 0.035,
  GAME_BALL_PUSH_MIN_GAP: -0.008,
  GRIP_CONTACT_DIST: 0.58,
  GRIP_PROBE_EXTRA: 0.12,

  PLAYER_COLLISION_RADIUS: 0.24,
  HEAD_COLLISION_RADIUS: 0.2,
  BODY_PHYSICS_OFFSET: -0.76,
  /** Horizontal offset: body center behind headset (+Z in head space, Y flattened) */
  /** Torso root behind headset (BattleVR uses 0.15) — not the old 0.28 overshoot */
  AVATAR_TORSO_BACK_OFFSET: 0.15,
  BODY_BACK_OFFSET: 0.15,
  /** Rig Y offset (m) — camera + controllers vs physics ball; menu adjusts ±10 cm */
  RIG_Y_OFFSET: 0,
  RIG_HEIGHT_STEP: 0.1,
  RIG_Y_MIN: -2,
  RIG_Y_MAX: 1,

  MASS: 55,
  BALL_LINEAR_DAMPING: 0.06,
  BALL_ANGULAR_DAMPING: 0.22,
  IDLE_LINEAR_SPEED: 0.14,
  IDLE_SPIN_STOP: 0.35,
  GRAVITY: -3.2,
  LINEAR_DAMPING: 0.992,
  AIR_DAMPING: 0.998,
  MIN_VELOCITY: 0.02,
  MAX_SPEED: 11,
  THRUSTER_FORCE: 2.4,
  ROTATION_SPEED: 2.2,
  BRAKE_FACTOR: 0.86,
  /** Grip + floor: brake until slow; full palm coupling only below crawl speed. */
  FLOOR_GRIP_BRAKE_REF_SPEED: 6,
  FLOOR_GRIP_MAX_DECEL: 16,
  FLOOR_GRIP_FULL_COUPLE_SPEED: 1.35,
  FLOOR_GRIP_ENGAGE_RATE: 2.5,
  FLOOR_GRIP_MOVE_GAIN: 1.15,
  FLOOR_GRIP_MAX_STEP: 0.12,
  FLOOR_GRIP_RELEASE_DIST: 0.1,
  /** Cap per-frame tracked palm delta (stops IK/physics spikes flinging the body). */
  PALM_DELTA_MAX: 0.07,

  ARM_PUSH_GAIN: 0,
  ARM_PUSH_MIN_HAND_SPEED: 0.12,

  SKATE_GAIN: 4.5,
  PALM_SKATE_GAIN: 1.12,
  PALM_SKATE_MIN_TANGENT: 0.04,
  PALM_SKATE_MIN_HAND_SPEED: 0.18,
  PALM_SKATE_MAX_TANGENT: 2.4,
  PUSH_GAIN: 1.35,
  CARVE_GAIN: 1.1,
  CARVE_TURN_GAIN: 1.8,
  WALL_JUMP_MIN_SPEED: 2.5,
  WALL_JUMP_GAIN: 0.85,
  GRIP_ATTACH_STRENGTH: 48,
  GRIP_ANCHOR_STIFFNESS: 22,
  GRIP_MAX_CORR: 0.045,
  GRIP_MAX_SPEED: 3.2,
  GRIP_RELEASE_DIST: 0.55,
  GRIP_GRAVITY_CANCEL: 0.94,
  MAX_ANGULAR_SPEED: 14,
  GROUNDED_NORMAL_Y: 0.45,

  HAPTIC_HIT_INTENSITY: 0.45,
  HAPTIC_HIT_MS: 42,
  HAPTIC_GRIP_INTENSITY: 0.52,
  HAPTIC_GRIP_MS: 48,
  HAPTIC_SKATE_INTENSITY: 0.3,
  HAPTIC_SKATE_MS: 30,
  HAPTIC_SKATE_INTERVAL_MS: 48,
  HAPTIC_SKATE_MIN_TANGENT: 0.2,
  HAPTIC_SKATE_MAX_TANGENT: 2.4,

  PHYSICS_HZ: 90,
  PHYSICS_SOLVER_ITERATIONS: 24,
  PHYSICS_MAX_SUBSTEPS: 6,
  CONTACT_EQUATION_STIFFNESS: 1e7,
  CONTACT_EQUATION_RELAXATION: 3,
  SYNC_HZ: 20,
  PEER_PREFIX: 'vrdrift',
  MAX_LOBBIES: 8,
  PLAYER_COLORS: ['#44aaff', '#ff6644', '#66ddaa', '#dd66ff', '#ffcc44', '#88eeff', '#ff88cc', '#aaff66']
};
