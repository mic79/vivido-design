// v1.0.7
// Singleplayer modes are stable.
// Multiplayer mode is working, peerJS setup with TURN server.
// Partially divided into modules.
// Added experimental RTS mode.

// Import Tutorial Module
import * as tutorial from './modules/tutorial.js';
// Import Timer Utilities and getStageNumber
import { isEven, hexToRgb, showTimer, resetTimer, startTimer, stopTimer, getStageNumber } from './modules/utils.js';
// Import Bot Logic
import { getBotMove } from './modules/botLogic.js';
// Import Real-Time Resource Mode Module
import * as rtrMode from './modules/realTimeResourceMode.js';

// Assume other modules will be imported later if needed
// import * as state from './modules/state.js';
// import * as ui from './modules/ui.js';
// import * as gameLogic from './modules/gameLogic.js';
// import * as storage from './modules/storage.js';
// import * as audio from './modules/audio.js';
// import { isEven, resetTimer, stopTimer, startTimer, showTimer } from './modules/utils.js';

// Dark Mode
function screenTest(e) {
  if (e.matches) {
    $('body').addClass('dark-mode');
  } else {
    $('body').removeClass('dark-mode');
  }
}

$( document ).ready(function() {
  var isDarkMode = window.matchMedia('(prefers-color-scheme:dark)')[0];
  if(isDarkMode) {
    isDarkMode.addEventListener('change', screenTest);
  }
});
// END Dark Mode

// Multiplayer Connection Management
const CONNECTION_STATES = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected'
};

let peer, conn, sessionID;
const MAX_LOBBIES = 10;
let hasConnected = false;
let connectionState = CONNECTION_STATES.DISCONNECTED;

// Session persistence
function saveSessionInfo(slotNumber, role) {
  localStorage.setItem('dotminationSession', JSON.stringify({
    slotNumber,
    role,
    startType: multiplayerStartType, // <<< Save start type
    timestamp: Date.now()
  }));
}

