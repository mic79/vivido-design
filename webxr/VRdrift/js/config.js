/* VRdrift — Orion Drift–inspired tuning (approximate, not official). */
window.VRDRIFT = {
  /* Locomotion physics sphere (Cannon) — not the visible game ball */
  BODY_BALL_RADIUS: 0.24,
  /* Orion arena game ball — 0.5 m diameter (halved), same mass for heavy feel */
  GAME_BALL_RADIUS: 0.25,
  GAME_BALL_MASS: 9,
  GAME_BALL_MAX_SPEED: 2.6,
  GAME_BALL_LINEAR_DAMPING: 0.16,
  GAME_BALL_ANGULAR_DAMPING: 0.24,
  GAME_BALL_FRICTION: 0.38,
  GAME_BALL_RESTITUTION: 0.22,
  PLAYER_BALL_FRICTION: 0.52,
  PLAYER_BALL_RESTITUTION: 0.08,
  PALM_PHYSICS_RADIUS: 0.085,
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
  SHOW_HAND_COLLISION_DEBUG: true,
  PALM_BALL_FRICTION: 0.55,
  PALM_BALL_RESTITUTION: 0.06,
  PALM_MAX_DRIVE_SPEED: 1.5,
  PALM_SCOOP_LIFT_BIAS: 0.12,
  CHEST_TRAP_RADIUS: 0.22,
  CHEST_TRAP_OFFSET_Y: -0.42,
  CHEST_TRAP_BACK_OFFSET: 0.12,

  PALM_RADIUS: 0.075,
  PALM_CONTACT_DIST: 0.22,
  /* Game ball: palm must be within this gap (m) of sphere surface — no long-range push */
  GAME_BALL_TOUCH_MAX_GAP: 0.035,
  GAME_BALL_PUSH_MIN_GAP: -0.008,
  GRIP_CONTACT_DIST: 0.58,
  GRIP_PROBE_EXTRA: 0.12,

  PLAYER_COLLISION_RADIUS: 0.24,
  HEAD_COLLISION_RADIUS: 0.2,
  MAX_COLLISION_CORRECTION: 0.08,
  BODY_PHYSICS_OFFSET: -0.76,
  /** Horizontal offset: body center behind headset (+Z in head space, Y flattened) */
  /** Torso root behind headset (BattleVR uses 0.15) — not the old 0.28 overshoot */
  AVATAR_TORSO_BACK_OFFSET: 0.15,
  BODY_BACK_OFFSET: 0.15,
  /** BattleVR: rig stays at 0 — avatar IK uses camera world pose directly */
  RIG_Y_OFFSET: 0,

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
  FLOOR_GRIP_BRAKE_FACTOR: 0.55,
  FLOOR_GRIP_INITIAL_SLOW: 0.4,
  FLOOR_GRIP_RELEASE_DIST: 0.1,

  ARM_PUSH_GAIN: 12,
  ARM_PUSH_MIN_HAND_SPEED: 0.06,

  SKATE_GAIN: 4.5,
  PUSH_GAIN: 1.35,
  CARVE_GAIN: 1.1,
  CARVE_TURN_GAIN: 1.8,
  WALL_JUMP_MIN_SPEED: 2.5,
  WALL_JUMP_GAIN: 0.85,
  GRIP_ATTACH_STRENGTH: 48,
  GRIP_ANCHOR_STIFFNESS: 26,
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
  SYNC_HZ: 20,
  PEER_PREFIX: 'vrdrift',
  MAX_LOBBIES: 8,
  PLAYER_COLORS: ['#44aaff', '#ff6644', '#66ddaa', '#dd66ff', '#ffcc44', '#88eeff', '#ff88cc', '#aaff66']
};
