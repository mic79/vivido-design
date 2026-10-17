/* Early boot: applies the saved theme before first paint and syncs the Android keyboard overlap.
 * Extracted from index.html (was two inline <script> blocks) so a strict Content-Security-Policy is possible. */
    (function(){
      var t=localStorage.getItem('valu_theme');
      if(t==='dark'||t==='light'){
        document.documentElement.setAttribute('data-theme',t);
        var m=document.querySelector('meta[name="theme-color"]');
        if(m)m.setAttribute('content',t==='dark'?'#211f1d':'#729c9c');
      }
    })();
  
    (function () {
      if (!/Android/i.test(navigator.userAgent) || !window.visualViewport) return;
      function syncBottomOverlap() {
        var vv = visualViewport;
        var layoutH = window.innerHeight;
        var visibleBottom = vv.height + vv.offsetTop;
        var raw = Math.max(0, Math.round(layoutH - visibleBottom));
        var overlap = Math.min(56, raw);
        document.documentElement.style.setProperty('--vv-bottom-overlap', overlap + 'px');
      }
      syncBottomOverlap();
      visualViewport.addEventListener('resize', syncBottomOverlap);
      visualViewport.addEventListener('scroll', syncBottomOverlap);
      window.addEventListener('orientationchange', function () { setTimeout(syncBottomOverlap, 250); });
      window.addEventListener('pageshow', function (e) { if (e.persisted) setTimeout(syncBottomOverlap, 0); });
      requestAnimationFrame(function () { requestAnimationFrame(syncBottomOverlap); });
    })();
  