function getSessionInfo() {
  try {
    const session = JSON.parse(localStorage.getItem('dotminationSession'));
    // Ensure session exists and has a startType
    if (!session || !session.startType) return null; 

    // Check if session is not too old (e.g., 5 minutes)
    if (Date.now() - session.timestamp > 5 * 60 * 1000) {
      localStorage.removeItem('dotminationSession');
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function clearSessionInfo() {
  localStorage.removeItem('dotminationSession');
}

// LocalStorage
var myStorage = window.localStorage;

Storage.prototype.setObj = function(key, obj) {
  var data = this.setItem(key, JSON.stringify(obj));
  return data;
};

Storage.prototype.getObj = function(key) {
  var data = JSON.parse(this.getItem(key));
  return data;
};

//myStorage.clear();

var myDotmination = (myStorage.getObj("myDotmination") !== null) ? myStorage.getObj("myDotmination") : {'level': 1, 'levels': {'level1': {time:null}}};

// END LocalStorage

let level = (myDotmination !== null) ? myDotmination.level : 1,
    gameMode = 'regular',
    stage_amount = 5,
    dot_size = 64,
    dots, // This will be our main jQuery collection of all dot elements
    dotNeighbors = [],
    winW,
    winH,
    dotRows,
    dotCols;

$('body').addClass('mode-'+gameMode);
$('.main-menu-modal [data-mode="' + gameMode + '"]').addClass('selected');

$('.level-value').html(level);

var maxRows = 9;
var maxCols = 5;

var playerArray = ["player--1", "player--2"];
var randomNumber = Math.floor(Math.random() * playerArray.length);
var currentPlayer = "player--1"; //playerArray[randomNumber];
var moveAmount = 0;
var levelsArray = (myDotmination !== null && myDotmination.levels) ? myDotmination.levels : {'level0': {}};
var timeBest;
var timeDiff;
var delayedCall;
var botDifficulty = 'random'; // Options: 'random', 'smart'
let recentBotMoves = []; // Array to keep track of recent bot moves

// Variables for sound pitch progression
let chainReactionCounter = 0;
// One step farther waits 0.2s after the explosion that caused it. The wait is
// never skipped, so a late step cannot pull later steps into the same moment.
let chainAnchor = 0;
let chainJobs = 0;
let schedulingDepth = 0;
let chainStepShown = 0;
let lastChainStepEl = null;
const basePitch = 1.0;
const pitchStep = 0.05; // Increase pitch by 5% each time

// Add after your existing variables
let isMultiplayer = false;
let isHost = false;
let multiplayerStartType = 'blank'; // Default start type
let processingOpponentMove = false; // Flag to track opponent move processing
let initialSyncComplete = false; // Flag for client initial sync
let initialUrlCheckComplete = false; // <<< Add this flag
let matchStarter = "player--1"; // Player who starts the current match
let hostReadyForRematch = false;
let peerReadyForRematch = false;

// Remove all existing click handlers for .end
$("body").off("click", ".end, .end *");

// Single consolidated click handler for end overlay actions
$("body").on("click", ".end .card p", function(e) {
  e.preventDefault();
  e.stopPropagation();
  
  if ($(this).hasClass('retry')) {
    // Retry current map/level
    if (isMultiplayer) {
      // --- Multiplayer Rematch Logic ---
      if (conn) {
        // 1. Send ready signal for rematch
        console.log("Sending rematchReady signal");
        conn.send({ type: 'rematchReady' });
        
        // 2. Set local readiness
        if (isHost) {
          hostReadyForRematch = true;
        } else {
          peerReadyForRematch = true;
        }
        
        // 3. Visually clear overlay and show waiting state (optional)
        $(".end").remove();
        // TODO: Optionally add a "Waiting for opponent..." message here

        // 4. Check if opponent is already ready
        if (isHost && peerReadyForRematch) {
          console.log("Both players ready for rematch (Host perspective)");
          // If peer was already ready, host initiates the game start
          hostInitiateRematchStart();
        } else if (!isHost && hostReadyForRematch) {
          console.log("Both players ready for rematch (Peer perspective)");
          // Peer just waits for host to send game state
          // Reset local flags - host will send game state which triggers UI updates
          hostReadyForRematch = false;
          peerReadyForRematch = false;
          initialSyncComplete = false; // <<< ADD THIS LINE
        }
      }
      // Return here to prevent single-player logic execution
      return; 
      // --- End Multiplayer Rematch Logic ---
    }
    
    // --- Single Player Retry Logic ---
    if (gameMode === 'random') {
      var urlParams = new URLSearchParams(window.location.search);
      var map = urlParams.get('map');
      if (map) {
        // Preserve the current map
        setDots();
        buildMapFromString(map);
        dots = $(".dot");
        currentPlayer = "player--2";
        $(".field").addClass(currentPlayer);
        $(".end").remove();
        showTimer(); // Use imported function
        resetTimer(); // Use imported function
        startTimer(); // Use imported function
        updatePlayerScoresUI(); // <<< Update scores here
        return;
      }
    } else if (gameMode === 'regular') {
      // For regular mode, just restart current level
      var newUrl = window.location.pathname + '?mode=regular&level=' + level;
      window.history.replaceState({}, document.title, newUrl);
    }
    startAnim();
  } 
  else if ($(this).hasClass('new-map')) {
    // Generate new random map
    var newUrl = window.location.pathname + '?mode=random';
    window.history.replaceState({}, document.title, newUrl);
    startAnim();
  }
  else if (gameMode === 'regular') {
    // Next level - increment here
    if (level < 200) { // <<< Changed from 100 to 200
      level++;
    } else {
      level = 1;
    }
    var newUrl = window.location.pathname + '?mode=regular&level=' + level;
    window.history.replaceState({}, document.title, newUrl);
    startAnim();
  }
});

// Prevent clicks on overlay and card from triggering actions
$("body").on("click", ".end, .end .card", function(e) {
  if ($(e.target).hasClass('end') || $(e.target).hasClass('card')) {
    e.preventDefault();
    e.stopPropagation();
  }
});

$(".field").off("click", ".dot").on("click", ".dot", function() {
  let clickedDot = $(this);
  let clickedIndex = clickedDot.index();

  // <<< TUTORIAL CHECK: Call module function >>>
  if (tutorial.isTutorialActive()) {
    // Let the tutorial module handle/ignore the click first
    if (tutorial.handleTutorialDotClick(clickedIndex)) {
      // If tutorial handled (ignored) the click, stop here.
      //console.log("Dot click handled (ignored) by tutorial module.");
      return;
    }
    // If tutorial didn't handle it (returned false), proceed below.
  }
  // <<< END TUTORIAL CHECK >>>

  if (gameMode === 'realTimeResource') {
    // For RTR mode, the human player is always playerArray[1] ("player--2")
    // The bot (playerArray[0]) actions are triggered by rtrMode's internal timer.
    // Ensure current player is set correctly if it affects any shared UI updates, though rtrMode handles most.
    // currentPlayer = playerArray[1]; // This might be better set at the start of RTR game.
    rtrMode.handleRealTimeDotClick(clickedDot, playerArray[1]); 
    return; // RTR mode handles its own logic post-click
  }

  // Multiplayer turn check
  if (isMultiplayer) {
    const isMyTurn = (isHost && currentPlayer === "player--1") || (!isHost && currentPlayer === "player--2");
    if (!isMyTurn) {
      console.log("Not your turn");
      return;
    }
  }
  
  if (!$(this).closest(".field").hasClass("animating") &&
      ($(this).hasClass(currentPlayer) || !$(this).is('[class*="player--"]'))) {
    
    // Reset the pitch counter at the start of a new move/chain
    chainReactionCounter = 0;
    
    // If it's multiplayer, send the move to opponent before processing it
    if (isMultiplayer && conn) {
      conn.send({
        type: 'move',
        dotIndex: $(this).index()
      });
    }
    
    $(this).closest(".field").addClass("animating");
    $(this)
      .attr("data-increment", parseInt($(this).attr("data-increment")) + 1)
      .addClass("increment");
    // Pass the initiating player (currentPlayer) to incrementDotStage
    incrementDotStage($(this), currentPlayer);
  }
});

function nextPlayer() {
  console.log("nextPlayer called. isMultiplayer:", isMultiplayer, "gameMode:", gameMode, "currentPlayer:", currentPlayer);

  $(".field").removeClass(currentPlayer);
  if (currentPlayer == playerArray[0]) { // Bot's turn (Player 1)
    currentPlayer = playerArray[1];
    gsap.to("html", 0, {"--color-current": 'var(--color-2)'});
  } else { // User's turn or other player in MP
    currentPlayer = playerArray[0];
    gsap.to("html", 0, {"--color-current": 'var(--color-1)'});
    if(delayedCall) {
      delayedCall.kill();
    }
    // Only schedule bot action if not in multiplayer and not in tutorial steps 1-4
    if (!isMultiplayer && !(tutorial.isTutorialActive() && window.tutorialStep < 5) && gameMode !== 'realTimeResource') { 
      console.log("Scheduling bot action. Difficulty:", botDifficulty);
      
      // Prepare gameState for the bot
      const currentGameState = {
          dots: $(".dot"), // All dots
          player1Dots: $(".dot.player--1"), // Bot's dots
          player2Dots: $(".dot.player--2"), // Opponent's dots (user)
          targets: $(".dot:not(.player--2)") // Dots bot can click (empty or its own)
          // hitTest, recentMoves, visualFeedbackDelay will be passed directly to getBotMove
      };

      // The actual call to getBotMove, which will then internally call the appropriate bot action
      // Draggable.hitTest is passed directly as it's a global from a library
      // BOT_CONSTANTS.VISUAL_FEEDBACK_DELAY was 1000
      delayedCall = gsap.delayedCall(1, getBotMove, [currentGameState, botDifficulty, recentBotMoves, Draggable.hitTest, 1000]);
    }
  }
  $(".field").addClass(currentPlayer);
  moveAmount++;

  // Update turn indicator locally first for responsiveness
  // Only update if not in tutorial steps 1-4 OR if it's multiplayer
  // <<< FIX: Check tutorial state using the module >>>
  if (isMultiplayer || !tutorial.isTutorialActive() || tutorialStep >= 5) {
      updateTurnIndicator();
  }

  // Send authoritative game state update from host instead of just turn info
  if (isMultiplayer && isHost && conn) { // Only host sends state after their turn
    console.log("Host sending gameState after turn completion");
    conn.send({
      type: 'gameState',
      currentPlayer: currentPlayer, // The NEW current player (opponent)
      moveAmount: moveAmount,
      mapString: generateMapString(), // Current board state
      fieldClasses: $('.field').attr('class') // Reflects new current player
    });
  } else if (gameMode === 'realTimeResource') {
    // In RTR mode, there are no "turns" like this.
    // Bot actions are handled by rtrMode.runBotLogic interval.
    // Player actions are direct.
  }
}
//nextPlayer();

function playerClassClear() {
  return playerArray.join(" ");
}

function rippleBounce(dot) {
  if (typeof gsap === "undefined" || gameMode === "realTimeResource") return;
  const el = dot.get(0);
  if (!el) return;
  const target = (cellStyle === "blob") ? blobPipFor(el) : el;
  if (!target) return;
  gsap.killTweensOf(target);
  // Scale the pip only. Scaling the dot shrinks its hit box, and same-row
  // neighbors overlap by a fraction of a pixel, so those hits would be lost.
  target.classList.add("pip-bounce");
  gsap.fromTo(target, { "--pip-scale": 1 }, {
    "--pip-scale": 0.9,
    duration: 0.2,
    ease: "power2.inOut",
    yoyo: true,
    repeat: 1,
    overwrite: true,
    onComplete: function () {
      target.classList.remove("pip-bounce");
      target.style.removeProperty("--pip-scale");
    }
  });
}

function showChainStep(step, player) {
  if (gameMode === "realTimeResource" || typeof gsap === "undefined") return;
  const field = document.querySelector(".field");
  if (!field) return;
  const el = document.createElement("div");
  el.className = "chain-step";
  el.textContent = "Chain x" + step;
  el.style.color = player === "player--1" ? "var(--color-1)" : "var(--color-2)";
  field.appendChild(el);
  lastChainStepEl = el;
  gsap.fromTo(el, { xPercent: -50, y: 0, opacity: 1 }, {
    xPercent: -50,
    y: -220,
    opacity: 0,
    duration: 1.4,
    ease: "power1.out",
    onComplete: function () {
      el.remove();
      if (lastChainStepEl === el) lastChainStepEl = null;
    }
  });
}

// The step that ends the chain keeps its label readable, then fades.
function holdLastChainStep() {
  const el = lastChainStepEl;
  if (!el || !el.isConnected || typeof gsap === "undefined") return;
  const y = Number(gsap.getProperty(el, "y")) || 0;
  gsap.killTweensOf(el);
  gsap.set(el, { opacity: 1 });
  gsap.to(el, { y: y - 80, duration: 2.2, ease: "power1.out" });
  gsap.to(el, {
    opacity: 0,
    duration: 0.8,
    delay: 1.2,
    ease: "power1.in",
    onComplete: function () {
      el.remove();
      if (lastChainStepEl === el) lastChainStepEl = null;
    }
  });
}

function clearChainSchedule() {
  if (typeof gsap !== "undefined") {
    gsap.killTweensOf(incrementDotStage);
    $(".dot").each(function () {
      gsap.killTweensOf(this);
      this.classList.remove("pip-bounce");
      this.style.removeProperty("--pip-scale");
    });
    gsap.killTweensOf(".chain-step");
  }
  $(".chain-step").remove();
  chainAnchor = 0;
  chainJobs = 0;
  schedulingDepth = 0;
  chainStepShown = 0;
  lastChainStepEl = null;
}

function delayForDistance(distance) {
  if (gameMode === "realTimeResource" || distance <= 0) return 0;
  return 0.2;
}

function buildDotNeighbors() {
  const boxes = [];
  dots.each(function () {
    const left = parseFloat(this.style.left);
    const top = parseFloat(this.style.top);
    boxes.push({ l: left, r: left + dot_size, t: top, b: top + dot_size });
  });
  const inset = dot_size * 0.005;
  dotNeighbors = boxes.map((origin, index) => {
    const hit = { l: origin.l - inset, r: origin.r + inset, t: origin.t - inset, b: origin.b + inset };
    const list = [];
    for (let k = 0; k < boxes.length; k++) {
      if (k === index) continue;
      const box = boxes[k];
      if (!(box.r < hit.l || box.l > hit.r || box.b < hit.t || box.t > hit.b)) list.push(k);
    }
    return list;
  });
}

function enqueueExplosionNeighbors(trgt, effectivePlayer, distanceFromStart) {
  const originIndex = trgt.index();
  const nextDistance = distanceFromStart + 1;
  const delay = delayForDistance(nextDistance);
  if (dotNeighbors.length !== dots.length) buildDotNeighbors();
  const neighbors = (dotNeighbors[originIndex] || []).map((index) => $(dots[index]));
  schedulingDepth++;
  neighbors.forEach((neighbor) => {
    const pending = parseInt(neighbor.attr("data-increment"), 10);
    neighbor.attr("data-increment", (Number.isFinite(pending) ? pending : 0) + 1);
    neighbor.addClass("increment");
    showIncrementAnimation(neighbor, 1, effectivePlayer);
    chainJobs++;
    gsap.delayedCall(delay, incrementDotStage, [neighbor, effectivePlayer, true, nextDistance]);
  });
  schedulingDepth--;
}

function resetChainProgress() {
  clearChainSchedule();
  $(".dot").attr("data-increment", "0").removeClass("increment");
  $(".field").removeClass("animating");
}

function incrementDotStage(trgt, player = currentPlayer, fromQueue = false, distance = 0) {
  if (!fromQueue) {
    clearChainSchedule();
    chainAnchor = (typeof gsap !== "undefined") ? gsap.globalTimeline.time() : 0;
    $(".dot.increment").not(trgt).attr("data-increment", "0").removeClass("increment");
  } else if (chainJobs > 0) {
    chainJobs--;
  }
  rippleBounce(trgt);

  const dotIndex = trgt.index();
  let isStage4 = trgt.hasClass('stage--4');

  // --- Tutorial Step 2 Check (before stage changes) ---
  let justCompletedStep2 = false;
  if (window.isTutorialMode && window.tutorialStep === 2 && isStage4 && dotIndex === window.tutorialTargetDotIndex && player === 'player--2') {
    console.log("Tutorial Step 2: Player is about to explode the target dot.");
    justCompletedStep2 = true; // Mark completion, check will happen after animation
    console.log("Tutorial Step 2: justCompletedStep2 flag SET to true"); // <<< ADD LOG
  }
  // --- End Tutorial Step 2 Check ---

  // If a player is explicitly passed (for handling opponent moves),
  // use that player. Otherwise, use the global currentPlayer.
  const effectivePlayer = player;
  // Distance 1 is the blast from the click. A chain starts when that blast
  // sets off the next explosion.
  const chainStep = distance - 1;
  if (fromQueue && chainStep > chainStepShown) {
    chainStepShown = chainStep;
    showChainStep(chainStep, effectivePlayer);
  }
  console.log(`incrementDotStage called for index: ${trgt.index()} by effectivePlayer: ${effectivePlayer}`);

  // console.log('>> index: ' + trgt.index());
  trgt.attr("data-increment", parseInt(trgt.attr("data-increment")) - 1);
  if (parseInt(trgt.attr("data-increment")) <= 0) {
    trgt.removeClass("increment");
  }
  if (!trgt.is('[class*="stage--"]')) {
    trgt.addClass("stage--1 " + effectivePlayer);
    showIncrementAnimation(trgt, 1, effectivePlayer); // <<< Pass effectivePlayer to animation
    updatePlayerScoresUI(); // <<< Update score here
  } else {
    for (let i = 1; i <= stage_amount; i++) {
      var currStage = trgt.is('[class*="stage--' + i + '"]');
      if (currStage && i < stage_amount) {
        trgt
          .removeClass("stage--" + i)
          .removeClass(playerClassClear)
          .addClass("stage--" + (i + 1) + " " + effectivePlayer);
        showIncrementAnimation(trgt, 1, effectivePlayer); // <<< Pass effectivePlayer to animation
        updatePlayerScoresUI(); // <<< Update score here
        if (gameMode === 'realTimeResource') {
          animateNextDot(effectivePlayer); // Always pass effectivePlayer in RTR mode
        } else {
          animateNextDot(); // Use default for other modes
        }
        return;
      } else if (currStage && i == stage_amount) {
        trgt.removeClass("stage--" + i).removeClass(playerClassClear);
        updatePlayerScoresUI(); // <<< Update score here (dot became neutral)
        haptic([0, 40, 35, 50]);
        if (cellStyle === "blob" && blobSplat) {
          blobSplat.play();
        }
        enqueueExplosionNeighbors(trgt, effectivePlayer, distance);
      }
    }
  }
  if (gameMode === 'realTimeResource') {
    animateNextDot(effectivePlayer, justCompletedStep2); // Always pass effectivePlayer in RTR mode
  } else {
    animateNextDot(undefined, justCompletedStep2); // Use default for other modes
  }
}

function animateNextDot(player = currentPlayer, justCompletedStep2) {
  if (schedulingDepth > 0 || chainJobs > 0) {
    return;
  }

  $(".field").removeClass("animating");
  holdLastChainStep();

    // --- RTS MODE: Clear chain lock when chain is finished ---
    if (gameMode === 'realTimeResource' && typeof rtrMode.clearActiveChainPlayerLock === 'function') {
      rtrMode.clearActiveChainPlayerLock();
    }

    // <<< FIX: Call tutorial module completion check >>>
    if (tutorial.isTutorialActive()) {
        // Check if tutorial info was stored by handleTutorialDotClick
        if (window.tutorialCheckInfo && typeof tutorial.handleTutorialCompletionCheck === 'function') {
            console.log(`Animation complete, calling tutorial check for Step: ${window.tutorialCheckInfo.step}, Index: ${window.tutorialCheckInfo.index}`);
            // Pass the stored step and index
            tutorial.handleTutorialCompletionCheck(window.tutorialCheckInfo.step, window.tutorialCheckInfo.index);
            // Clear the info after use
            window.tutorialCheckInfo = null; // <<< ADD THIS LINE TO CLEAR INFO AFTER USE
        } else {
             console.log("Animation complete, but no tutorial check info found or function missing.");
        }
    }

    /* Commented out original logic
    if (isTutorialMode) {
        updateTutorialFeedback();
        checkTutorialStepCompletion();
    }
    */

    const shouldCheckState = !isMultiplayer || isHost || !processingOpponentMove;

    if (shouldCheckState) {
       // In RTR mode, checkDotmination might still be relevant after an explosion sequence completes.
       checkDotmination();
    }

    if (processingOpponentMove) {
      processingOpponentMove = false;
    }
}

function showIncrementAnimation(targetDot, incrementValue = 1, player = currentPlayer) {
  const effectivePlayer = player;
  const animationText = `+${incrementValue}`;
  const $field = $('.field');
  const fieldOffset = $field.offset();
  const dotOffset = targetDot.offset();
  const dotSize = targetDot.width();

  const startX = dotOffset.left - fieldOffset.left + (dotSize / 2);
  const startY = dotOffset.top - fieldOffset.top + (dotSize / 2);

  const animationColor = (effectivePlayer === 'player--1') ? 'var(--color-1)' : 'var(--color-2)';

  const $animationElement = $('<div class="increment-animation"></div>')
    .text(animationText)
    .css({
      left: startX + 'px',
      top: startY + 'px',
      color: animationColor,
      transform: 'translate(-50%, -50%)'
    })
    .appendTo($field);

  // Set animation duration: 0 for RTS mode, 0.8 for others
  const animationDuration = (gameMode === 'realTimeResource') ? 0 : 0.8;

  gsap.to($animationElement, {
    duration: animationDuration,
    y: '-=40',
    opacity: 0,
    ease: 'power1.out',
    onComplete: function() {
      $animationElement.remove();
    }
  });

  if (incrementSound) {
    const currentPitch = basePitch + (chainReactionCounter * pitchStep);
    incrementSound.rate(currentPitch);
    incrementSound.play();
    chainReactionCounter++;
  }
}

function checkDotmination() {
  // <<< FIX: Use tutorial module check >>>
  if (tutorial.isTutorialActive()) { 
    return; 
  }

  // For RTR mode, game over might be slightly different (e.g., one player has 0 dots, or a resource-based timeout)
  // For now, we'll use the existing logic but ensure nextPlayer() isn't called if it's an RTR game over.
  const isGameOverRTR = gameMode === 'realTimeResource' && ($('.dot.player--1').length === 0 || $('.dot.player--2').length === 0);
  const isGameOverClassic = !(moveAmount < 2 || ($('.dot.player--1').length > 0 && $('.dot.player--2').length > 0));
  const isGameOver = (gameMode === 'realTimeResource') ? isGameOverRTR : isGameOverClassic;


  if (!isMultiplayer) {
    if (!isGameOver) {
      if (gameMode !== 'realTimeResource') {
        nextPlayer();
      }
    } else {
      if (gameMode === 'realTimeResource') {
        rtrMode.stopRealTimeResourceGame(); // Stop RTR intervals
        stopTimer();
        sound.play();
        // Determine winner
        let winner = null;
        if ($('.dot.player--1').length > 0 && $('.dot.player--2').length === 0) {
          winner = 'player--1';
        } else if ($('.dot.player--2').length > 0 && $('.dot.player--1').length === 0) {
          winner = 'player--2';
        }
        if (winner) {
          rtrMode.showGameOverOverlay(winner);
        }
        return;
      }
      stopTimer(); 
      sound.play();
      
      console.log("CHECKDOTMINATION: Game Over. Current Player:", currentPlayer, "Game Mode:", gameMode, "Level:", level);

      if (currentPlayer == "player--2") { 
          console.log("CHECKDOTMINATION: User (Player 2) won.");
          if (gameMode === 'random') {
            console.log("CHECKDOTMINATION: Random mode win detected."); // <<< NEW LOG
            var timeHtml = $('#time').html();
            console.log("CHECKDOTMINATION: Time HTML for random mode: ", timeHtml); // <<< NEW LOG
            
            let goalMoves = '';
            let goalTime = '';
            try {
                if(moment.duration('00:'+timeHtml).asSeconds() != 0 && moment.duration('00:'+timeHtml).asSeconds() < 120) {
                    goalMoves = 'active';
                }
                if(moment.duration('00:'+timeHtml).asSeconds() != 0 && moment.duration('00:'+timeHtml).asSeconds() < 60) {
                    goalTime = 'active';
                }
                console.log("CHECKDOTMINATION: Star calculation successful. goalMoves:", goalMoves, "goalTime:", goalTime); // <<< NEW LOG
            } catch (e) {
                console.error("CHECKDOTMINATION: Error during star calculation for random mode:", e); // <<< NEW LOG
            }
            
            const overlayHTML = 
              '<div class="end overlay noselect ' + currentPlayer + '">' +
                '<div class="card">' +
                  '<h1>Dotmination!</h1>' +
                  '<span class="level-goals">' +
                    '<i class="fas fa-star level-goals-won active"></i>' +
                    '<i class="fas fa-star level-goals-moves ' + goalMoves + '"></i>' +
                    '<i class="fas fa-star level-goals-time ' + goalTime + '"></i>' +
                  '</span>' +
                  '<p class="retry">Retry <i class="fas fa-undo"></i></p>' +
                  '<p class="new-map">Next <i class="fas fa-random"></i></p>' +
                '</div>' +
              '</div>';
            console.log("CHECKDOTMINATION: Appending random win overlay HTML..."); // <<< NEW LOG
            $("body .container").append(overlayHTML);
            console.log("CHECKDOTMINATION: Random win overlay HTML appended. Overlay card count:", $('.overlay > .card').length); // <<< NEW LOG
            
            if (typeof gsap !== 'undefined') {
              gsap.fromTo($('.overlay > .card'), {alpha: 0, scale: 0}, {duration: 2, alpha: 1, scale: 1, ease:"elastic.out(1, 0.3)"});
              console.log("CHECKDOTMINATION: GSAP animation initiated for random win overlay."); // <<< NEW LOG
            } else if (typeof TweenMax !== 'undefined') {
              TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
              console.log("CHECKDOTMINATION: TweenMax animation initiated for random win overlay."); // <<< NEW LOG
            } else {
              console.error("CHECKDOTMINATION: No animation library (GSAP or TweenMax) found for random win overlay!");
              $('.overlay > .card').css({alpha: 1, transform: 'scale(1)'}); 
            }

          } else if (level < 200) { 
            console.log("Regular mode win, level < 200.");
            if($('body').hasClass('mode-regular')) {
              console.log("Body has class mode-regular. Preparing to show win overlay.");
              var levelObj = {'level': level};
              myDotmination['level'] = level;
              
              timeBest = (levelsArray['level' + level] !== undefined) ? levelsArray['level' + level].time : null;
              let timeBestDuration = timeBest ? moment.duration('00:'+timeBest) : moment.duration(0);
              timeDiff = moment.duration('00:'+$('#time').html()).subtract(timeBestDuration).asMilliseconds();
              
              $('.timediff').remove();
              
              if(timeBest === null || timeDiff < 0) {
                levelsArray['level' + level] = {'time': $('#time').html()};
                myDotmination['levels'] = levelsArray;
              }
              
              if (level < 200 && !levelsArray['level' + (level + 1)]) { 
                levelsArray['level' + (level + 1)] = {'time': null};
                myDotmination['levels'] = levelsArray;
              }
              
              myStorage.setObj("myDotmination", myDotmination);
              updateLevelList();
              
              var hasTime = levelsArray['level' + level] && levelsArray['level' + level].time && levelsArray['level' + level].time !== null;
              var wonStarClass = hasTime ? 'active' : '';
              var goalMoves = (moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 120) ? 'active' : '';
              var goalTime = (moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 60) ? 'active' : '';
              
              const overlayHTML = 
                '<div class="end overlay noselect ' + currentPlayer + '">' +
                  '<div class="card">' +
                    '<h1>Dotmination!</h1>' +
                    '<span class="level-goals">' +
                      '<i class="fas fa-star level-goals-won ' + wonStarClass + '"></i>' +
                      '<i class="fas fa-star level-goals-moves ' + goalMoves + '"></i>' +
                      '<i class="fas fa-star level-goals-time ' + goalTime + '"></i>' +
                    '</span>' +
                    '<p>Next Level <i class="fas fa-arrow-right"></i></p>' +
                  '</div>' +
                '</div>';
              console.log("Appending overlay HTML...");
              $("body .container").append(overlayHTML);
              console.log("Overlay HTML appended. Overlay card count:", $('.overlay > .card').length);
              
              // Use gsap for animation if TweenMax is being phased out, otherwise ensure TweenMax is loaded and working
              if (typeof gsap !== 'undefined') {
                gsap.fromTo($('.overlay > .card'), {alpha: 0, scale: 0}, {duration: 2, alpha: 1, scale: 1, ease:"elastic.out(1, 0.3)"});
                console.log("GSAP animation initiated for overlay.");
              } else if (typeof TweenMax !== 'undefined') {
                TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
                console.log("TweenMax animation initiated for overlay.");
              } else {
                console.error("No animation library (GSAP or TweenMax) found for overlay!");
                $('.overlay > .card').css({alpha: 1, transform: 'scale(1)'}); // Fallback to just show it
              }
            } else {
              console.log("Body does NOT have class mode-regular. Win overlay not shown for regular mode.");
            }
          } else { // <<< Level 200 win (loop back) >>>
            level = 1;
            $("body .container").append(
              '<div class="end overlay noselect ' + currentPlayer + '">' +
                '<div class="card">' +
                  '<h1>Dotmination!</h1>' +
                  '<p>Next Level <i class="fas fa-undo"></i></p>' +
                '</div>' +
              '</div>'
            );
            TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
          }
      } else { // Player 1 (usually Bot) is the one who made the winning move -> User Lost
          console.log("CHECKDOTMINATION: Bot (Player 1) won / User lost. Game Mode:", gameMode); // <<< MODIFIED LOG
          
          const overlayHTML = 
            '<div class="end overlay noselect ' + currentPlayer + '">' +
              '<div class="card">' +
                '<h1>Dotmination!</h1>' +
                '<span class="level-goals">' +
                  '<i class="fas fa-star"></i>' +
                  '<i class="fas fa-star"></i>' +
                  '<i class="fas fa-star"></i>' +
                '</span>' +
                '<p class="retry">Retry <i class="fas fa-undo"></i></p>' +
                (gameMode === 'random' ? '<p class="new-map">Next <i class="fas fa-random"></i></p>' : '') +
              '</div>' +
            '</div>';
          
          console.log("CHECKDOTMINATION: Appending 'User Lost' overlay HTML..."); 
          $("body .container").append(overlayHTML);
          console.log("CHECKDOTMINATION: 'User Lost' overlay HTML appended. Overlay card count:", $('.overlay > .card').length);
          
          if (typeof gsap !== 'undefined') {
            gsap.fromTo($('.overlay > .card'), {alpha: 0, scale: 0}, {duration: 2, alpha: 1, scale: 1, ease:"elastic.out(1, 0.3)"});
            console.log("CHECKDOTMINATION: GSAP animation initiated for 'User Lost' overlay.");
          } else if (typeof TweenMax !== 'undefined') {
            TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
            console.log("CHECKDOTMINATION: TweenMax animation initiated for 'User Lost' overlay.");
          } else {
            console.error("CHECKDOTMINATION: No animation library (GSAP or TweenMax) found for 'User Lost' overlay!");
            $('.overlay > .card').css({alpha: 1, transform: 'scale(1)'}); 
          }
      }
    }
  } else { // --- Multiplayer Logic ---
    if (isGameOver) {
       // MP Game Over Handling (Host Driven)
       if (isHost) {
         // Determine winner (the one who still has dots)
         const winner = $(".dot.player--1").length > 0 ? "player--1" : "player--2";

         // Send gameOver message to peer
         if (conn) {
           // <<< Send final map state WITH the gameOver message >>>
           const finalMapString = generateMapString();
           conn.send({
             type: 'gameOver',
             winner: winner,
             mapString: finalMapString // <<< Include final state
           });
         }

         // Show overlay locally for host
         showMultiplayerGameOverOverlay(winner);
       }
       // Peer waits for gameOver message
       // TODO: Peer should handle gameOver message and display overlay
    } else {
      // MP Turn Switch (Host Driven)
      if (isHost) {
        // Only the host calls nextPlayer to switch turn and send update
        nextPlayer();
      }
      // Peer does nothing here, waits for turnUpdate message
    }
  }
}

function setDots() {
  clearChainSchedule();
  /*winW = $(window).width();
  winH = $(window).height();
  dotRows = Math.floor(winH / (dot_size / 1.25));
  dotCols = Math.floor(winW / dot_size);*/
  
  //if (dotRows > maxRows && dotCols > maxCols) {
    dotRows = maxRows; //level;
    dotCols = maxCols;
    winW = dotCols * dot_size;
    winH = dotRows * dot_size;
  //}

  var dotIndex = 0;

  $(".field")
    .html("")
    .removeClass(playerClassClear)
    .height(dotRows * (dot_size / 1.25))
    .width(dotCols * dot_size);
  
  if (dotCols && dotRows) {
    // <<< FIX: Declare loop variable 'i' with let >>>
    for (let i = 0; i < dotRows; i++) { 
      var newY = (dot_size * i) / 1.25;
      let colsInThisRow; // <<< FIX: Use separate variable for columns in this row >>>
      if (isEven(i)) {
        colsInThisRow = dotCols -1; // Calculate for even rows
      } else {
        colsInThisRow = dotCols; // Use original dotCols for odd rows
      }
      // <<< FIX: Declare loop variable 'j' with let >>>
      for (let j = 0; j < colsInThisRow; j++) { 
        if (isEven(i)) {
          var newX = dot_size * j + dot_size / 2;
        } else {
          var newX = dot_size * j;
        }
        $(".field").append(
          '<div class="dot rippled" data-index="' +
            dotIndex +
            '" data-increment="0"><div class="atom" aria-hidden="true"><div class="blob"></div><div class="blob"></div><div class="blob"></div><div class="blob"></div><div class="blob"></div><div class="blob"></div></div><span class="stage-num"></span><div class="hitarea"></div></div>'
        );
        $(".dot:last").css({ top: newY, left: newX });
        dotIndex++;
      }
    }
  }
  dots = $(".dot"); // Assign to global dots variable
  buildDotNeighbors();
  syncBlobLayer();
}
//setDots();

// Rippled
$("body").on("click", ".rippled", function (e) {
    if (!$(this).hasClass("disabled")) {
      haptic(40);
      const blobClick = cellStyle === "blob" && $(this).hasClass("dot");
    const host = blobClick ? $(".blob-layer") : $(this);
    if (!host.length) return;
    const ripple = $('<div class="ripple ripple-animate"></div>');
    if (blobClick) {
      ripple.css({ left: this.style.left, top: this.style.top });
    }
    host.append(ripple);
    setTimeout(function () {
      ripple.remove();
    }, blobClick ? 1400 : 400);
  }
});
// END Rippled

/*function isEven(n) {
  return n % 2 == 0;
}*/

$(window).on("resize", function () {
  setDots();
});

function updatePlayerIcons() {
  if (!isMultiplayer) {
    // Determine Player 1 icon
    let player1Icon = 'fa-robot'; // Default for regular mode or normal random bot
    if (gameMode === 'random' && botDifficulty === 'smart') {
      player1Icon = 'fa-brain'; // Harder bot in random mode
    }
    $('.player.player--1 i').removeClass('fa-user-secret fa-robot fa-brain').addClass(player1Icon);

    // Set Player 2 icon
    $('.player.player--2 i').removeClass('fa-robot fa-brain').addClass('fa-user-secret');

    $('.player-indicator').remove(); // Remove any leftover MP indicators
    $('.turn-indicator').remove();   // Remove turn indicator (might be re-added by MP logic)
  } else {
    // Multiplayer: Both icons are fa-user-secret (this logic might be duplicated from updatePlayerIndicators, consider consolidating later)
    $('.player.player--1 i').removeClass('fa-robot fa-brain').addClass('fa-user-secret');
    $('.player.player--2 i').removeClass('fa-robot fa-brain').addClass('fa-user-secret');
  }
}

function startAnim() {
  moveAmount = 0;
  randomNumber = Math.floor(Math.random() * playerArray.length);
  // currentPlayer = "player--2"; // Original line, might need adjustment based on mode

  // Explicitly set botDifficulty for regular mode
  if (gameMode === 'regular') {
    botDifficulty = 'random';
    console.log("startAnim: Regular mode detected. Bot difficulty set to 'random'.");
    currentPlayer = "player--2"; // User starts in regular mode
  } else if (gameMode === 'random') {
    currentPlayer = "player--2"; // User starts in random mode
  } else if (gameMode === 'multiplayer') {
    // currentPlayer is determined by host/peer logic and game state sync
    // For a fresh multiplayer game start (before connection), P1 might be default.
    // This will be overwritten by game state from host anyway.
    currentPlayer = "player--1"; 
  } else if (gameMode === 'realTimeResource') {
    currentPlayer = playerArray[1]; // Human player in RTR is Player 2
    // Bot (Player 1) is handled by rtrMode
  }

  updatePlayerIcons(); // Call the new function here
  
  $('.level-value').html(level);
  // Stop any existing RTR game before starting a new animation/mode
  if (gameMode !== 'realTimeResource') { // If changing FROM RTR or it was never RTR
      rtrMode.stopRealTimeResourceGame(); 
  }

  setDots();
  $(".end").remove();
  $(".dot").removeClass(playerClassClear);
  
  var populate = null;
  if (gameMode == 'regular') {
    populate = fieldPopulateByLevel;
  } else if (gameMode == 'random') {
    populate = fieldPopulateRandom;
  } // For realTimeResource, leave as null
  
  TweenMax.staggerTo(
    $(".dot"),
    0.1,
    {
      className: "dot rippled stage--1",
      repeat: 1,
      yoyo: true,
      repeatDelay: 0.2
    },
    0.01,
    function() {
      // Final score update after animation completes
      if (gameMode !== 'realTimeResource') {
        updatePlayerScoresUI(); 
      }
      if (gameMode === 'realTimeResource') {
        rtrMode.startRealTimeResourceGame(); // RTR mode handles its own population and resource display
      } else if (typeof populate === 'function') {
        populate(); // Only call if function
      }
    }
  );
}

// Add this function to generate a unique string representation of the map
function generateMapString() {
  var mapString = "";
  $(".field .dot").each(function() {
    var stage = 0;
    var player = 0;
    
    // Get stage (1-5)
    for (var i = 1; i <= stage_amount; i++) {
      if ($(this).hasClass("stage--" + i)) {
        stage = i;
        break;
      }
    }
    
    // Get player (1-2)
    if ($(this).hasClass("player--1")) {
      player = 1;
    } else if ($(this).hasClass("player--2")) {
      player = 2;
    }
    
    // Encode as a single character (0-9, A-Z)
    // 0 = empty, 1-5 = player 1 stage 1-5, 6-A = player 2 stage 1-5
    var code = stage;
    if (player === 2) {
      code += 5;
    }
    
    mapString += code.toString(16).toUpperCase(); // Convert to hex
  });
  
  return mapString;
}

// Add this function to build a map from a string
function buildMapFromString(mapString) {
  if (!mapString || mapString.length !== $(".field .dot").length) {
    console.error("Invalid map string length");
    return false;
  }
  
  $(".field .dot").each(function(index) {
    // Clear existing classes
    $(this).removeClass(function(index, className) {
      return (className.match(/(^|\s)stage--\S+/g) || []).join(' ');
    }).removeClass(playerClassClear);
    
    if (index < mapString.length) {
      var code = parseInt(mapString[index], 16); // Parse hex
      
      if (code > 0) {
        var stage = code;
        var player = 1;
        
        if (code > 5) {
          stage = code - 5;
          player = 2;
        }
        
        if (stage >= 1 && stage <= 5) {
          $(this).addClass("stage--" + stage + " player--" + player);
        }
      }
    }
  });
  
  return true;
}

// Modify the fieldPopulateRandom function to use URL parameters
function fieldPopulateRandom() {
  $(".field .dot").each(function (index) {
    var randomStage = Math.floor(Math.random() * (stage_amount + 1));
    var randomPlayerNumber = Math.floor(Math.random() * playerArray.length) + 1;
    
    if (randomStage == 0) {
    } else {
      $(this).addClass(
        "stage--" + randomStage + " player--" + randomPlayerNumber
      );
    }
  });
  dots = $(".dot");

  // Update URL with new random map state using hex format
  if (gameMode === 'random') {
    var mapString = generateMapString();
    var newUrl = window.location.pathname + '?mode=random&map=' + mapString + '&difficulty=' + botDifficulty;
    window.history.replaceState({}, document.title, newUrl);
  }
  if (gameMode !== 'realTimeResource') { // nextPlayer not used in RTR
    gsap.delayedCall(1,nextPlayer);
  }
  // <<< FIX: Use imported timer functions >>>
  showTimer();
  resetTimer();
  startTimer();
  updatePlayerScoresUI(); // <<< Update scores after random population
}

function fieldPopulateByLevel() {
  //level = 0;
  //console.log('fieldPopulateByLevel', level);
  var dotsAmount = $(".field .dot").length;
  $(".field .dot").each(function (index) {
    if(level == 0) {
      var dotStage = 5;
      if(index < 4) {
        dotStage = 0;
      }
      var dotPlayerNumber = 2;
    } else {
      var piString = (Math.PI * (index + 1) * level).toString();
      
      // Default values in case of NaN
      var defaultStage = (index + level) % 5; // Range 0-4
      var defaultPlayer = (index % 2) + 1; // Range 1-2

      // Calculate dotStage with NaN check
      var stageChar = piString[7];
      var stageNum = Number(stageChar);
      var dotStage = (stageChar === undefined || isNaN(stageNum)) 
                     ? defaultStage 
                     : Math.floor(stageNum / 10 * 5); // Original calculation produces 0-4

      // Calculate dotPlayerNumber with NaN check
      var playerChar = piString[5];
      var playerNum = Number(playerChar);
      var dotPlayerNumber = (playerChar === undefined || isNaN(playerNum)) 
                            ? defaultPlayer 
                            : Math.floor(playerNum / 10 * 2) + 1; // Original calculation produces 1-2
    }
    
    //console.log('---');
    //console.log('index', index);
    //console.log('stage', dotStage);
    //console.log('player', dotPlayerNumber);
    if (dotStage == 0) {
      // Dot remains empty
    } else {
      // Ensure stage is within bounds (though calculations should handle this)
      dotStage = Math.max(0, Math.min(5, dotStage)); // Clamp stage 0-5 (level 0 uses 5)
      // Ensure player is valid
      dotPlayerNumber = (dotPlayerNumber === 1 || dotPlayerNumber === 2) ? dotPlayerNumber : defaultPlayer; 

      $(this).addClass(
        "stage--" + dotStage + " player--" + dotPlayerNumber
      );
    }
  });
  dots = $(".dot");

  if (gameMode !== 'realTimeResource') { // nextPlayer not used in RTR
    gsap.delayedCall(1,nextPlayer);
  }
  // <<< FIX: Use imported timer functions >>>
  showTimer();
  resetTimer();
  startTimer();
  updatePlayerScoresUI(); // <<< Update scores after level population
}

var colorNeutral = "#7F7F7F";
var colorsArr = [["#12DACE", "#E11168"], ["#1100FF", "#FF3F00"], ["#FF00FF", "#0000FF"], ["#5158af", "#af5160"]];
var colorsIndex = 0;

function incrementColorsIndex() {
  if (colorsArr.length > 0) {
    if (colorsIndex + 1 >= colorsArr.length) {
      colorsIndex = 0;
    } else {
      colorsIndex++;
    }
  }
}

function paintColorGroup() {
  const hex1 = colorsArr[colorsIndex][0];
  const hex2 = colorsArr[colorsIndex][1];
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);

  gsap.to("html", {duration: 0, "--color-1": hex1});
  gsap.to("html", {duration: 0, "--color-2": hex2});
  gsap.to("html", {duration: 0, "--color-1-rgba-0": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.75)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-1": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.4)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-2": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.3)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-3": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.2)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-4": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.1)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-5": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-0": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.75)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-1": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.4)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-2": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.3)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-3": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.2)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-4": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.1)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-5": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0)`});

  var currentColor = $('.field').hasClass('player--1') ? 1 : 2;
  gsap.to("html", {duration: 0, "--color-current": colorsArr[colorsIndex][currentColor - 1]});
  markSettingsSelection();
}

