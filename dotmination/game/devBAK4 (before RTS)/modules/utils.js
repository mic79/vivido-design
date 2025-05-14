// Utility functions for calculations, checks, etc.

export function isEven(n) {
  return n % 2 === 0;
}

// Color utilities
export function hexToRgb(hex) { 
  return hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i
             ,(m, r, g, b) => '#' + r + r + g + g + b + b)
    .substring(1).match(/.{2}/g)
    .map(x => parseInt(x, 16));
};

// --- Stopwatch Functions (Copied from script.js) ---
var clsStopwatch = function() {
		// Private vars
		var	startAt	= 0;	// Time of last start / resume. (0 if not running)
		var	lapTime	= 0;	// Time on the clock when last stopped in milliseconds

		var	now	= function() {
				return (new Date()).getTime(); 
			}; 
 
		// Public methods
		// Start or resume
		this.start = function() {
				startAt	= startAt ? startAt : now();
			};

		// Stop or pause
		this.stop = function() {
				// If running, update elapsed time otherwise keep it
				lapTime	= startAt ? lapTime + now() - startAt : lapTime;
				startAt	= 0; // Paused
			};

		// Reset
		this.reset = function() {
				lapTime = startAt = 0;
			};

		// Duration
		this.time = function() {
				return lapTime + (startAt ? now() - startAt : 0); 
			};
	};

var x = new clsStopwatch();
var $time; // DOM element reference
var clocktimer; // Interval ID

// Internal helper
function pad(num, size) {
	var s = "0000" + num;
	return s.substr(s.length - size);
}

// Internal helper
function formatTime(time) {
	let h = 0, m = 0, s = 0, ms = 0;
	var newTime = '';

	h = Math.floor( time / (60 * 60 * 1000) );
	time = time % (60 * 60 * 1000);
	m = Math.floor( time / (60 * 1000) );
	time = time % (60 * 1000);
	s = Math.floor( time / 1000 );
	ms = time % 1000;

	newTime = pad(m, 2) + ':' + pad(s, 2);
	return newTime;
}

// Internal helper - needs DOM access
function update() {
    if (!$time) $time = document.getElementById('time'); // Initialize if needed
    if ($time) { // Check if element exists
	    $time.innerHTML = formatTime(x.time());
    } else {
        console.warn("Timer update skipped: #time element not found.");
        // Stop the timer if the element disappears?
        // stopTimer(); 
    }
}

// Exported functions used by other modules
export function showTimer() { 
    if (!$time) $time = document.getElementById('time');
    if ($time) { // Check if element exists before updating
        update();
    } else {
        console.warn("showTimer: #time element not found.");
    }
}

export function startTimer() {
    if (!$time) $time = document.getElementById('time');
    if ($time) { // Only start if element exists
        if (clocktimer) clearInterval(clocktimer); // Clear existing timer if any
        clocktimer = setInterval(update, 1); // Use interval, 1ms is very fast, consider 100ms or 500ms?
        x.start();
    } else {
        console.warn("startTimer: #time element not found, timer not started.");
    }
}

export function stopTimer() {
	x.stop();
	if (clocktimer) clearInterval(clocktimer);
    clocktimer = null; // Clear interval ID
}

export function resetTimer() {
	stopTimer(); // Ensure timer is stopped before resetting
	x.reset();
    if ($time) { // Update display only if element exists
	    update();
    } else {
        // Attempt to find element again in case it appeared after initial load
        $time = document.getElementById('time');
        if ($time) update();
    }
}

// --- Dot Stage Utility ---
export function getStageNumber(dot) { // Expects a jQuery object for dot
    if (!dot || !dot.length || !dot.attr) return 0;
    const classAttr = dot.attr("class");
    if (!classAttr) return 0;
    const stageMatch = classAttr.match(/stage--(\d)/);
    return stageMatch ? parseInt(stageMatch[1]) : 0;
}