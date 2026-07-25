/**
 * Godot WebXR helpers for Chrome PCVR / Quest Browser.
 *
 * Layer/view-count fixes live in web/patch_webxr_export.py (applied to docs/index.js).
 *
 * Thumb capacitive touch: stock Godot WebXR only copies gamepad.buttons[i].value
 * into the engine — NOT buttons[i].touched. body-rigged2 reads .touched on
 * buttons[2..6] (stick, A/X, B/Y, thumbrest). Expose the same for GDScript.
 */
(function () {
  console.info("[WebXR] Stereo path: no glow/post-FX; patched getLayer + get_view_count.");

  window.__bodyIkThumbTouch = function (handedness) {
    try {
      var session = typeof GodotWebXR !== "undefined" ? GodotWebXR.session : null;
      if (!session || !session.inputSources) {
        return 0;
      }
      for (var i = 0; i < session.inputSources.length; i++) {
        var src = session.inputSources[i];
        if (!src || src.handedness !== handedness) {
          continue;
        }
        var gp = src.gamepad;
        if (!gp || !gp.buttons) {
          continue;
        }
        // body-rigged2: capacitive surfaces on buttons[2..6]
        for (var b = 2; b <= 6; b++) {
          var btn = gp.buttons[b];
          if (btn && btn.touched) {
            return 1;
          }
        }
        // Quest 3 / Touch Plus: extra thumbrest / pad indices
        for (var b2 = 7; b2 < gp.buttons.length; b2++) {
          var btn2 = gp.buttons[b2];
          if (btn2 && btn2.touched) {
            return 1;
          }
        }
      }
    } catch (err) {
      /* ignore */
    }
    return 0;
  };
})();