function changeColors() {
  incrementColorsIndex();
  paintColorGroup();
}

function selectColorGroup(index) {
  if (index === colorsIndex || index < 0 || index >= colorsArr.length) return;
  colorsIndex = index;
  paintColorGroup();
}

//listen to shake event
var shakeEvent = new Shake({ threshold: 15 });
shakeEvent.start();
window.addEventListener(
  "shake",
  function() {
    changeColors();
  },
  false
);

$('.players .player--1').on('click', function() {
  changeColors();
});

// Modal
$('div[data-modal]').on('click', function() {
  $('.modal').removeClass('active');
  $($(this).data('modal')).addClass('active');
  // REMOVED: $('body').addClass('modal-open'); 
});

$('.modal .wrapper').on('click', function(e) {
  e.stopImmediatePropagation();
});

$('.modal-close').on('click', function() {
  $(this).closest('.modal').removeClass('active');
  $('body').removeClass('modal-open'); // <<< ADD THIS LINE BACK
});
// END Modal

// --- Main Menu Modal Logic ---
const cellStyleOrder = ["dot", "atom", "blob"];
let cellStyle = "dot";
let showStageNumbers = false;
let hapticEnabled = true;

try {
  const savedCells = localStorage.getItem("dotmination-cells");
  if (cellStyleOrder.indexOf(savedCells) !== -1) cellStyle = savedCells;
  showStageNumbers = localStorage.getItem("dotmination-numbers") === "1";
  hapticEnabled = localStorage.getItem("dotmination-haptics") !== "0";
} catch (e) {}

function haptic(pattern) {
  if (!hapticEnabled || pattern == null) return false;
  try {
    if (typeof navigator.vibrate === "function" && navigator.vibrate(pattern)) return true;
  } catch (e) {}
  try {
    const native = navigator.notification && navigator.notification.vibrate;
    if (typeof native === "function") {
      native.call(navigator.notification, pattern);
      return true;
    }
  } catch (e) {}
  return false;
}

function markSettingsSelection() {
  $(".color-swatch").removeClass("selected").attr("aria-pressed", "false");
  $(".color-swatch[data-colors='" + colorsIndex + "']").addClass("selected").attr("aria-pressed", "true");
  $(".cell-preview").removeClass("selected").attr("aria-pressed", "false");
  $(".cell-preview[data-cells='" + cellStyle + "']").addClass("selected").attr("aria-pressed", "true");
  $(".setting-switch[data-action='numbers']").toggleClass("on", showStageNumbers).attr("aria-pressed", showStageNumbers ? "true" : "false");
  $(".setting-switch[data-action='haptics']").toggleClass("on", hapticEnabled).attr("aria-pressed", hapticEnabled ? "true" : "false");
}

function buildColorSwatches() {
  const row = document.querySelector(".setting-colors");
  if (!row || row.childElementCount) return;
  colorsArr.forEach(function (pair, index) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-swatch";
    button.dataset.colors = String(index);
    button.style.setProperty("--swatch-1", pair[0]);
    button.style.setProperty("--swatch-2", pair[1]);
    button.setAttribute("aria-label", "Color set " + (index + 1));
    row.appendChild(button);
  });
}

function applyCellSettings() {
  $("body").toggleClass("cells-atom", cellStyle === "atom");
  $("body").toggleClass("cells-blob", cellStyle === "blob");
  $("body").toggleClass("show-stage-numbers", showStageNumbers);
  markSettingsSelection();
  syncBlobLayer();
}

function blobPipFor(dotEl) {
  if (!dotEl) return null;
  const dotsNow = document.querySelectorAll(".field > .dot");
  const index = Array.prototype.indexOf.call(dotsNow, dotEl);
  if (index < 0) return null;
  const pips = document.querySelectorAll(".blob-layer > .blob-pip");
  return pips[index] || null;
}

let blobSyncing = false;
function syncBlobLayer() {
  if (blobSyncing) return;
  const field = document.querySelector(".field");
  if (!field) return;
  blobSyncing = true;
  try {
    let layer = field.querySelector(":scope > .blob-layer");
    if (cellStyle !== "blob") {
      if (layer) layer.remove();
      return;
    }
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "blob-layer";
      field.appendChild(layer);
    }
    const dotEls = field.querySelectorAll(":scope > .dot");
    let pips = layer.querySelectorAll(":scope > .blob-pip");
    if (pips.length !== dotEls.length) {
      layer.replaceChildren();
      dotEls.forEach(function () {
        const pip = document.createElement("div");
        pip.className = "blob-pip";
        pip.appendChild(document.createElement("i"));
        layer.appendChild(pip);
      });
      pips = layer.querySelectorAll(":scope > .blob-pip");
    }
    dotEls.forEach(function (dot, i) {
      const pip = pips[i];
      if (pip.style.left !== dot.style.left) pip.style.left = dot.style.left;
      if (pip.style.top !== dot.style.top) pip.style.top = dot.style.top;
      let stage = "0";
      for (let n = 1; n <= 5; n++) {
        if (dot.classList.contains("stage--" + n)) stage = String(n);
      }
      if (pip.dataset.stage !== stage) pip.dataset.stage = stage;
      const p1 = dot.classList.contains("player--1");
      const p2 = dot.classList.contains("player--2");
      if (pip.classList.contains("player--1") !== p1) pip.classList.toggle("player--1", p1);
      if (pip.classList.contains("player--2") !== p2) pip.classList.toggle("player--2", p2);
    });
  } finally {
    blobSyncing = false;
  }
}

const blobObserver = new MutationObserver(function () {
  if (cellStyle === "blob") syncBlobLayer();
});
const blobField = document.querySelector(".field");
if (blobField) {
  blobObserver.observe(blobField, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"]
  });
}

function showMenuView(view) {
  const titles = {
    main: "Menu",
    settings: "Settings",
    "mode-regular": "Levels",
    "mode-random": "Random",
    "mode-multiplayer": "Multiplayer"
  };
  $(".main-menu-modal .menu-view").removeClass("active");
  const viewEl = $(".main-menu-modal .menu-view-" + view);
  viewEl.addClass("active");
  viewEl.find(".bot-difficulty, .list--mode-regular, .multiplayer-start-options").css("display", "");
  $(".main-menu-modal h2").text(titles[view] || "Menu");
  $(".main-menu-modal").toggleClass("submenu", view !== "main");
}

function openMainMenu(view) {
  const modal = $(".main-menu-modal");
  const next = view || "main";
  const already = modal.hasClass("active") && $(".menu-view-" + next).hasClass("active");
  $(".modal").removeClass("active");
  if (already) {
    $("body").removeClass("modal-open");
    return;
  }
  showMenuView(next);
  modal.addClass("active");
  $("body").addClass("modal-open");
  if (next === "mode-regular") updateLevelList();
}

buildColorSwatches();
applyCellSettings();

$('.main-menu-modal .menu-back').on('click', function() {
  showMenuView("main");
});

$('.menu-view-settings').on('click', '.color-swatch', function() {
  selectColorGroup(Number($(this).data('colors')));
});

$('.menu-view-settings').on('click', '.cell-preview', function() {
  const next = $(this).data('cells');
  if (cellStyleOrder.indexOf(next) === -1 || next === cellStyle) return;
  cellStyle = next;
  try { localStorage.setItem("dotmination-cells", cellStyle); } catch (e) {}
  applyCellSettings();
});

$('.menu-view-settings').on('click', '.setting-switch', function() {
  const action = $(this).data('action');
  if (action === 'numbers') {
    showStageNumbers = !showStageNumbers;
    try { localStorage.setItem("dotmination-numbers", showStageNumbers ? "1" : "0"); } catch (e) {}
    applyCellSettings();
  } else if (action === 'haptics') {
    hapticEnabled = !hapticEnabled;
    try { localStorage.setItem("dotmination-haptics", hapticEnabled ? "1" : "0"); } catch (e) {}
    applyCellSettings();
    if (hapticEnabled) haptic(40);
  }
});

// Open main menu modal
$('#main-menu-btn').on('click', function(e) {
  e.stopPropagation(); // Prevent header clicks if any
  $('.modal').removeClass('active'); // Close any other open modals
  showMenuView("main");
  $('.main-menu-modal').addClass('active');
  $('body').addClass('modal-open');
  // <<< ADD CHECK >>>
  console.log("Main menu opened. 'How to Play' button exists:", $(".main-menu-modal .btn-main-menu[data-action='how-to-play']").length > 0);
  // <<< END CHECK >>>
});

// Handle clicks on buttons inside the main menu
$('.main-menu-modal .btn-main-menu').on('click', function() {
  const action = $(this).data('action');
  
  // <<< MODIFIED: Call Tutorial Module for "how-to-play" >>>
  if (action === 'how-to-play') {
    $('.main-menu-modal').removeClass('active');
    tutorial.startTutorialFlow();
  } else if (action === 'profile') {
    $('.main-menu-modal').removeClass('active');
    $('body').removeClass('modal-open');
    setTimeout(() => {
      $('.profile-modal').addClass('active');
      $('body').addClass('modal-open');
      if ($('body').hasClass('modal-open')) {
        updateBestTime();
      }
    }, 100);
  } else if (action === 'settings') {
    showMenuView("settings");
  } else if (action === 'menu-back') {
    showMenuView("main");
  }
});

// Add backdrop click handler specifically for the main menu modal
$('.main-menu-modal .backdrop').on('click', function() {
  $(this).closest('.modal').removeClass('active');
  $('body').removeClass('modal-open');
});

// --- END Main Menu Modal Logic ---

// Profile modal
$('.player.player--2, .profile-modal .backdrop').on('click', function(e) {
  e.stopPropagation();
  $('body').toggleClass('modal-open');
  
  if($('body').hasClass('modal-open')) {
    updateBestTime();
  }
});

$('.profile-modal .wrapper').on('click', '.card', function(e) {
  if($(this)[0].hasAttribute('data-level')) {
    level = $(this).attr('data-level');
    gameMode = 'regular';
    $(this).closest('.modal').find('.modal-close').click();
    //$(this).closest('.row').find('.card').removeClass('selected');
    //$(this).addClass('selected');

    $('body')
      .removeClass('mode-random mode-regular modal-open')
      .addClass('mode-'+gameMode);
    startAnim();
  }
});

function updateBestTime() {
  var bestTimeAsSeconds,
      bestTimeIndex;
  var worstTimeAsSeconds,
      worstTimeIndex;

  // Initialize bestTimeAsSeconds to Infinity to ensure first valid time is always lower
  bestTimeAsSeconds = Infinity; 
  bestTimeIndex = -1; // Initialize bestTimeIndex to an invalid value

  // Initialize worstTime with the first valid time found
  worstTimeAsSeconds = undefined;
  worstTimeIndex = -1;
  
  $(Object.keys(levelsArray)).each(function(index) {
    var currentLevelKey = 'level' + (index + 1);
    var currentTime = levelsArray[currentLevelKey] ? levelsArray[currentLevelKey].time : null;
    
    // Ensure the level exists and has a time before processing
    if (currentTime !== null && currentTime !== undefined) { 
      var itemTimeAsSeconds = moment.duration('00:' + currentTime).asSeconds();
      
      // Check Best Time (only compare if time is valid)
      if (itemTimeAsSeconds < bestTimeAsSeconds) {
        bestTimeAsSeconds = itemTimeAsSeconds;
        bestTimeIndex = index;
      }

      // Check Worst Time (initialize if undefined, then compare)
      if (worstTimeAsSeconds === undefined || itemTimeAsSeconds > worstTimeAsSeconds) {
        worstTimeAsSeconds = itemTimeAsSeconds;
        worstTimeIndex = index;
      }
    }
  });

  // Update Best Time display
  if (bestTimeIndex !== -1) { // Check if a valid best time was found
    $('.profile-modal .best-time').attr('data-level', bestTimeIndex + 1);
    $('.profile-modal .best-time h1').html(levelsArray['level' + (bestTimeIndex + 1)].time);
    $('.profile-modal .best-time .time-level').html('Level ' + (bestTimeIndex + 1));
  } else {
    $('.profile-modal .best-time').removeAttr('data-level');
    $('.profile-modal .best-time h1').html('None');
    $('.profile-modal .best-time .time-level').html('');
  }

  // Update Worst Time display
  if (worstTimeIndex !== -1) { // Check if a valid worst time was found
    $('.profile-modal .worst-time').attr('data-level', worstTimeIndex + 1);
    $('.profile-modal .worst-time h1').html(levelsArray['level' + (worstTimeIndex + 1)].time);
    $('.profile-modal .worst-time .time-level').html('Level ' + (worstTimeIndex + 1));
  } else {
    $('.profile-modal .worst-time').removeAttr('data-level');
    $('.profile-modal .worst-time h1').html('None');
    $('.profile-modal .worst-time .time-level').html('');
  }
}
// END Profile modal

// Mode Modal
// Include .multiplayer footer button in this selector
$('.level, .random, .multiplayer, .rts, .mode-modal .backdrop').on('click', function(e) {
  if ($(this).hasClass('mode-modal') || $(this).hasClass('backdrop')) {
    $('body').removeClass('modal-open');
    return;
  }
  e.stopPropagation();
  e.stopImmediatePropagation();
  const view = $(this).hasClass('level') ? 'mode-regular'
    : $(this).hasClass('random') ? 'mode-random'
    : $(this).hasClass('multiplayer') ? 'mode-multiplayer'
    : 'main';
  openMainMenu(view);
});

// Update difficulty option handler to match level selection pattern
$('body').on('click', '.difficulty-option', function(e) {
  e.preventDefault();
  e.stopPropagation();
  
  // Update visual selection
  $('.difficulty-option').removeClass('selected');
  $(this).addClass('selected');
  
  // Update bot difficulty setting
  botDifficulty = $(this).data('difficulty');

  $('body').removeClass('modal-open');
  $('.main-menu-modal, .mode-modal').removeClass('active');
  gameMode = 'random';
  
  // Update body classes
  $('body')
    .removeClass('mode-regular mode-multiplayer')
    .addClass('mode-random');
  
  // Start the game using the standard animation
  startAnim();
});

function updateLevelList() {
  var list = $('.list--mode-regular');
  var listWrapper = list.find('ul');

  // Make sure the list wrapper exists
  if (listWrapper.length === 0) {
    list.append('<ul></ul>');
    listWrapper = list.find('ul');
  }

  listWrapper.empty();

  $.each(levelsArray, function(key, value) {
    if (key !== 'level0') {
      var goalMoves = (moment.duration('00:'+value.time).asSeconds() != 0 &&
                      moment.duration('00:'+value.time).asSeconds() < 120) ? 'active' : '';

      var goalTime = (moment.duration('00:'+value.time).asSeconds() != 0 &&
                     moment.duration('00:'+value.time).asSeconds() < 60) ? 'active' : '';
      
      var wonStar = (value.time && value.time !== null) ? 'active' : '';
      
      listWrapper.append(
        '<li class="card btn btn-level" data-level="' + key.split('level')[1] + '">' +
          '<h2 class="level-number">' + key.split('level')[1] + '</h2>' +
          '<span class="level-time">' + value.time + '</span>' +
          '<span class="level-goals">' +
            '<i class="fas fa-star level-goals-won ' + wonStar + '"></i>' +
            '<i class="fas fa-star level-goals-moves ' + goalMoves + '"></i>' +
            '<i class="fas fa-star level-goals-time ' + goalTime + '"></i>' +
          '</span>' +
        '</li>'
      );
    }
  });
  
  // Highlight current level
  listWrapper.find('li[data-level="'+ level +'"]').addClass('selected');
}
// END Mode Modal

// Time modal
$('.time, .time-modal .backdrop').on('click', function(e) {
  e.stopPropagation();
  timeBest = (levelsArray['level' + (level)] !== undefined) ? levelsArray['level' + (level)].time : null;
  $('body').toggleClass('modal-open');
  
  if(timeBest === null) {
    $('.time-modal .best-time h1').html('None');
  } else {
    $('.time-modal .best-time h1').html(timeBest);
  }
});

$('.time-modal .wrapper').on('click', '.card', function(e) {
  if($(this).hasClass('restart')) {
    $('body').removeClass('modal-open');
    // Preserve current map in random mode
    if (gameMode === 'random') {
      var urlParams = new URLSearchParams(window.location.search);
      var map = urlParams.get('map');
      if (map) {
        // Preserve the current map
        setDots();
        buildMapFromString(map);
        dots = $(".dot");
        currentPlayer = "player--2";
        $(".field").addClass(currentPlayer);
        $(".end").remove();
        // <<< FIX: Use imported timer functions >>>
        showTimer(); 
        resetTimer();
        startTimer();
        updatePlayerScoresUI(); // <<< Update scores here
        return;
      }
    }
    // Update URL to current level for regular mode
    if (gameMode === 'regular') {
      var newUrl = window.location.pathname + '?mode=regular&level=' + level;
      window.history.replaceState({}, document.title, newUrl);
    }
    startAnim();
  }
});
// END Time modal

// Intro
var sound = new Howl({
  src: [
    "./sounds/submarine-sonar.mp3"
  ]
});

// Add sound for dot increment
var incrementSound = new Howl({
  src: [
    "./sounds/submarine-sonar-38243-once.mp3"
  ],
  volume: 0.25 // Adjust volume as needed
});

var blobSplat = new Howl({
  src: [
    "./sounds/blob-splat.mp3"
  ],
  volume: 0.55
});

var logoRings = CSSRulePlugin.getRule(".intro .logo:before");

$(".intro").on("click", ".logo:not(.disabled)", function() {
  $(this).addClass("disabled");
  sound.play();
  logoAnim();
});

function logoAnim() {
  gsap.to(logoRings, 6, {
    cssRule: {
      boxShadow:
          "0 0 0 10rem rgba(127, 127, 127,0), 0 0 0 20rem rgba(127, 127, 127,0), 0 0 0 30rem rgba(127, 127, 127,0), 0 0 0 40rem rgba(127, 127, 127,0), 0 0 0 1.25rem rgba(127, 127, 127,0.4), 0 0 0 2.5rem rgba(127, 127, 127,0.2), 0 0 0 3.75rem rgba(127, 127, 127,0.1), 0 0 0 5rem rgba(127, 127, 127,0.05)"
    },
    startAt: {
      cssRule: {
        boxShadow:
            "0 0 0 1.25rem rgba(127, 127, 127,0.4), 0 0 0 2.5rem rgba(127, 127, 127,0.2), 0 0 0 3.75rem rgba(127, 127, 127,0.1), 0 0 0 5rem rgba(127, 127, 127,0.05)"
      }
    },
    ease: Expo.easeOut,
    onComplete: endLogoAnim
  });
}

function endLogoAnim() {
  $(".logo").removeClass("disabled");
}

function signinAnim() {
  gsap.to($('.logo-typo, .intro .btn-signin, .madeby'), 1, {
    autoAlpha: 0,
    ease: Expo.easeIn
  });
  gsap.to($('.logo-wrapper'), 4, {
    css:{backgroundColor:'rgba(127,127,127,0)'},
    ease: Expo.easeIn,
    delay: 2
  });
  gsap.to(logoRings, 3, {
    cssRule: {
      boxShadow:
          "0 0 0 0.01rem rgba(127, 127, 127,0.4), 0 0 0 0.01rem rgba(127, 127, 127,0.2), 0 0 0 0.01rem rgba(127, 127, 127,0.1), 0 0 0 0.01rem rgba(127, 127, 127,0.05)"
    },
    startAt: {
      cssRule: {
        boxShadow:
            "0 0 0 1.25rem rgba(127, 127, 127,0.4), 0 0 0 2.5rem rgba(127, 127, 127,0.2), 0 0 0 3.75rem rgba(127, 127, 127,0.1), 0 0 0 5rem rgba(127, 127, 127,0.05)"
      }
    },
    ease: Expo.easeOut
  });
  gsap.to($('.logo'), 1, {
    autoAlpha: 0,
    scale: 0,
    ease: Expo.easeIn,
    delay: 0.5
  });
  gsap.to('.intro', {duration: 0.3, delay:2, autoAlpha: 0, 
    onComplete: function() {
      var urlParams = new URLSearchParams(window.location.search);
      var mode = urlParams.get('mode');
      var map = urlParams.get('map');

      if (mode === 'random') {
        gameMode = 'random'; 
        if (map) {
          console.log("Intro onComplete: mode=random with map. Relying on document.ready map load.");
          $('body').removeClass('mode-regular mode-multiplayer').addClass('mode-random');
          $('.main-menu-modal [data-mode]').removeClass('selected');
          $('.main-menu-modal [data-mode="random"]').addClass('selected');
        } else {
          startAnim(); // New random game
        }
      } else if (mode === 'multiplayer') {
        gameMode = 'multiplayer'; 
        checkUrlParameters(); // This will call startAnim() internally for MP and open modal
        console.log("Intro onComplete: mode=multiplayer. Called checkUrlParameters.");
      } else if (mode === 'realTimeResource') {
        gameMode = 'realTimeResource';
        $('body')
          .removeClass('mode-regular mode-multiplayer mode-random')
          .addClass('mode-realTimeResource');
        $('.main-menu-modal [data-mode]').removeClass('selected');
        $('.main-menu-modal [data-mode="realTimeResource"]').addClass('selected');
        startAnim();
        console.log("Intro onComplete: mode=realTimeResource from URL. Started RTS mode.");
      } else if (mode === 'regular') { // Explicit regular mode from URL
        gameMode = 'regular'; 
        checkUrlParameters(); // Sets up level if present
        startAnim();
        console.log("Intro onComplete: mode=regular from URL. Called checkUrlParameters & startAnim.");
      } else if (hasPlayedBefore) { // Returning player, no specific mode in URL
        gameMode = 'regular'; // Default for returning player
        checkUrlParameters(); // To pick up any stored level
        startAnim(); // Start default regular game
        console.log("Intro onComplete: Returning player, no URL mode. Defaulted to regular. Called checkUrlParameters & startAnim.");
      }
      // If !hasPlayedBefore and no mode in URL, nothing happens here.
      // tutorial.checkStartTutorial() at the end of script.js will handle it.
    }
  });
}

$('.intro').on('click', '.btn-signin:not(.disabled)', function() {
  $(this).addClass('disabled');
  signinAnim();
});

// Startup
var firstrun = true;
function startup() {
  gsap.set($('.logo-wrapper'), {css:{backgroundColor:'rgba(127,127,127,0.02)'}});
  if(firstrun === false) {
    gsap.to($('.intro .logo'), 4, {autoAlpha: 1, scale: 1, immediateRender: true, ease: Expo.easeOut, startAt:{autoAlpha: 0.01, scale: 0.01}});
  }
  firstrun = false;
  gsap.to($('.logo-typo'), 4, {autoAlpha: 1, delay: 2, immediateRender: true, ease: Expo.easeOut, startAt:{autoAlpha: 0}});
  gsap.to($('.btn-signin'), 4, {autoAlpha: 1, delay: 4, immediateRender: true, ease: Expo.easeOut, startAt:{autoAlpha: 0}});
  gsap.to($('.madeby'), 4, {y:0, autoAlpha: 1, delay: 3, immediateRender: true, ease: Expo.easeOut, startAt:{y:40, autoAlpha: 0}});
  logoAnim();
  $('.btn-signin').removeClass('disabled');
}
startup();

// Rippled click effect
$('.intro').on('click', '.rippled:not(.disabled)', function(e) {
  e.stopPropagation();
  $(this).append('<div class="ripple ripple-animate"></div>');
  var ripple = $(this).find('.ripple').last();
  ripple.removeClass('ripple-animate');
  var x = parseInt(e.pageX - $(this).offset().left) - (ripple.width() / 2);
  var y = parseInt(e.pageY - $(this).offset().top) - (ripple.height() / 2);
  ripple.css({
    top: y,
    left: x
  }).addClass('ripple-animate');
  setTimeout(function() {
    ripple.remove();
  }, 1000);
});
// END Intro

// Check URL parameters on page load
$(document).ready(function() {
  var urlParams = new URLSearchParams(window.location.search);
  var mode = urlParams.get('mode');
  var map = urlParams.get('map');
  var difficulty = urlParams.get('difficulty'); // Capture difficulty from URL
  console.log("-------------------------------> mode:", mode);
  
  // This is likely the area around the original line 1486 mentioned in the error
  if (mode === 'random' && map) {
    gameMode = 'random';
    botDifficulty = difficulty || 'random'; 
    
    $('body')
      .removeClass('mode-regular mode-multiplayer') 
      .addClass('mode-random');
    
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $('.main-menu-modal [data-mode="random"]').addClass('selected');
    $('.difficulty-option').removeClass('selected');
    $('.difficulty-option[data-difficulty="' + botDifficulty + '"]').addClass('selected');

    updatePlayerIcons(); // <<< ENSURE THIS CALL IS PRESENT HERE
    
    setDots();
    buildMapFromString(map);
    dots = $(".dot");
    currentPlayer = "player--2"; 
    $(".field").addClass(currentPlayer);
    showTimer();
    resetTimer();
    startTimer();
    updatePlayerScoresUI(); 
  } else if (mode === 'realTimeResource') {
    gameMode = 'realTimeResource';
    $('body')
      .removeClass('mode-regular mode-multiplayer mode-random')
      .addClass('mode-realTimeResource');
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $('.main-menu-modal [data-mode="realTimeResource"]').addClass('selected');
    startAnim();
  } else {
    // Tutorial.checkStartTutorial() handles other startup scenarios including calling startAnim if needed
  }
  // ... (rest of document.ready, including the tutorial.initialize block) ...
});

// Add a function to check URL parameters on page load
function checkUrlParameters() {
  // Only run this entire check once on initial page load
  if (initialUrlCheckComplete) {
    return;
  }
  initialUrlCheckComplete = true;

  var urlParams = new URLSearchParams(window.location.search);
  var mode = urlParams.get('mode');
  var difficultyParam = urlParams.get('difficulty'); // Get difficulty from URL
  
  if (mode) {
    // Set the game mode based on URL
    gameMode = mode;
    $('body')
      .removeClass('mode-random mode-regular mode-multiplayer')
      .addClass('mode-'+gameMode);
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $('.main-menu-modal [data-mode="' + gameMode + '"]').addClass('selected');
    console.log("-------------------------------> set selected.");
    
    if (mode === 'regular') {
      // Check for level parameter
      var levelParam = urlParams.get('level');
      if (levelParam) {
        level = parseInt(levelParam);
        $('.level-value').html(level);
      }
    } 
    else if (mode === 'random') {
      // Set botDifficulty from URL param, or default to 'random' if not present
      botDifficulty = difficultyParam || 'random'; 
      console.log("checkUrlParameters: Random mode detected, botDifficulty set to:", botDifficulty);
      // Update UI for difficulty selection in modal
      $('.difficulty-option').removeClass('selected');
      $('.difficulty-option[data-difficulty="' + botDifficulty + '"]').addClass('selected');
      updatePlayerIcons(); // <<< CALL HERE
    }
    else if (mode === 'multiplayer') {
      // Only run this direct-load-to-multiplayer logic if we are not already connecting/connected
      if (connectionState === CONNECTION_STATES.DISCONNECTED) {
        isHost = true; // Assume hosting if loading directly into MP mode
        
        openMainMenu('mode-multiplayer');
         
        // Deprecated joining via URL ID - The UI for starting/joining a multiplayer game 
        // is now primarily driven by user interaction with the modal after 
        // 'multiplayer' mode is selected. No specific code for joining by URL ID remains here.
        
        // <<< ADDED: Ensure game UI is initialized for multiplayer mode from URL >>>
        startAnim(); 
        console.log("checkUrlParameters: Multiplayer mode from URL, called startAnim(). Modal should be open.");
      }
    }
  }
} 

// Add a share button to the UI for random maps
function addShareButton() {
  if ($('.share-map-btn').length === 0) {
    $('footer').append('<div class="share-map random"><i class="fas fa-share-alt"></i></div>');
    
    // Add click handler for the share button
    $('.share-map').on('click', function() {
      // Generate the current map URL
      var mapString = generateMapString();
      var shareUrl = window.location.origin + window.location.pathname + '?mode=random&map=' + mapString;
      
      // Try to use the Web Share API if available
      if (navigator.share) {
        navigator.share({
          title: 'Dotmination Map',
          text: 'Check out this Dotmination map!',
          url: shareUrl
        }).catch(console.error);
      } else {
        // Fallback: copy to clipboard
        var tempInput = document.createElement('input');
        tempInput.value = shareUrl;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
        
        // Show a notification
        alert('Map URL copied to clipboard!');
      }
    });
  }
}

// Add CSS for the share button
var shareButtonStyle = `
.share-map {
  display: none;
  cursor: pointer;
}

.mode-random .share-map.random {
  display: block;
}
`;

// Add the style to the document
function addShareButtonStyle() {
  var styleElement = document.createElement('style');
  styleElement.textContent = shareButtonStyle;
  document.head.appendChild(styleElement);
}

// Initialize everything on document ready
$(document).ready(function() {
  // Add the share button style
  addShareButtonStyle();
  
  // Add the share button to the UI
  addShareButton();
  
  // Check URL parameters
  checkUrlParameters();
  
  // Add the multiplayer button and options to the modal
  if ($('.main-menu-modal [data-mode="multiplayer"]').length === 0) {
    console.log("Adding multiplayer button to modal");
    var $existingButton = $('.main-menu-modal [data-mode="random"]');
    var buttonClass = $existingButton.attr('class');
    var $newButton = $('<div class="' + buttonClass + '" data-mode="multiplayer"><h1><i class="fas fa-users"></i></h1><p class="text-center">Multiplayer<br></p></div>');
    $existingButton.after($newButton);
    if (gameMode === 'multiplayer') {
      $('.main-menu-modal [data-mode="multiplayer"]').addClass('selected');
    }
  }

  // Add handler for Start Type selection buttons
  $('.btn-start-type').on('click', function(e) {
    e.preventDefault();
    e.stopPropagation();

    // <<< Force cleanup before starting new connection process >>>
    console.log("Forcing cleanup before start type selection...");
    cleanup();
    hasSentGameState = false; // <<< Reset this flag during cleanup
    clearSessionInfo(); // Also clear session info here just in case
 
    multiplayerStartType = $(this).data('start-type');
    console.log("Start type selected:", multiplayerStartType);

    // <<< CLOSE THE MODAL >>>
    $('.main-menu-modal, .mode-modal').removeClass('active');
    $('body').removeClass('modal-open');

    // Set state *after* cleanup and type selection
    isMultiplayer = true;
    gameMode = 'multiplayer';
    
    // Update URL for multiplayer mode
    var newUrl = window.location.pathname + '?mode=multiplayer';
    window.history.replaceState({}, document.title, newUrl);

    // Show overlay immediately, but delay the connection attempt slightly
    showConnectingOverlay(); 
    console.log("Showing connecting overlay, delaying connection start...");

    setTimeout(() => {
        console.log("Attempting startMultiplayerConnection after delay.");
        startMultiplayerConnection(); // This will handle finding slot and setting up host/peer
    }, 100); // 100ms delay
 
    // Update UI: Show Game ID display if HOST (handled inside setupHost)
    // $('.game-id-display').show(); 
  });
});

// Add a function to show waiting overlay
function showWaitingOverlay() {
  console.log("Showing waiting overlay");
  
  // Remove any existing overlay
  $('.waiting-overlay').remove();
  
  // Create the overlay with a placeholder for the game ID
  $('body').append(`
    <div class="waiting-overlay">
      <div class="waiting-card">
        <h2>Waiting for opponent...</h2>
        <p>Share this ID with your opponent:</p>
        <div class="game-id-container">
          <div class="game-id-display" id="overlay-game-id">Generating ID...</div>
          <button class="copy-id-btn">Copy ID</button>
        </div>
        <button class="cancel-waiting-btn">Cancel</button>
      </div>
    </div>
  `);
  
  // Update the game ID when it's available
  function updateGameId() {
    if (peer && peer.id) {
      $('#overlay-game-id').text(peer.id);
    } else {
      setTimeout(updateGameId, 500);
    }
  }
  updateGameId();
  
  // Add click handler for the copy button
  $('.copy-id-btn').on('click', function() {
    const gameId = $('#overlay-game-id').text();
    if (gameId && gameId !== "Generating ID...") {
      navigator.clipboard.writeText(gameId).then(function() {
        // Show feedback
        $('.copy-id-btn').text('Copied!');
        setTimeout(() => {
          $('.copy-id-btn').text('Copy ID');
        }, 2000);
      }).catch(function(err) {
        // Fallback for older browsers
        const tempInput = document.createElement('input');
        tempInput.value = gameId;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
        
        // Show feedback
        $('.copy-id-btn').text('Copied!');
        setTimeout(() => {
          $('.copy-id-btn').text('Copy ID');
        }, 2000);
      });
    }
  });
  
  // Add click handler for the cancel button
  $('.cancel-waiting-btn').on('click', function() {
    if (confirm('Are you sure you want to cancel waiting for an opponent?')) {
      resetMultiplayer();
      
      // Reset the game mode to regular
      gameMode = 'regular';
      
      // Update the UI to reflect the mode change - ensure proper selection in modal
      $('.main-menu-modal [data-mode]').removeClass('selected');
      $('.main-menu-modal [data-mode="regular"]').addClass('selected');
      
      // Update body classes
      $('body')
        .removeClass('mode-multiplayer')
        .addClass('mode-regular');
      
      // Update URL
      var newUrl = window.location.pathname + '?mode=regular';
      window.history.replaceState({}, document.title, newUrl);
      
      // Start a new single player game
      startAnim();
    }
  });
}

// Add function to start multiplayer animation
function startMultiplayerAnim() {
  console.log("Starting multiplayer game with empty field");
  
  // Reset game state
  moveAmount = 0;
  currentPlayer = "player--1"; // Always start with player 1
  
  // Clear the field
  $(".end").remove();
  
  // Remove all stage and player classes from dots
  $(".dot").each(function() {
    $(this)
      .removeClass(function(index, className) {
        return (className.match(/(^|\s)stage--\S+/g) || []).join(' ');
      })
      .removeClass(function(index, className) {
        return (className.match(/(^|\s)player--\S+/g) || []).join(' ');
      })
      .removeClass(playerClassClear)
      .attr("data-increment", "0");
  });
  
  // Initialize the field
  dots = $(".dot");
  
  // Set the current player
  $(".field").removeClass(playerClassClear).addClass(currentPlayer);
  
  // Set the color
  TweenMax.to("html", 0, {"--color-current": 'var(--color-1)'});
  
  // Show the field
  show();
  reset();
  start();
  
  // Set waiting state based on player
  waitingForMove = !isHost;
}

// Add back the player indicator functions
function updatePlayerIndicators() {
  // Remove any existing indicators and icons
  $('.player-indicator').remove();
  $('.players .player i').removeClass('fa-robot fa-user-secret');

  if (isMultiplayer) {
    // Multiplayer: Both icons are fa-user-secret
    $('.player.player--1 i').addClass('fa-user-secret');
    $('.player.player--2 i').addClass('fa-user-secret');
  } else {
    // Single Player: Set standard icons
    $('.player.player--1 i').addClass('fa-robot');
    $('.player.player--2 i').addClass('fa-user-secret');
  }
}

function updateTurnIndicator() {
  // Remove any existing indicators
  $('.turn-indicator').remove();
  // Remove existing current class from player icons
  $('.players .player').removeClass('current');

  // Only add the indicator if in multiplayer mode
  if (isMultiplayer) {
    // Add the turn indicator text
    if ((currentPlayer === 'player--1' && isHost) || (currentPlayer === 'player--2' && !isHost)) {
      // It's your turn
      $('header').append('<div class="turn-indicator your-turn">Your Turn</div>');
    } else {
      // It's opponent's turn
      $('header').append('<div class="turn-indicator opponent-turn">Opponent\'s Turn</div>');
    }

    // Add 'current' class to the active player icon
    if (currentPlayer === 'player--1') {
      $('.players .player.player--1').addClass('current');
    } else {
      $('.players .player.player--2').addClass('current');
    }
  }
}

// Modify the checkGameEnd function to handle multiplayer
function checkGameEnd() {
  console.log('checkGameEnd called, isMultiplayer:', isMultiplayer);
  
  if (isMultiplayer) {
    // Check if any dots can still be clicked
    var gameEnded = true;
    $(".dot").each(function() {
      if (!$(this).is('[class*="player--"]') || $(this).hasClass(currentPlayer)) {
        if (!$(this).is('[class*="stage--"' + (stage_amount - 1) + '"]')) {
          gameEnded = false;
          return false;
        }
      }
    });
    
    if (gameEnded) {
      console.log('Multiplayer game ended, winner:', currentPlayer);
    }
    
    return gameEnded;
  } else {
    // Existing single-player game end check
    return $(".dot[class*='stage--" + (stage_amount - 1) + "']").length == dots.length;
  }
}

// Update the click handler to only update URL with current level
$("body").on("click", ".end:not(.player--1)", function(e) {
  if (!$(e.target).closest('.retry, .new-map').length) {
    // Update URL with current level (already incremented)
    var newUrl = window.location.pathname + '?mode=regular&level=' + level;
    window.history.replaceState({}, document.title, newUrl);
    startAnim();
  }
});

// Add this new function for automatic multiplayer connection
async function startMultiplayerConnection() { // Added async
  // Note: isHost is determined *by* findAvailableSlot now
  console.log("startMultiplayerConnection called. Desired startType:", multiplayerStartType); 
   
  connectionState = CONNECTION_STATES.CONNECTING;
   
  try { // Wrapped in try-catch for better error handling during setup
    const slot = await findAvailableSlot(multiplayerStartType); // findAvailableSlot is already async
    if (!slot) {
      updateConnectingOverlay("No available game slots for type '" + multiplayerStartType + "'. Please try again.");
      showRetryButton();
      connectionState = CONNECTION_STATES.DISCONNECTED;
      return;
    }

    console.log('slot.role:', slot.role);
    if (slot.role === 'peer') {
      await setupPeer(slot.slotNumber); // Added await
    } else {
      await setupHost(slot.slotNumber); // Added await
    }
  } catch (error) {
    console.error("Error during multiplayer connection setup:", error);
    updateConnectingOverlay(`Connection setup failed: ${error.message}. Please retry.`);
    showRetryButton();
    connectionState = CONNECTION_STATES.DISCONNECTED;
    cleanup(); // Ensure cleanup on setup failure
    clearSessionInfo();
  }
}

async function checkPeerAvailability(id) {
  return new Promise((resolve) => {
    const tempPeer = new Peer(id, { host: "0.peerjs.com", port: 443, secure: true });

    const timeout = setTimeout(() => {
      tempPeer.destroy();
      resolve(false); // Timeout, assume ID is taken
    }, 2000);

    tempPeer.on("open", () => {
      // Successfully created peer with this ID
      clearTimeout(timeout);
      tempPeer.destroy();
      resolve(true); // ID is available
    });

    tempPeer.on("error", (err) => {
      clearTimeout(timeout);
      tempPeer.destroy();
      // Check specifically for unavailable ID error
      if (err.type === 'unavailable-id') {
        resolve(false); // ID is taken
      } else {
        // For other errors (network, etc), assume ID might be available
        resolve(true);
      }
    });
  });
}

async function findAvailableSlot(desiredStartType) { // <<< Accept desiredStartType
  updateConnectingOverlay("Searching for '" + desiredStartType + "' game slots...");

  // First try to reconnect to previous session
  const previousSession = getSessionInfo();
  if (previousSession) {
    // Check if previous session matches desired start type
    if (previousSession.startType === desiredStartType) {
      const slotNumber = previousSession.slotNumber;
      const hostId = `dot-host-${desiredStartType}-${slotNumber}`;
      const peerId = `dot-peer-${desiredStartType}-${slotNumber}`;

      // Verify if the previous slot is still valid for the desired type
      if (previousSession.role === 'host') {
        const hostAvailable = await checkPeerAvailability(hostId);
        if (hostAvailable) {
          console.log(`Reconnecting as host for type ${desiredStartType} in slot ${slotNumber}`);
          return { slotNumber: slotNumber, role: 'host' }; // Start type is implicitly matched
        }
      } else { // Previous role was peer
        const hostExists = !(await checkPeerAvailability(hostId)); // Check if HOST for desired type exists
        if (hostExists) { 
          const peerAvailable = await checkPeerAvailability(peerId); // Check if PEER ID for desired type is free
          if (peerAvailable) {
            console.log(`Reconnecting as peer for type ${desiredStartType} in slot ${slotNumber}`);
            return { slotNumber: slotNumber, role: 'peer' }; // Start type is implicitly matched
          }
        }
      }
      // If previous session slot is not valid, clear the session
      clearSessionInfo();
    }
  }

  // If no valid previous session, search for new slot
  for (let i = 1; i <= MAX_LOBBIES; i++) {
    const hostId = `dot-host-${desiredStartType}-${i}`; // ID for host with desired type
    const peerId = `dot-peer-${desiredStartType}-${i}`; // ID for peer with desired type
    
    // Check if a host for the desired type already exists
    const hostAvailable = await checkPeerAvailability(hostId);
    
    if (hostAvailable) {
      // No host for this type exists, we can become the host
      console.log(`No host found for type ${desiredStartType} in slot ${i}, becoming host`);
      return { slotNumber: i, role: 'host' };
    } else {
      // A host for this type exists, try to become a peer
      console.log(`Host found for type ${desiredStartType} in slot ${i}, attempting to become peer`);
      const peerAvailable = await checkPeerAvailability(peerId);
      if (peerAvailable) {
        return { slotNumber: i, role: 'peer' };
      }
    }
  }

  return null; // No slots available
}

async function setupPeer(slotNumber) { // Added async
  cleanup();
  isHost = false;
  isMultiplayer = true;
  // Generate ID based on the chosen start type
  sessionID = `dot-peer-${multiplayerStartType}-${slotNumber}`; 
  let iceServersConfig;
  let fetchSuccess = false;

  try {
    updateConnectingOverlay("Fetching network configuration...");
    const response = await fetch("https://dotmination-turn-proxy.odd-bird-4c2c.workers.dev");
    if (!response.ok) {
      throw new Error(`Metered.ca API Error: ${response.status} ${response.statusText}`);
    }
    iceServersConfig = await response.json(); // This is the array of ICE server objects
    console.log("Fetched ICE Servers from Metered.ca:", iceServersConfig);
    fetchSuccess = true;
  } catch (error) {
    console.error("Failed to fetch ICE servers from Metered.ca:", error);
    updateConnectingOverlay(`Network config error. Using fallback.`);
    // Fallback to default STUN servers if Metered.ca fails
    iceServersConfig = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
  }

  peer = new Peer(sessionID, {
    host: "0.peerjs.com",
    port: 443,
    secure: true,
    config: {
      'iceServers': iceServersConfig // Use fetched or fallback
    }
  });

  peer.on("open", function() {
    // if (hasConnected) return; // This hasConnected check might be too early or managed by cleanup()

    console.log("Peer PeerJS object opened with ID:", sessionID);
    updateConnectingOverlay(`Connecting to host...`);
    if (!fetchSuccess) {
        console.warn("Using fallback STUN servers for P2P connection.");
    }

    // Connect to the host ID matching the chosen start type
    const hostID = `dot-host-${multiplayerStartType}-${slotNumber}`; 
    conn = peer.connect(hostID);

    conn.on("open", function() {
      if (hasConnected) return;
      hasConnected = true;
      connectionState = CONNECTION_STATES.CONNECTED;
      // Remove the overlay immediately upon successful connection
      $('.connecting-overlay').remove(); 
      saveSessionInfo(slotNumber, 'peer');
      setupConnectionHandlers(conn);
      // Send ready signal to host
      conn.send({ type: 'ready' });
    });
    // It's good practice to also handle conn.on('error') here if specific error handling for data connection is needed
  });

  peer.on("error", function(err) {
    console.error("Peer peer error:", err);
    updateConnectingOverlay(`Connection error: ${err.type}. Please retry.`);
    cleanup();
    clearSessionInfo();
    showRetryButton();
  });
}

async function setupHost(slotNumber) { // Added async
  cleanup();
  isHost = true;
  isMultiplayer = true;
  // Generate ID based on the chosen start type
  sessionID = `dot-host-${multiplayerStartType}-${slotNumber}`; 
  let iceServersConfig;
  let fetchSuccess = false;

  try {
    updateConnectingOverlay("Fetching network configuration...");
    const response = await fetch("https://dotmination-turn-proxy.odd-bird-4c2c.workers.dev/");
    if (!response.ok) {
      throw new Error(`Metered.ca API Error: ${response.status} ${response.statusText}`);
    }
    iceServersConfig = await response.json();
    console.log("Fetched ICE Servers from Metered.ca:", iceServersConfig);
    fetchSuccess = true;
  } catch (error) {
    console.error("Failed to fetch ICE servers from Metered.ca:", error);
    updateConnectingOverlay(`Network config error. Using fallback.`);
    iceServersConfig = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
  }

  peer = new Peer(sessionID, {
    host: "0.peerjs.com",
    port: 443,
    secure: true,
    config: {
      'iceServers': iceServersConfig // Use fetched or fallback
    }
  });

  peer.on("open", function() {
    // if (hasConnected) return; // This hasConnected check might be too early

    console.log("Host PeerJS object opened with ID:", sessionID);
    updateConnectingOverlay(`Waiting for opponent to join...`);
     if (!fetchSuccess) {
        console.warn("Using fallback STUN servers for P2P connection.");
    }
    saveSessionInfo(slotNumber, 'host');

    peer.on("connection", function(newConn) {
      console.log("Received connection attempt");
      
      if (conn) {
        console.log("Already connected, rejecting new connection");
        newConn.close();
      } else {
        conn = newConn;
        conn.on("open", function() {
          if (hasConnected) return;
          hasConnected = true;
          connectionState = CONNECTION_STATES.CONNECTED;
          // Consider removing overlay here for host too, or in setupConnectionHandlers
          setupConnectionHandlers(conn);
        });
      }
    });
  });

  peer.on("error", function(err) {
    console.error("Host peer error:", err);
    updateConnectingOverlay(`Connection error: ${err.type}. Please retry.`);
    cleanup();
    clearSessionInfo();
    showRetryButton();
  });
}

function cleanup() {
  if (conn) {
    conn.close();
    conn = null;
  }
  if (peer) {
    peer.destroy();
    peer = null;
  }
  hasConnected = false;
  connectionState = CONNECTION_STATES.DISCONNECTED;
}

// Add window unload handler
window.addEventListener('beforeunload', () => {
  // Don't clear session info on page reload
  cleanup();
});

// Add handleOpponentMove function
function handleOpponentMove(dotIndex) {
  console.log("Handling opponent move at index:", dotIndex);
  
  // Set flag to indicate we are processing an opponent move
  processingOpponentMove = true;

  // Determine which player's move this is. 
  // If we received a move, it MUST be the *other* player.
  const actingPlayer = isHost ? playerArray[1] : playerArray[0]; 
  console.log(`Processing move for opponent actingPlayer: ${actingPlayer}`);

  // Find the dot that was clicked
  const clickedDot = $(".dot").eq(dotIndex);
  
  if (clickedDot.length && !clickedDot.closest(".field").hasClass("animating") &&
      (clickedDot.hasClass(actingPlayer) || !clickedDot.is('[class*="player--"]'))) {
    
    // Apply the opponent's move
    clickedDot.closest(".field").addClass("animating");
    clickedDot
      .attr("data-increment", parseInt(clickedDot.attr("data-increment")) + 1)
      .addClass("increment");
      
    // Process the move, passing the correct acting player
    incrementDotStage(clickedDot, actingPlayer);
  }
}

function setupConnectionHandlers(connection) {
  console.log("Setting up connection handlers. isMultiplayer:", isMultiplayer, "isHost:", isHost);
  
  conn = connection;
  initialSyncComplete = false; // Reset sync flag on new connection setup

  conn.on("open", function() {
    console.log("Connection opened. isMultiplayer:", isMultiplayer);
    connectionState = CONNECTION_STATES.CONNECTED;
    hasConnected = true;

    // Reset hasSentGameState flag when connection is re-established
    hasSentGameState = false;

    // Remove connecting overlay when connection is established (initial or reconnect)
    $('.connecting-overlay').remove();

    // If we're the peer, send ready signal immediately
    if (!isHost) {
      console.log("Peer sending initial ready signal");
      conn.send({ type: 'ready' });
    }
  });

  conn.on("data", function(data) {
    console.log("Received data:", data);

    if (data.type === 'ready') {
      console.log("Received ready signal");

      // Only handle ready signal if we're the host and haven't sent game state yet
      if (isHost && !hasSentGameState) {
        console.log("Host sending initial game state to peer");
        hasSentGameState = true; // Mark that initial state is sent

        // Clear the host's board FIRST using the chosen start type
        clearPlayfield(multiplayerStartType, matchStarter); // <<< PASS THE matchStarter (should be player--1 initially) >>>

        // <<< Re-read global start type just in case >>>
        const currentStartType = multiplayerStartType; 

        // Send complete game state REFLECTING THE CLEARED BOARD and including startType
        conn.send({
          type: 'gameState',
          currentPlayer: currentPlayer, 
          moveAmount: moveAmount,     
          mapString: generateMapString(), 
          fieldClasses: $('.field').attr('class'),
          startType: currentStartType, // <<< Send current start type
          matchStarter: matchStarter // <<< Send who started this match
        });

        // Update host UI after clearing
        updatePlayerScoresUI();

        // Remove connecting overlay for host now that game state is sent
        $('.connecting-overlay').remove();
      }
    }
    // --- Handle Rematch Ready ---
    else if (data.type === 'rematchReady') {
      console.log("Received rematchReady signal");
      if (isHost) {
        peerReadyForRematch = true;
        if (hostReadyForRematch) {
          console.log("Both players ready for rematch (Host perspective on receive)");
          hostInitiateRematchStart(); // Host resets flags inside this function
        }
      } else { // Peer received ready from host
        hostReadyForRematch = true;
        if (peerReadyForRematch) {
          console.log("Both players ready for rematch (Peer perspective on receive)");
          // Peer resets flags HERE and waits for host's gameState
          hostReadyForRematch = false;
          peerReadyForRematch = false;
          initialSyncComplete = false; // Reset sync flag for rematch game state
        }
      }
    }
    // --- End Handle Rematch Ready ---
    else if (data.type === 'gameState') {
      console.log("Received game state");

      // --- FIX: Stop any ongoing client-side simulation before applying authoritative state ---
      console.log("Stopping client-side simulation due to incoming gameState");
      // Use gsap.killTweensOf instead of TweenMax.killDelayedCallsTo
      resetChainProgress();
      // --- End Fix ---

      // <<< ADD EXPLICIT VISUAL RESET >>>
      // Force-remove all player/stage classes before applying authoritative state
      $(".dot").removeClass(function(index, className) {
        return (className.match(/(^|\s)(stage--|player--)\S+/g) || []).join(' ');
      });
      // <<< END EXPLICIT VISUAL RESET >>>

      // Restore game state (handles initial sync, rematch, and post-host-turn sync)
      multiplayerStartType = data.startType; // <<< Store start type from host
      matchStarter = data.matchStarter; // <<< Store who started this match
      currentPlayer = data.currentPlayer;
      moveAmount = data.moveAmount;
      buildMapFromString(data.mapString);
      $('.field').attr('class', data.fieldClasses);

      // Update color variable based on received state
      const currentTurnColor = (currentPlayer === 'player--1') ? 'var(--color-1)' : 'var(--color-2)';
      TweenMax.to("html", 0, {"--color-current": currentTurnColor});
      
      updatePlayerScoresUI(); // Update scores based on received state
      updateTurnIndicator(); // Update turn indicator based on received state

      // <<< ADD TIMER RESET/START FOR CLIENT >>>
      // Peer confirms initial game state received (or rematch state) and resets timer
      if (!isHost && !initialSyncComplete) {
          console.log("Peer confirming initial game state received and resetting timer");
          resetTimer(); 
          startTimer();
          // Send confirmation
          conn.send({ type: 'ready' });
          initialSyncComplete = true; // Set flag after confirming
      }
      // Rematch flags are now reset in 'rematchReady' handler or hostInitiateRematchStart
    }
    else if (data.type === 'move') {
      // Process the move visually (simulation)
      handleOpponentMove(data.dotIndex);
      // DO NOT update moveAmount here anymore. Rely on gameState message.
    }
    // REMOVED 'turnUpdate' handler block
    else if (data.type === 'gameOver') {
      console.log("Received gameOver message", data);
      // Client needs to stop animations and show overlay
      if (!isHost) { 
        console.log("Client stopping animations on game over...");

        // <<< Apply final board state received from host >>>
        // Note: This function also implicitly updates the UI for dots
        if (data.mapString) {
          buildMapFromString(data.mapString);
        } else {
          console.warn("gameOver message received without mapString!");
        }

        // <<< Recalculate scores based on final board state applied above >>>
        updatePlayerScoresUI(); // <<< MOVED HERE

        // Stop any ongoing dot animations
        resetChainProgress();

        // Peer shows overlay based on received winner
        showMultiplayerGameOverOverlay(data.winner);
      }
      // Host also stops local animations if they were running (e.g., simultaneous game end)
      else { 
        console.log("Host stopping animations on game over...");
        resetChainProgress();
        // Host overlay is shown earlier in checkDotmination
      } 
    }
    // Handle mode switch signal from host
    else if (data.type === 'modeSwitch') {
       console.log("Received modeSwitch signal");
       if (!isHost) {
         alert("Host changed game mode. Returning to menu.");
         resetMultiplayerState(); // Includes cleanup and clearing session

         // Reset the game mode to regular
         gameMode = 'regular';

         // Update the UI to reflect the mode change
         $('body').removeClass('mode-multiplayer mode-random').addClass('mode-regular');
         $('.main-menu-modal [data-mode]').removeClass('selected');
         $('.main-menu-modal [data-mode="regular"]').addClass('selected');
         $('.list--mode-regular').show(); // Ensure level list is visible if modal opens
         $('.bot-difficulty, .multiplayer-options, .game-id-display, .game-id-input').hide(); // Hide other mode sections
         $('.turn-indicator').remove(); // Remove turn indicator


         // Update URL
         var newUrl = window.location.pathname + '?mode=regular';
         window.history.replaceState({}, document.title, newUrl);

         // Start a new single player game
         startAnim();
       }
     }

  });

  conn.on("close", function() {
    console.log("Connection closed");
    handleDisconnection(); // Existing disconnection logic
  });
}

// Add this at the top with other state variables
let hasSentGameState = false;

function handleDisconnection() {
  console.log("Handling disconnection");
  
  // If we're in the middle of a game restart, don't handle disconnection
  if (connectionState === CONNECTION_STATES.CONNECTED && !hasConnected) {
    return;
  }
  
  // If we're not in multiplayer mode, don't handle disconnection
  if (!isMultiplayer) {
    return;
  }
  
  // Check if this is a mode switch by looking at the URL
  const urlParams = new URLSearchParams(window.location.search);
  const currentMode = urlParams.get('mode');
  const isModeSwitch = currentMode !== 'multiplayer';
  
  if (isModeSwitch) {
    // This is a mode switch, handle it appropriately
    if (isHost) {
      // Host should show reconnection overlay
      connectionState = CONNECTION_STATES.CONNECTING;
      showConnectingOverlay();
      updateConnectingOverlay("Peer disconnected, awaiting reconnect...");
      
      // Reset connection state for reconnection
      if (conn) {
        conn.close();
        conn = null;
      }
      
      // Keep the host's peer connection active
      if (peer) {
        peer.on("connection", function(newConn) {
          console.log("Received new connection attempt");
          
          conn = newConn;
          conn.on("open", function() {
            if (hasConnected) return;
            hasConnected = true;
            connectionState = CONNECTION_STATES.CONNECTED;
            setupConnectionHandlers(conn);
          });
        });
      }
    } else {
      // Peer should show alert and reset state
      alert("Opponent has left the game. Click OK to return to menu.");
      resetMultiplayerState();
      
      // Reset the game mode to regular
      gameMode = 'regular';
      $('body')
        .removeClass('mode-multiplayer')
        .addClass('mode-regular');
      
      // Update URL
      var newUrl = window.location.pathname + '?mode=regular';
      window.history.replaceState({}, document.title, newUrl);
      
      // Start a new single player game
      startAnim();
    }
  } else {
    // This is likely a page reload, handle reconnection
    console.log("Detected page reload, handling reconnection");
    
    if (isHost) {
      // Host should show reconnection overlay
      connectionState = CONNECTION_STATES.CONNECTING;
      showConnectingOverlay();
      updateConnectingOverlay("Peer disconnected, awaiting reconnect...");
      
      // Reset connection state for reconnection
      if (conn) {
        conn.close();
        conn = null;
      }
      
      // Keep the host's peer connection active
      if (peer) {
        peer.on("connection", function(newConn) {
          console.log("Received new connection attempt");
          
          conn = newConn;
          conn.on("open", function() {
            if (hasConnected) return;
            hasConnected = true;
            connectionState = CONNECTION_STATES.CONNECTED;
            setupConnectionHandlers(conn);
          });
        });
      }
    } else {
      // Peer should attempt to reconnect
      connectionState = CONNECTION_STATES.CONNECTING;
      showConnectingOverlay();
      updateConnectingOverlay("Reconnecting to host...");
      
      // Reset connection state for reconnection
      if (conn) {
        conn.close();
        conn = null;
      }
      
      // Attempt to reconnect using saved session info
      const sessionInfo = getSessionInfo();
      if (sessionInfo) {
        setupPeer(sessionInfo.slotNumber);
      } else {
        // If no session info, show retry button
        showRetryButton();
      }
    }
  }
}

function startMultiplayerGame() {
  console.log("Starting multiplayer game. isMultiplayer:", isMultiplayer, "isHost:", isHost);
  
  // Reset game state
  if (!hasConnected) {
    resetMultiplayerState();
  }
  
  // Clear the field
  clearPlayfield();
  
  // Initialize game elements
  $('.field').addClass('player--1');
  currentPlayer = 'player--1';
  moveAmount = 0;
  
  // Double check multiplayer flag is set
  isMultiplayer = true;
  
  // Set up the initial game state
  fieldPopulateRandom();
  
  // Update turn indicator at game start
  updateTurnIndicator();
  
  // Send initial game state to peer
  if (isHost && conn) {
    console.log("Host sending initial game state");
    hasSentGameState = true;
    conn.send({
      type: 'gameState',
      currentPlayer: currentPlayer,
      moveAmount: moveAmount,
      mapString: generateMapString(),
      fieldClasses: $('.field').attr('class')
    });
  }
  
  // Remove connecting overlay
  $('.connecting-overlay').remove();
}

function resetMultiplayerState() {
  console.log("Resetting multiplayer state");
  
  cleanup();
  clearSessionInfo();
  
  // Remove any overlays
  $('.connecting-overlay, .waiting-overlay').remove();
  
  // Only reset flags if we're not in a game restart
  if (!hasConnected) {
    // Reset flags
    multiplayerStartType = 'blank'; // <<< Reset start type
    isHost = false;
    isMultiplayer = false;
  }
  
  // Show retry button if overlay is still visible
  showRetryButton();
}

function showConnectingOverlay() {
  // Remove any existing overlay
  $('.connecting-overlay').remove();
  
  // Create new connecting overlay with retry button
  $('body').append(`
    <div class="connecting-overlay">
      <div class="connecting-card">
        <h2>Connecting to game...</h2>
        <div class="connecting-status">Searching for available games...</div>
        <div class="connecting-spinner"></div>
        <button class="cancel-connection-btn">Cancel</button>
        <button class="retry-connection-btn" style="display: none;">Retry</button>
      </div>
    </div>
  `);
  
  // Add cancel button handler
  $('.cancel-connection-btn').on('click', function() {
    // Hide connecting overlay
    $('.connecting-overlay').hide();

    // Hide multiplayer options
    $('.multiplayer-start-options').hide();
    
    // <<< ADD MULTIPLAYER STATE RESET >>>
    cleanup(); // Close PeerJS connections
    clearSessionInfo(); // Clear any saved session
    isMultiplayer = false; // Explicitly set to false
    isHost = false; // Explicitly set to false
    multiplayerStartType = 'blank'; // <<< Reset start type
    // <<< END MULTIPLAYER STATE RESET >>>
    
    // Reset game mode to regular and update UI
    gameMode = 'regular';
    $('body')
      .removeClass('mode-random mode-multiplayer')
      .addClass('mode-regular');
    
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $('.main-menu-modal [data-mode="regular"]').addClass('selected');
    openMainMenu('mode-regular');
    
    // Update URL
    window.history.replaceState({}, '', window.location.pathname);
  });

  // Add retry button handler
  $('.retry-connection-btn').on('click', function() {
    $(this).hide();
    $('.connecting-spinner').show();
    startMultiplayerConnection();
  });
}

function showRetryButton() {
  $('.connecting-spinner').hide();
  $('.retry-connection-btn').show();
}

function updateConnectingOverlay(message) {
  $('.connecting-status').text(message);
}

// Add new function to clear playfield
function clearPlayfield(startType, starter) { // <<< Accept starter argument
  console.log(`Clearing playfield. Type: ${startType}, Starter: ${starter}`);
  
  // Remove any existing win/loss overlay
  $(".end.overlay").remove();

  // Reset game state variables
  moveAmount = 0;
  // Set the currentPlayer based on who should start this match
  currentPlayer = starter;

  // Clear the field completely (remove dots)
  $(".field").empty();

  // Reinitialize the field with empty dots based on current layout settings
  setDots(); // Creates new empty dot elements

  // Populate dots for multiplayer start
  dots = $(".dot"); // Update dots reference

  if (startType === 'half-filled') {
    const totalDots = dots.length;
    const midPoint = Math.ceil(totalDots / 2);

    dots.each(function(index) {
      if (index < midPoint) {
        // Assign to player 1
        $(this).addClass("stage--3 player--1");
      } else {
        // Assign to player 2
        $(this).addClass("stage--3 player--2");
      }
    });
  } // If startType is 'blank', we just leave the dots empty after setDots()
  
  // Clear any existing player classes from the field itself and set the current player
  $(".field").removeClass(playerClassClear).addClass(starter); // Use starter here

  // Set the color theme for player 1
  // Set the color theme based on the starting player
  const startColor = (starter === 'player--1') ? 'var(--color-1)' : 'var(--color-2)';
  TweenMax.to("html", 0, { "--color-current": startColor });

  // Initialize timer
  showTimer(); // Show timer element
  resetTimer(); // Reset timer value
  startTimer(); // Start timer ticking

  // Update scores (should reflect new population), turn indicator, and player icons
  updatePlayerScoresUI();
  updateTurnIndicator();
  updatePlayerIndicators(); // <<< ADD THIS CALL
}

// Function to calculate player score based on dot stages
function calculatePlayerScore(playerClass) { // e.g., "player--1"
  let score = 0;
  $(".dot." + playerClass).each(function() {
    score += getStageNumber($(this)); // Ensure this uses the imported getStageNumber
  });
  return score;
}

// Function to update the scores in the UI (ensure this calls the corrected calculatePlayerScore)
function updatePlayerScoresUI() {
  if (gameMode === 'realTimeResource') return;
  const score1 = calculatePlayerScore("player--1");
  const score2 = calculatePlayerScore("player--2");
  $('#player-1-score').text(score1);
  $('#player-2-score').text(score2);
}

// Function to display the multiplayer game over overlay
function showMultiplayerGameOverOverlay(winner) {
  stopTimer(); // Stop timer for both players
  // Determine if the local player won
  const localPlayerWon = (isHost && winner === 'player--1') || (!isHost && winner === 'player--2');
  const message = localPlayerWon ? "You Win!" : "You Lose!";
  const winnerClass = winner; // Use winner directly for overlay class

  // Basic overlay structure - can be enhanced later
  const overlayHtml = `
    <div class="end overlay noselect ${winnerClass}">
      <div class="card">
        <h1>${message}</h1>
        <p class="retry">Rematch <i class="fas fa-undo"></i></p>
        </div>
    </div>
  `;

  // Ensure no duplicates
  $(".end.overlay").remove(); 
  $("body .container").append(overlayHtml);

  // Animation
  TweenMax.fromTo($('.overlay > .card'), 2, { alpha: 0, scale: 0 }, { alpha: 1, scale: 1, ease: Elastic.easeOut });
}

// Add new function for host to start the rematch
function hostInitiateRematchStart() {
  console.log("Host initiating rematch start");
  // Determine who starts the *next* match
  const nextStarter = (matchStarter === playerArray[0]) ? playerArray[1] : playerArray[0];
  matchStarter = nextStarter; // Update the global starter for the *new* match
  console.log(`Rematch will be started by: ${matchStarter}`);

  // Clear playfield, setting currentPlayer based on the new matchStarter
  clearPlayfield(multiplayerStartType, matchStarter); 

  // Send the fresh game state to the peer
  if (conn) {
    conn.send({
      type: 'gameState',
      currentPlayer: currentPlayer, // player--1 after clearPlayfield
      moveAmount: moveAmount,     // 0 after clearPlayfield
      mapString: generateMapString(), 
      fieldClasses: $('.field').attr('class'),
      startType: multiplayerStartType, // <<< Also send startType
      matchStarter: matchStarter // <<< Send the updated starter
    });
  }

  updatePlayerScoresUI(); // Update host score UI
  updateTurnIndicator(); // Show it's host's turn

  // Reset flags
  hostReadyForRematch = false;
  peerReadyForRematch = false;
}

// Add direct click handlers for difficulty buttons
$('.difficulty-option[data-difficulty="random"], .difficulty-option[data-difficulty="smart"]').on('click', function(e) {
  console.log('Direct click handler - Difficulty button clicked:', $(this).data('difficulty'));
  e.preventDefault();
  e.stopPropagation();

  // Update visual selection
  $('.difficulty-option').removeClass('selected');
  $(this).addClass('selected');

  // Update bot difficulty setting
  botDifficulty = $(this).data('difficulty');

  $('body').removeClass('modal-open');
  $('.main-menu-modal, .mode-modal').removeClass('active');
  gameMode = 'random';

  // Update body classes
  $('body')
    .removeClass('mode-regular mode-multiplayer')
    .addClass('mode-random');

  // Update URL with mode and difficulty
  var newUrl = window.location.pathname + '?mode=random&difficulty=' + botDifficulty;
  window.history.replaceState({}, document.title, newUrl);

  // Start the game using the standard animation
  startAnim();
});

// --- REFACTORED MODE MODAL HANDLERS --- 

// Handler specifically for Mode Selection Buttons (Regular, Random, Multiplayer, RealTimeResource)
$('.main-menu-modal .menu-view').on('click', '[data-mode]', function(e) {
  // If we're currently in multiplayer mode, notify the other player before cleaning up
  if (isMultiplayer && conn && $(this).data('mode') !== 'multiplayer') {
    conn.send({ type: 'modeSwitch' });
    setTimeout(() => {
      cleanup();
      clearSessionInfo();
      $('.connecting-overlay, .waiting-overlay').remove();
    }, 100);
  }
  
  const newMode = $(this).data('mode');
  console.log("Mode button clicked (div[data-mode]):", newMode);

  // Stop RTR mode if switching away from it
  if (gameMode === 'realTimeResource' && newMode !== 'realTimeResource') {
    rtrMode.stopRealTimeResourceGame();
  }

  gameMode = newMode;

  if (isMultiplayer && gameMode !== 'multiplayer') { 
    multiplayerStartType = 'blank'; 
    $('.turn-indicator').remove();
    isMultiplayer = false; 
  }

  if (gameMode === 'multiplayer') {
    e.preventDefault();
    e.stopPropagation(); 
    isMultiplayer = true;
    isHost = true; 
    
    var newUrl = window.location.pathname + '?mode=multiplayer';
    window.history.replaceState({}, document.title, newUrl);
    
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $(this).addClass('selected');
    showMenuView('mode-multiplayer');
    
    $('body')
      .removeClass('mode-random mode-regular mode-realTimeResource modal-open') // Added mode-realTimeResource
      .addClass('mode-multiplayer modal-open'); 
    
    return false;
  } else if (gameMode === 'regular') {
    showMenuView('mode-regular');
    $('body')
      .removeClass('mode-random mode-multiplayer mode-realTimeResource')
      .addClass('mode-regular modal-open'); 
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $(this).addClass('selected');
    updateLevelList(); 
    return; 
  } else if (gameMode === 'random') {
    showMenuView('mode-random');
    botDifficulty = 'random'; 
    $('.difficulty-option').removeClass('selected');
    $('.difficulty-option[data-difficulty="random"]').addClass('selected');
    $('body')
      .removeClass('mode-regular mode-multiplayer mode-realTimeResource')
      .addClass('mode-random modal-open'); 
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $(this).addClass('selected');
  } else if (gameMode === 'realTimeResource') {
    $('body')
      .removeClass('mode-regular mode-random mode-multiplayer modal-open')
      .addClass('mode-realTimeResource'); 
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $(this).addClass('selected');
    $('.main-menu-modal, .mode-modal').removeClass('active');
    $('body').removeClass('modal-open');
    var newUrl = window.location.pathname + '?mode=realTimeResource';
    window.history.replaceState({}, document.title, newUrl);
    startAnim(); // This will trigger rtrMode.startRealTimeResourceGame()
    return; 
  }
});

// Handler specifically for Level Selection Buttons
$('.main-menu-modal .menu-view').on('click', '.btn-level', function(e) {
  console.log("Level button clicked:", $(this).data('level'));
  gameMode = 'regular';
  level = $(this).data('level');
  $('.level-value').html(level);
  
  var newUrl = window.location.pathname + '?mode=regular&level=' + level;
  window.history.replaceState({}, document.title, newUrl);
  
  $('.btn-level').removeClass('selected'); 
  $(this).addClass('selected');

  $('body').removeClass('mode-random mode-multiplayer modal-open').addClass('mode-regular');
  $('.main-menu-modal, .mode-modal').removeClass('active');
  
  startAnim();
});

// --- END REFACTORED MODE MODAL HANDLERS ---

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(registration => {
        console.log('Service Worker registered: ', registration);
      })
      .catch(registrationError => {
        console.log('Service Worker registration failed: ', registrationError);
      });
  });
}

// << ADD NEW TUTORIAL EVENT LISTENERS VIA MODULE >>
$(document).ready(function() {
  // <<< REMOVE THIS INITIALIZATION BLOCK >>>
  /*
  tutorial.initialize({
      checkUrlParametersFunc: checkUrlParameters,
      startAnimFunc: startAnim,
      clearPlayfieldFunc: clearPlayfield,
      setDotsFunc: setDots,
      buildMapFromStringFunc: buildMapFromString,
      updatePlayerScoresUIFunc: updatePlayerScoresUI,
      updatePlayerIndicatorsFunc: updatePlayerIndicators,
      getStageNumberFunc: getStageNumber,
      dotsRef: dots, 
      currentPlayerRef: currentPlayer, 
      playerArrayRef: playerArray,
      delayedCallRef: delayedCall, 
      gameModeRef: gameMode, 
      levelRef: level 
  });
  */

  // Keep existing ready handlers...
  var urlParams = new URLSearchParams(window.location.search);
  var mode = urlParams.get('mode');
  var map = urlParams.get('map');
  
  if (mode === 'random' && map) {
    // ... (existing random map load) ...
  } else if (!initialUrlCheckComplete) { // Only call startAnim if not loading map/multiplayer via checkUrlParameters
    // Avoid calling startAnim if checkStartTutorial will handle it or start tutorial
    // startAnim(); // <<< Temporarily disable initial startAnim here
  }

  // Add handlers for tutorial buttons to call module functions
  $('.welcome-tutorial-modal .btn-start-tutorial').on('click', tutorial.handleWelcomeStartClick);
  // Note: Skip/Close logic for welcome modal might be handled internally by startTutorialFlow/checkStartTutorial
  // or might need explicit handlers here if startTutorialFlow doesn't cover it.
  $('.welcome-tutorial-modal .btn-skip-tutorial').on('click', function() {
      // Basic skip logic (similar to original, but calls module end)
      localStorage.setItem('hasPlayedBefore', 'true');
      tutorial.endTutorial(); // Module function to clean up tutorial state/UI
      transitionToLevel1AfterTutorial();
  });
   $('.welcome-tutorial-modal .backdrop, .welcome-tutorial-modal .modal-close').on('click', function() {
       localStorage.setItem('hasPlayedBefore', 'true');
       // Decide what happens on close - maybe just close modal, don't start game?
       $('.welcome-tutorial-modal').removeClass('active');
       $('body').removeClass('modal-open no-backdrop');
  });

  $('#btn-quit-tutorial').on('click', function() {
    console.log("Quit tutorial button clicked. Tutorial object:", tutorial);
    tutorial.quitTutorial(); // This calls tutorial.endTutorial() internally
    transitionToLevel1AfterTutorial();
  });
  $('#btn-start-level-1').on('click', function() {
    console.log("#btn-start-level-1 clicked. Attempting to end tutorial and transition to Level 1.");
    console.log("Tutorial object before calling endTutorial:", tutorial); // <<< ADD THIS LOG
    tutorial.endTutorial(); // Module function to clean up tutorial state/UI
    transitionToLevel1AfterTutorial();
  });

});

// ========================================
// Helper function to transition to Level 1
// ========================================
function transitionToLevel1AfterTutorial() {
    level = 1;
    gameMode = 'regular';
    var newUrl = window.location.pathname + '?mode=regular&level=1';
    window.history.replaceState({}, document.title, newUrl);
    $('body').removeClass('mode-random mode-multiplayer').addClass('mode-regular');
    $('.level-value').html(level);
    $('.main-menu-modal [data-mode]').removeClass('selected');
    $('.main-menu-modal [data-mode="regular"]').addClass('selected');
    startAnim();
    console.log("Transitioned to Level 1 after tutorial action.");
}

// ========================================
// INITIALIZE TUTORIAL MODULE (at end of script)
// ========================================
try {
    tutorial.initialize({
        checkUrlParametersFunc: checkUrlParameters,
        startAnimFunc: startAnim,
        clearPlayfieldFunc: clearPlayfield,
        setDotsFunc: setDots,
        buildMapFromStringFunc: buildMapFromString,
        updatePlayerScoresUIFunc: updatePlayerScoresUI,
        updatePlayerIndicatorsFunc: updatePlayerIndicators,
        getStageNumberFunc: getStageNumber, 
        incrementDotStageFunc: incrementDotStage, 
        animateNextDotFunc: animateNextDot, // Added this reference
        dotsRef: dots, 
        currentPlayerRef: { get value() { return currentPlayer; }, set value(v) { currentPlayer = v; } },
        playerArrayRef: playerArray, 
        delayedCallRef: { get value() { return delayedCall; }, set value(v) { delayedCall = v; } }, 
        gameModeRef: { get value() { return gameMode; }, set value(v) { gameMode = v; } },
        levelRef: { get value() { return level; }, set value(v) { level = v; } },
        botDifficultyRef: { get value() { return botDifficulty; }, set value(v) { botDifficulty = v; } },
        cleanupFunc: cleanup,
        resetMultiplayerStateFunc: resetMultiplayerState
    });

    // Initialize Real-Time Resource Mode Module
    rtrMode.initialize({
        incrementDotStageFunc: incrementDotStage,
        updatePlayerScoresUIFunc: updatePlayerScoresUI, // The rtrMode will use this to update resource display
        getStageNumberFunc: getStageNumber,
        dotsRef: dots, // Pass a function to get current dots, as it can change
        playerArrayRef: playerArray,
        // botGetMove: getBotMove, // For future adaptation of the smart bot
        isEvenFunc: isEven,
        checkDotminationFunc: checkDotmination,
        showTimerFunc: showTimer,
        resetTimerFunc: resetTimer,
        startTimerFunc: startTimer,
        stopTimerFunc: stopTimer,
        animateNextDotFunc: animateNextDot,
        setDotsFunc: setDots,
        buildMapFromStringFunc: buildMapFromString
    });

    // Ensure a game state is loaded BEFORE checking for the tutorial, 
    // unless a specific URL parameter-driven game load has already occurred.
    const urlParamsFinal = new URLSearchParams(window.location.search);
    const modeFromUrlFinal = urlParamsFinal.get('mode');
    const mapFromUrlFinal = urlParamsFinal.get('map');

    let gameAlreadyLoadedOrSpecificMode = 
        (modeFromUrlFinal === 'random' && mapFromUrlFinal) || // Random map from URL has its own setup
        (modeFromUrlFinal === 'multiplayer') || // Multiplayer from URL calls startAnim in checkUrlParameters
        (modeFromUrlFinal === 'realTimeResource') || // <-- Added this line!
        ($('.field .dot').length > 0 && hasPlayedBefore && modeFromUrlFinal !== null); // Game possibly loaded by signinAnim for returning player with specific mode

    if (!gameAlreadyLoadedOrSpecificMode && !window.isTutorialMode) {
        // If no specific game was loaded by URL, and not already in tutorial mode (e.g. from signinAnim error path),
        // and not a returning player whose game might have been started by signinAnim onComplete.
        // This primarily targets the case of a NEW USER (hasPlayedBefore=false) with NO URL parameters.
        console.log("End of script: No specific game loaded by URL and not a returning player with game started. Ensuring default game state via startAnim() before tutorial check.");
        if (gameMode !== 'regular' && gameMode !== 'random') { // If gameMode is something like 'multiplayer' but didn't fully init from URL
            gameMode = 'regular'; // Default to regular
        }
        if (gameMode === 'regular') {
            level = 1; // Ensure level 1 for default regular mode start
        }
        // Ensure body class is set correctly before startAnim if it wasn't by checkUrlParameters
        if (!$('body').hasClass('mode-' + gameMode)) {
            $('body').removeClass('mode-random mode-regular mode-multiplayer').addClass('mode-' + gameMode);
        }
        startAnim(); 
    }

    tutorial.checkStartTutorial(); // Now, check if tutorial should overlay this default game.
} catch (e) {
    console.error("Error initializing or starting tutorial module:", e);
    // Handle error appropriately, maybe show a message to the user
}