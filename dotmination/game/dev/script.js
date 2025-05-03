// v1.0.0
// Singleplayer modes are stable.
// Multiplayer mode is working, peerJS can get restricted by firewalls. Could be extended with TURN server.

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
    dots,
    winW,
    winH,
    dotRows,
    dotCols;

$('body').addClass('mode-'+gameMode);
$('.mode-modal .card[data-mode="' + gameMode + '"]').addClass('selected');

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

// Variables for sound pitch progression
let chainReactionCounter = 0;
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

// << NEW Tutorial State >>
let isTutorialMode = false;
let tutorialStep = 0;
let hasPlayedBefore = localStorage.getItem('hasPlayedBefore') === 'true';
let tutorialTargetDotIndex = -1; // Store index for T2/T3 checks
let tutorialChainStartIndices = []; // Store indices for T4 check
let tutorialStep4Clicked = false; // Flag for step 4 initiation
// << END Tutorial State >>

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
        show();
        reset();
        start();
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
    if (level < 100) {
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

  // << NEW: Prevent clicks during Tutorial Step 5 >>
  if (isTutorialMode && tutorialStep === 5) {
    return; // Ignore clicks on the field when tutorial complete modal is shown
  }
  
  // --- Tutorial Step 4 Check (Log only) ---
  if (isTutorialMode && tutorialStep === 4) {
    if (tutorialChainStartIndices.includes(clickedIndex)) {
      // Player clicked one of the designated starting dots for the chain reaction.
      console.log("Tutorial Step 4: Player clicked a designated chain start dot.");
      tutorialStep4Clicked = true; // <<< SET FLAG HERE
      // Completion is now handled in checkTutorialStepCompletion
    }
  }
  // --- End Tutorial Step 4 Check ---

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
  console.log("nextPlayer called. isTutorialMode:", isTutorialMode, "tutorialStep:", tutorialStep, "isMultiplayer:", isMultiplayer, "gameMode:", gameMode, "currentPlayer:", currentPlayer);

  $(".field").removeClass(currentPlayer);
  if (currentPlayer == playerArray[0]) {
    currentPlayer = playerArray[1];
    TweenMax.to("html", 0, {"--color-current": 'var(--color-2)'});
  } else {
    currentPlayer = playerArray[0];
    TweenMax.to("html", 0, {"--color-current": 'var(--color-1)'});
    if(delayedCall) {
      delayedCall.kill();
    }
    // Only schedule bot action if not in multiplayer and not in tutorial steps 1-4
    if (!isMultiplayer && !(isTutorialMode && tutorialStep < 5)) {
      console.log("Scheduling bot action. isTutorialMode:", isTutorialMode, "tutorialStep:", tutorialStep, "isMultiplayer:", isMultiplayer, "gameMode:", gameMode);
      const botAction = gameMode === 'regular' ? botActionRandom :
                        botDifficulty === 'smart' ? botActionSmarter : botActionRandom;
      delayedCall = gsap.delayedCall(1, botAction);
    }
  }
  $(".field").addClass(currentPlayer);
  moveAmount++;

  // Update turn indicator locally first for responsiveness
  // Only update if not in tutorial steps 1-4 OR if it's multiplayer
  if (isMultiplayer || !isTutorialMode || tutorialStep >= 5) {
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
  }
}
//nextPlayer();

function playerClassClear() {
  return playerArray.join(" ");
}

function incrementDotStage(trgt, player = currentPlayer) {
  const dotIndex = trgt.index();
  let isStage4 = trgt.hasClass('stage--4');

  // --- Tutorial Step 2 Check (before stage changes) ---
  let justCompletedStep2 = false;
  if (isTutorialMode && tutorialStep === 2 && isStage4 && dotIndex === tutorialTargetDotIndex && player === 'player--2') {
    console.log("Tutorial Step 2: Player is about to explode the target dot.");
    justCompletedStep2 = true; // Mark completion, check will happen after animation
    console.log("Tutorial Step 2: justCompletedStep2 flag SET to true"); // <<< ADD LOG
  }
  // --- End Tutorial Step 2 Check ---

  // If a player is explicitly passed (for handling opponent moves),
  // use that player. Otherwise, use the global currentPlayer.
  const effectivePlayer = player;
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
    for (i = 1; i <= stage_amount; i++) {
      var currStage = trgt.is('[class*="stage--' + i + '"]');
      if (currStage && i < stage_amount) {
        trgt
          .removeClass("stage--" + i)
          .removeClass(playerClassClear)
          .addClass("stage--" + (i + 1) + " " + effectivePlayer);
        showIncrementAnimation(trgt, 1, effectivePlayer); // <<< Pass effectivePlayer to animation
        updatePlayerScoresUI(); // <<< Update score here
        animateNextDot();
        return;
      } else if (currStage && i == stage_amount) {
        trgt.removeClass("stage--" + i).removeClass(playerClassClear);
        updatePlayerScoresUI(); // <<< Update score here (dot became neutral)
        if ("vibrate" in navigator) {
          window.navigator.vibrate([10, 10, 10]);
        }
        var k = dots.length;
        while (--k > -1) {
          if (
            Draggable.hitTest(dots[k], trgt.find(".hitarea")) &&
            k != trgt.index()
          ) {
            var neighborDot = $(dots[k]); // Store neighbor dot in variable
            neighborDot.addClass("increment");
            neighborDot.filter(function () {
              $(this).attr(
                "data-increment",
                parseInt($(this).attr("data-increment")) + 1
              );
            });
            showIncrementAnimation(neighborDot, 1, effectivePlayer); 
          }
        }
      }
    }
  }
  animateNextDot(effectivePlayer, justCompletedStep2); // Pass the flag
}

function animateNextDot(player = currentPlayer, tutorialStep2Flag = false) {
  const effectivePlayer = player;

  if ($(".dot.increment").length > 0) {
    var next = $(".dot.increment").eq(0);
    gsap.delayedCall(0.1, incrementDotStage, [next, effectivePlayer]);
  } else {
    $(".field").removeClass("animating");

    if (isTutorialMode) {
        updateTutorialFeedback();
        checkTutorialStepCompletion();
    }

    const shouldCheckState = !isMultiplayer || isHost || !processingOpponentMove;

    if (shouldCheckState) {
       checkDotmination();
    }

    if (processingOpponentMove) {
      processingOpponentMove = false;
    }
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

  gsap.to($animationElement, {
    duration: 0.8,
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
  if (isTutorialMode && tutorialStep < 5) {
    return; 
  }

  const isGameOver = !(moveAmount < 2 || ($(".dot.player--1").length > 0 && $(".dot.player--2").length > 0));

  if (!isMultiplayer) {
    if (!isGameOver) {
      nextPlayer();
    } else {
      stop();
      sound.play();
      
      // Restore Single-Player Overlay Logic 
      if (currentPlayer == "player--2") { // Player 2 (usually User) is the one who made the winning move
          // --- User Wins --- 
          if (gameMode === 'random') {
            // Calculate stars for random mode
            if(moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 120) {
              var goalMoves = 'active';
            } else {
              var goalMoves = '';
            }
    
            if(moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 60) {
              var goalTime = 'active';
            } else {
              var goalTime = '';
            }
            
            // Show random mode win screen
            $("body .container").append(
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
              '</div>'
            );
            
            TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});

          } else if (level < 100) { // Regular mode win
            if($('body').hasClass('mode-regular')) {
              var levelObj = {'level': level};
              myDotmination['level'] = level;
              
              timeBest = (levelsArray['level' + level] !== undefined) ? levelsArray['level' + level].time : null;
              // Ensure timeBest is treated as duration for subtraction
              let timeBestDuration = timeBest ? moment.duration('00:'+timeBest) : moment.duration(0);
              timeDiff = moment.duration('00:'+$('#time').html()).subtract(timeBestDuration).asMilliseconds();
              
              $('.timediff').remove();
              
              if(timeBest === null || timeDiff < 0) {
                levelsArray['level' + level] = {'time': $('#time').html()};
                myDotmination['levels'] = levelsArray;
              }
              
              if (level < 100 && !levelsArray['level' + (level + 1)]) {
                levelsArray['level' + (level + 1)] = {'time': null};
                myDotmination['levels'] = levelsArray;
              }
              
              myStorage.setObj("myDotmination", myDotmination);
              updateLevelList();
              
              var hasTime = levelsArray['level' + level] && levelsArray['level' + level].time && levelsArray['level' + level].time !== null;
              var wonStarClass = hasTime ? 'active' : '';
              var goalMoves = (moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 120) ? 'active' : '';
              var goalTime = (moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 60) ? 'active' : '';
              
              $("body .container").append(
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
                '</div>'
              );
              
              TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
            }
          } else { // Level 100 win (loop back)
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
          // --- User Lost --- 
          $("body .container").append(
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
            '</div>'
          );
          TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
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
    for (i = 0; i < dotRows; i++) {
      var newY = (dot_size * i) / 1.25;
      if (isEven(i)) {
        dotCols--;
      } else {
        dotCols = Math.floor(winW / dot_size);
      }
      for (j = 0; j < dotCols; j++) {
        if (isEven(i)) {
          var newX = dot_size * j + dot_size / 2;
        } else {
          var newX = dot_size * j;
        }
        $(".field").append(
          '<div class="dot rippled" data-index="' +
            dotIndex +
            '" data-increment="0"><div class="hitarea"></div></div>'
        );
        $(".dot:last").css({ top: newY, left: newX });
        dotIndex++;
      }
    }
  }
  dots = $(".dot");
}
//setDots();

// Rippled
$("body").on("click", ".rippled", function (e) {
  if (!$(this).hasClass("disabled")) {
    if ("vibrate" in navigator) {
      window.navigator.vibrate(10);
    }
    $(this).append('<div class="ripple ripple-animate"></div>');
    var ripple = $(this).find(".ripple").last();
    ripple.removeClass("ripple-animate");
    ripple.addClass("ripple-animate");
    setTimeout(function () {
      ripple.remove();
    }, 400);
  }
});
// END Rippled

function isEven(n) {
  return n % 2 == 0;
}

$(window).on("resize", function () {
  setDots();
});

function startAnim() {
  moveAmount = 0;
  randomNumber = Math.floor(Math.random() * playerArray.length);
  currentPlayer = "player--2";

  // Set player icons based on mode and difficulty
  if (!isMultiplayer) {
    // Determine Player 1 icon
    let player1Icon = 'fa-robot'; // Default for regular mode or normal random bot
    if (gameMode === 'random' && botDifficulty === 'smart') {
      player1Icon = 'fa-brain'; // Harder bot in random mode
    }
    $('.player.player--1 i').removeClass('fa-user-secret fa-robot fa-brain').addClass(player1Icon); // Set P1 icon

    // Set Player 2 icon
    $('.player.player--2 i').removeClass('fa-robot fa-brain').addClass('fa-user-secret'); // Always user icon for P2

    $('.player-indicator').remove(); // Remove any leftover MP indicators
    $('.turn-indicator').remove(); // Remove turn indicator
  }
  
  $('.level-value').html(level);
  setDots();
  $(".end").remove();
  $(".dot").removeClass(playerClassClear);
  if(gameMode == 'regular') {
    var populate = fieldPopulateByLevel;
  } else {
    var populate = fieldPopulateRandom;
  }
  
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
      updatePlayerScoresUI(); 
      populate(); // Call populate after animation completes
    }
  );
}

function botActionRandom() {
  var trgt = $(".dot:not(.player--2)");
  var player2lvl5 = $(".dot.player--2.stage--5");
  var lvl5 = $(".dot.player--1.stage--5");
  var randomDotIndex,
      dotIndexWithHitArr = [];
  
  // Check if possible to hit.
  if ($(lvl5).length > 0) {
    var dots = $(player2lvl5);
    
    for (var i = 0; i < $(lvl5).length; i++) {
      for (var j = 0; j < $(dots).length; j++) {
        if (
          Draggable.hitTest($(dots).eq(j), $(lvl5[i]).find(".hitarea")) &&
          i != $(lvl5[i]).data("index")
        ) {
          var trgtIndex = $(lvl5).eq(i).data("index");
          trgt = $(dots).eq(trgtIndex);
          dotIndexWithHitArr.push(trgtIndex);
        }
      }
    }
    if(dotIndexWithHitArr.length > 0) {
      // Hit!
      var randomNum = Math.floor(Math.random() * dotIndexWithHitArr.length);
      randomDotIndex = dotIndexWithHitArr[randomNum];
      $(".dot").eq(randomDotIndex).click();
    } else {
      // No hit.
      randomDotIndex = Math.floor(Math.random() * trgt.length);
      $(".dot").eq($(trgt[randomDotIndex]).index()).click();
    }
  } else {
    // No lvl5.
    randomDotIndex = Math.floor(Math.random() * trgt.length);
    $(".dot").eq($(trgt[randomDotIndex]).index()).click();
  }
}

// Smart bot - initially identical to random bot
function botActionSmarter() {
  var trgt = $(".dot:not(.player--2)");
  var player2lvl5 = $(".dot.player--2.stage--5");
  var lvl5 = $(".dot.player--1.stage--5");
  var randomDotIndex,
      dotIndexWithHitArr = [];
  
  // Check if possible to hit.
  if ($(lvl5).length > 0) {
    var dots = $(player2lvl5);
    
    for (var i = 0; i < $(lvl5).length; i++) {
      for (var j = 0; j < $(dots).length; j++) {
        if (
          Draggable.hitTest($(dots).eq(j), $(lvl5[i]).find(".hitarea")) &&
          i != $(lvl5[i]).data("index")
        ) {
          var trgtIndex = $(lvl5).eq(i).data("index");
          trgt = $(dots).eq(trgtIndex);
          dotIndexWithHitArr.push(trgtIndex);
        }
      }
    }
    if(dotIndexWithHitArr.length > 0) {
      // Hit!
      var randomNum = Math.floor(Math.random() * dotIndexWithHitArr.length);
      randomDotIndex = dotIndexWithHitArr[randomNum];
      $(".dot").eq(randomDotIndex).click();
    } else {
      // No hit.
      randomDotIndex = Math.floor(Math.random() * trgt.length);
      $(".dot").eq($(trgt[randomDotIndex]).index()).click();
    }
  } else {
    // No lvl5.
    randomDotIndex = Math.floor(Math.random() * trgt.length);
    $(".dot").eq($(trgt[randomDotIndex]).index()).click();
  }
}

// Enhanced bot AI with improved strategy and code organization
const BOT_CONSTANTS = {
  SCORE_THRESHOLD: 5,
  RECENT_MOVES_LIMIT: 3,
  CHAIN_WEIGHT: 2,
  DISRUPT_WEIGHT: 1.5,
  EARLY_GAME_TURNS: 10,
  MIN_VIABLE_TARGETS: 3,
  HIGH_STAGE_THRESHOLD: 3,
  VISUAL_FEEDBACK_DELAY: 1000
};

function botActionSmarter() {
  // Initialize game state
  const gameState = {
    targets: $(".dot:not(.player--2)"),
    player2Stage5: $(".dot.player--2.stage--5"),
    player1Stage5: $(".dot.player--1.stage--5"),
    turnCount: $(".dot.player--1").length,
    recentMoves: []
  };

  // Try to execute moves in order of priority
  if (tryStage5Hits(gameState)) return;
  
  const viableTargets = findViableTargets(gameState);
  if (executeViableMove(viableTargets, gameState)) return;
  
  executeFallbackStrategy(gameState);
}

function tryStage5Hits(gameState) {
  if (gameState.player1Stage5.length === 0) return false;

  for (let i = 0; i < gameState.player1Stage5.length; i++) {
    for (let j = 0; j < gameState.player2Stage5.length; j++) {
      const targetDot = $(gameState.player1Stage5[i]);
      const myDot = $(gameState.player2Stage5[j]);
      
      if (Draggable.hitTest(myDot, targetDot.find(".hitarea")) && 
          myDot.data("index") !== targetDot.data("index")) {
        
        const targetIndex = targetDot.data("index");
        console.log("Bot used stage--5 to hit your stage--5 at index " + targetIndex);
        
        const chosenDot = $(".dot").eq(targetIndex);
        visualFeedback(chosenDot);
        chosenDot.click();
        return true;
      }
    }
  }
  return false;
}

function findViableTargets(gameState) {
  const viableTargets = [];
  
  gameState.targets.each(function(i) {
    const target = $(this);
    const targetData = evaluateTarget(target, gameState);
    
    if (targetData.isSafe) {
      const score = calculateScore(targetData, gameState.turnCount);
      
      if (score > 0 || viableTargets.length < BOT_CONSTANTS.MIN_VIABLE_TARGETS) {
        viableTargets.push({
          dot: target,
          score: score,
          chain: targetData.chainPotential,
          disrupt: targetData.disruptPotential
        });
      }
    }
  });
  
  return viableTargets;
}

function evaluateTarget(target, gameState) {
  const targetData = {
    isSafe: true,
    myStage: getStageNumber(target),
    chainPotential: 0,
    disruptPotential: 0,
    neighbors: 0
  };

  $(".dot").each(function() {
    const dot = $(this);
    if (!Draggable.hitTest(target, dot.find(".hitarea")) || 
        dot.attr("data-index") === target.attr("data-index")) return;

    targetData.neighbors++;
    
    if (dot.hasClass("player--2")) {
      evaluateOpponentDot(dot, targetData);
    } else if (dot.hasClass("player--1")) {
      evaluatePlayerDot(dot, targetData);
    }
  });

  return targetData;
}

function executeViableMove(viableTargets, gameState) {
  if (viableTargets.length === 0) return false;
  
  viableTargets.sort((a, b) => b.score - a.score);
  
  if (viableTargets[0].score >= BOT_CONSTANTS.SCORE_THRESHOLD) {
    const choice = viableTargets[0].dot;
    logBotChoice(choice, viableTargets[0]);
    
    visualFeedback(choice);
    updateRecentMoves(choice.attr("data-index"), gameState);
    choice.click();
    return true;
  }
  
  return false;
}

function executeFallbackStrategy(gameState) {
  const fallbackTargets = findFallbackTargets(gameState);
  
  if (fallbackTargets.length > 0) {
    fallbackTargets.sort((a, b) => b.score - a.score);
    const choice = fallbackTargets[0].dot;
    
    console.log("Bot fell back to dot " + choice.attr("data-index") + 
                " near your stage--" + fallbackTargets[0].disrupt + 
                " with chain potential");
    
    visualFeedback(choice);
    updateRecentMoves(choice.attr("data-index"), gameState);
    choice.click();
  } else {
    executeRandomMove(gameState);
  }
}

function findFallbackTargets(gameState) {
  const fallbackTargets = [];
  
  gameState.targets.each(function(i) {
    const target = $(this);
    const fallbackData = evaluateFallbackTarget(target);
    
    if ((fallbackData.disrupt >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD || 
         fallbackData.chain > 0) && 
        !gameState.recentMoves.includes(target.attr("data-index"))) {
      
      fallbackTargets.push({
        dot: target,
        score: (fallbackData.chain * BOT_CONSTANTS.CHAIN_WEIGHT) + 
               (fallbackData.disrupt * BOT_CONSTANTS.DISRUPT_WEIGHT),
        disrupt: fallbackData.disrupt
      });
    }
  });
  
  return fallbackTargets;
}

function evaluateFallbackTarget(target) {
  const data = {
    disrupt: 0,
    chain: 0
  };

  $(".dot").each(function() {
    const dot = $(this);
    if (!Draggable.hitTest(target, dot.find(".hitarea")) || 
        dot.attr("data-index") === target.attr("data-index")) return;

    if (dot.hasClass("player--2")) {
      const stage = getStageNumber(dot);
      data.disrupt = Math.max(data.disrupt, stage);
    } else if (dot.hasClass("player--1")) {
      const stage = getStageNumber(dot);
      data.chain += (5 - stage);
    }
  });

  return data;
}

function executeRandomMove(gameState) {
  const randomDot = gameState.targets.eq(Math.floor(Math.random() * gameState.targets.length));
  console.log("Bot fell back to random dot " + randomDot.attr("data-index"));
  
  visualFeedback(randomDot);
  updateRecentMoves(randomDot.attr("data-index"), gameState);
  randomDot.click();
}

// Utility functions
function getStageNumber(dot) {
  const stageMatch = dot.attr("class").match(/stage--(\d)/);
  return stageMatch ? parseInt(stageMatch[1]) : 0;
}

function calculateScore(targetData, turnCount) {
  return (targetData.chainPotential * BOT_CONSTANTS.CHAIN_WEIGHT) + 
         targetData.disruptPotential +
         (targetData.myStage === 0 && targetData.neighbors < 3 ? 5 : 0) +
         (turnCount < BOT_CONSTANTS.EARLY_GAME_TURNS && 
          targetData.disruptPotential >= 6 ? 5 : 0);
}

function evaluateOpponentDot(dot, targetData) {
  const stage = getStageNumber(dot);
  if (stage > targetData.myStage) {
    targetData.isSafe = false;
    console.log("Bot avoided dot " + targetData.dot?.attr("data-index") + 
                " (stage " + targetData.myStage + ") next to your stage--" + stage);
  } else if (stage >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD) {
    targetData.disruptPotential += stage * 2;
  }
}

function evaluatePlayerDot(dot, targetData) {
  const stage = getStageNumber(dot);
  if (stage >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD) {
    targetData.chainPotential += (5 - stage) * 2;
  }
}

function visualFeedback(dot) {
  dot.addClass("bot-choice");
  setTimeout(() => dot.removeClass("bot-choice"), BOT_CONSTANTS.VISUAL_FEEDBACK_DELAY);
}

function updateRecentMoves(moveIndex, gameState) {
  gameState.recentMoves.push(moveIndex);
  if (gameState.recentMoves.length > BOT_CONSTANTS.RECENT_MOVES_LIMIT) {
    gameState.recentMoves.shift();
  }
}

function logBotChoice(choice, data) {
  console.log(
    "Bot chose dot " + choice.attr("data-index") + 
    " (stage " + getStageNumber(choice) + ") with score " + 
    Math.round(data.score) + " (chain: " + Math.round(data.chain) + 
    ", disrupt: " + Math.round(data.disrupt) + ")"
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

  gsap.delayedCall(1,nextPlayer);
  show();
  reset();
  start();
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
      var dotStage = Math.floor(Number((Math.PI * (index + 1) * level).toString()[7]) / 10 * 5);
      var dotPlayerNumber = Math.floor(Number((Math.PI * (index + 1) * level).toString()[5]) / 10 * 2) + 1;
    }
    
    //console.log('---');
    //console.log('index', index);
    //console.log('stage', dotStage);
    //console.log('player', dotPlayerNumber);
    if (dotStage == 0) {
    } else {
      //dotStage = 5;
      //dotPlayerNumber = 2;
      $(this).addClass(
        "stage--" + dotStage + " player--" + dotPlayerNumber
      );
    }
  });
  dots = $(".dot");

  gsap.delayedCall(1,nextPlayer);
  show();
  reset();
  start();
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

function changeColors() {
  incrementColorsIndex();

  // Get the HEX colors
  const hex1 = colorsArr[colorsIndex][0];
  const hex2 = colorsArr[colorsIndex][1];

  // Convert HEX to RGB using the utility function
  const rgb1 = hexToRgb(hex1); 
  const rgb2 = hexToRgb(hex2);

  // Update main colors
  gsap.to("html", {duration: 0, "--color-1": hex1});
  gsap.to("html", {duration: 0, "--color-2": hex2});

  // Update RGBA variables for color 1 using RGB values
  gsap.to("html", {duration: 0, "--color-1-rgba-0": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.75)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-1": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.4)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-2": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.3)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-3": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.2)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-4": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0.1)`});
  gsap.to("html", {duration: 0, "--color-1-rgba-5": `rgba(${rgb1[0]},${rgb1[1]},${rgb1[2]},0)`});

  // Update RGBA variables for color 2 using RGB values
  gsap.to("html", {duration: 0, "--color-2-rgba-0": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.75)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-1": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.4)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-2": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.3)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-3": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.2)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-4": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0.1)`});
  gsap.to("html", {duration: 0, "--color-2-rgba-5": `rgba(${rgb2[0]},${rgb2[1]},${rgb2[2]},0)`});
  
  var currentColor;
  if($('.field').hasClass('player--1')) {
    currentColor = 1;
  } else {
    currentColor = 2;
  }
  // Update the current color (use original HEX)
  gsap.to("html", {duration: 0, "--color-current": colorsArr[colorsIndex][currentColor - 1]});
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

// Stopwatch
var	clsStopwatch = function() {
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
var $time;
var clocktimer;

function pad(num, size) {
	var s = "0000" + num;
	return s.substr(s.length - size);
}

function formatTime(time) {
	var h = m = s = ms = 0;
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

function show() {
	$time = document.getElementById('time');
	update();
}

function update() {
	$time.innerHTML = formatTime(x.time());
}

function start() {
	clocktimer = setInterval("update()", 1);
	x.start();
}

function stop() {
	x.stop();
	clearInterval(clocktimer);
}

function reset() {
	stop();
	x.reset();
	update();
}
// END Stopwatch


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
// Open main menu modal
$('#main-menu-btn').on('click', function(e) {
  e.stopPropagation(); // Prevent header clicks if any
  $('.modal').removeClass('active'); // Close any other open modals
  $('.main-menu-modal').addClass('active');
  $('body').addClass('modal-open');
  // <<< ADD CHECK >>>
  console.log("Main menu opened. 'How to Play' button exists:", $(".main-menu-modal .btn-main-menu[data-action='how-to-play']").length > 0);
  // <<< END CHECK >>>
});

// Handle clicks on buttons inside the main menu
$('.main-menu-modal .btn-main-menu').on('click', function() {
  const action = $(this).data('action');
  
  // <<< ADD "how-to-play" ACTION >>>
  if (action === 'how-to-play') {
    $('.main-menu-modal').removeClass('active');
    $('body').removeClass('modal-open');
    // Give slight delay for menu close animation
    setTimeout(() => {
      startTutorialFlow();
    }, 100);
  } else if (action === 'mode' || action === 'profile') {
    // Close the main menu modal first for mode/profile actions
    $('.main-menu-modal').removeClass('active');
    $('body').removeClass('modal-open');
    
    // Perform action after a short delay to allow closing animation
    setTimeout(() => {
      if (action === 'mode') {
        // Open the mode selection modal
        $('.mode-modal').addClass('active');
        $('body').addClass('modal-open');
        if($('body').hasClass('modal-open')) { // Re-check just in case
          updateLevelList(); // Ensure level list is updated if switching to regular
        }
      } else if (action === 'profile') {
        // Open the profile modal
        $('.profile-modal').addClass('active');
        $('body').addClass('modal-open');
        if($('body').hasClass('modal-open')) { // Re-check
          updateBestTime(); // Update profile times
        }
      }
    }, 100); // Adjust delay if needed
  } else if (action === 'colors') {
    // Trigger color change directly without closing the modal
    changeColors();
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
$('.level, .random, .multiplayer, .mode-modal .backdrop').on('click', function(e) { 
  // Prevent propagation if it's one of the footer buttons to avoid immediate closing
  if ($(this).hasClass('level') || $(this).hasClass('random') || $(this).hasClass('multiplayer')) {
    e.stopPropagation(); 
  }
  $('body').toggleClass('modal-open');
  
  if($('body').hasClass('modal-open')) {
    updateLevelList();
  }
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
  
  // Close the modal and update game mode
  $('body').removeClass('modal-open');
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
        show();
        reset();
        start();
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
  gsap.to('.intro', {duration: 0.3, delay:2, autoAlpha: 0, onComplete: function() {
    // <<< MODIFIED: Check if user has played before >>>
    if (!hasPlayedBefore) {
      startTutorialFlow();
    } else {
      // Existing logic for returning users or URL parameters
      var urlParams = new URLSearchParams(window.location.search);
      var mode = urlParams.get('mode');
      var map = urlParams.get('map');
      var difficulty = urlParams.get('difficulty');

      if (mode === 'random') {
        // ... (rest of existing random mode logic) ...
        if (map) {
          // ... existing map loading ...
        } else {
          startAnim();
        }
      } else if (mode === 'multiplayer') {
        // ... (rest of existing multiplayer logic) ...
        $('.mode-modal .card[data-mode="multiplayer"]').trigger('click');
      } else {
        // Default to regular mode or based on URL
        checkUrlParameters(); // Let this function handle level loading etc.
        // Ensure startAnim is called if not loading a specific map or joining multiplayer
        if (!map && mode !== 'multiplayer') {
             startAnim();
        }
      }
    }
    // <<< END MODIFICATION >>>
  }});
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
  
  if (mode === 'random' && map) {
    gameMode = 'random';
    $('body')
      .removeClass('mode-regular')
      .addClass('mode-random');
    
    // Update mode selection in modal
    $('.mode-modal .card').removeClass('selected');
    $('.mode-modal .card[data-mode="random"]').addClass('selected');
    
    // Set up dots first
    setDots();
    // Then build the map from URL
    buildMapFromString(map);
    // Initialize game state without triggering end game
    dots = $(".dot");
    currentPlayer = "player--2";
    $(".field").addClass(currentPlayer);
    show();
    reset();
    start();
  } else {
    // Only call startAnim if we're not loading a map from URL
    startAnim();
  }
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
  
  if (mode) {
    // Set the game mode based on URL
    gameMode = mode;
    $('body')
      .removeClass('mode-random mode-regular mode-multiplayer')
      .addClass('mode-'+gameMode);
    $('.mode-modal .card').removeClass('selected');
    $('.mode-modal .card[data-mode="' + gameMode + '"]').addClass('selected');
    
    if (mode === 'regular') {
      // Check for level parameter
      var levelParam = urlParams.get('level');
      if (levelParam) {
        level = parseInt(levelParam);
        $('.level-value').html(level);
      }
    } 
    else if (mode === 'random') {
      // Ensure Normal bot is selected for Random mode
      botDifficulty = 'random';
      $('.difficulty-option').removeClass('selected');
      $('.difficulty-option[data-difficulty="random"]').addClass('selected');
    }
    else if (mode === 'multiplayer') {
      // Only run this direct-load-to-multiplayer logic if we are not already connecting/connected
      if (connectionState === CONNECTION_STATES.DISCONNECTED) {
        isHost = true; // Assume hosting if loading directly into MP mode
        
        // Open the mode modal and show start options
        $('.mode-modal').addClass('active');
        $('body').addClass('modal-open');
        $('.multiplayer-start-options').show();
        // Hide other irrelevant sections
        $('.list--mode-regular, .bot-difficulty, .multiplayer-start-options, .game-id-display, .game-id-input').hide(); 
         
        // Deprecated joining via URL ID - Remove related logic
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
  if ($('.mode-modal .card[data-mode="multiplayer"]').length === 0) {
    console.log("Adding multiplayer button to modal");
    
    // Get styling from an existing button
    var $existingButton = $('.mode-modal .card[data-mode="random"]');
    var buttonClass = $existingButton.attr('class');
    
    // Create the button with matching styling
    var $newButton = $('<div class="' + buttonClass + '" data-mode="multiplayer"><h1><i class="fas fa-users"></i></h1><p class="text-center">Multiplayer<br><span class="x-small" style="position: absolute; transform: translateX(-50%);">on same WIFI</span></p></div>');
    
    // Add it after the random button
    $('.mode-modal .card[data-mode="random"]').after($newButton);
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
    $('.mode-modal').removeClass('active');
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
      $('.mode-modal .card').removeClass('selected');
      $('.mode-modal .card[data-mode="regular"]').addClass('selected');
      
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
function startMultiplayerConnection() {
  // Note: isHost is determined *by* findAvailableSlot now
  console.log("startMultiplayerConnection called. Desired startType:", multiplayerStartType); 
   
  connectionState = CONNECTION_STATES.CONNECTING;
   
  findAvailableSlot(multiplayerStartType).then(slot => { // <<< Pass startType
    if (!slot) {
      updateConnectingOverlay("No available game slots found for type '" + multiplayerStartType + "'. Please try again later.");
      showRetryButton();
      return;
    }
    
    console.log('slot.role:', slot.role);
    if (slot.role === 'peer') {
      setupPeer(slot.slotNumber);
    } else {
      setupHost(slot.slotNumber);
    }
  });
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

function setupPeer(slotNumber) {
  cleanup();
  isHost = false;
  isMultiplayer = true;
  // Generate ID based on the chosen start type
  sessionID = `dot-peer-${multiplayerStartType}-${slotNumber}`; 
  cleanup(); // Cleanup before creating new peer
  peer = new Peer(sessionID, { host: "0.peerjs.com", port: 443, secure: true });

  peer.on("open", function() {
    if (hasConnected) return;

    console.log("Peer started with ID:", sessionID);
    updateConnectingOverlay(`Connecting to host...`);

    // Connect to the host ID matching the chosen start type
    const hostID = `dot-host-${multiplayerStartType}-${slotNumber}`; 
    conn = peer.connect(hostID);

    conn.on("open", function() {
      if (hasConnected) return;
      hasConnected = true;
      connectionState = CONNECTION_STATES.CONNECTED;
      // Remove the overlay immediately upon successful connection
      $('.connecting-overlay').remove(); 
      // updateConnectingOverlay(`Connected to Host!`); // Removed this line
      saveSessionInfo(slotNumber, 'peer');
      setupConnectionHandlers(conn);
      // Send ready signal to host
      conn.send({ type: 'ready' });
    });
  });

  peer.on("error", function(err) {
    console.error("Peer error:", err);
    cleanup();
    clearSessionInfo();
    showRetryButton();
  });
}

function setupHost(slotNumber) {
  cleanup();
  isHost = true;
  isMultiplayer = true;
  // Generate ID based on the chosen start type
  sessionID = `dot-host-${multiplayerStartType}-${slotNumber}`; 
  cleanup(); // Cleanup before creating new peer
  peer = new Peer(sessionID, { host: "0.peerjs.com", port: 443, secure: true });

  peer.on("open", function() {
    if (hasConnected) return;
    console.log("Host started with ID:", sessionID);
    updateConnectingOverlay(`Waiting for opponent to join...`);
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
          setupConnectionHandlers(conn);
        });
      }
    });
  });

  peer.on("error", function(err) {
    console.error("Host error:", err);
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
      gsap.killTweensOf(incrementDotStage); 
      $(".dot.increment").removeClass("increment");
      $(".field").removeClass("animating");
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
          // Reset timer only on initial/rematch sync
          reset(); 
          start();
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
        gsap.killTweensOf(incrementDotStage);
        $(".dot.increment").removeClass("increment");
        $(".field").removeClass("animating");

        // Peer shows overlay based on received winner
        showMultiplayerGameOverOverlay(data.winner);
      }
      // Host also stops local animations if they were running (e.g., simultaneous game end)
      else { 
        console.log("Host stopping animations on game over...");
        gsap.killTweensOf(incrementDotStage);
        $(".dot.increment").removeClass("increment");
        $(".field").removeClass("animating");
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
         $('.mode-modal .card').removeClass('selected');
         $('.mode-modal .card[data-mode="regular"]').addClass('selected');
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
    
    // Update mode selection in modal
    $('.mode-modal .card').removeClass('selected');
    $('.mode-modal .card[data-mode="regular"]').addClass('selected');
    
    // Show the mode modal with levels list
    $('.mode-modal').addClass('active');
    $('body').addClass('modal-open');
    $('.list--mode-regular').show();
    updateLevelList(); // <<< ADD THIS CALL
    
    // Hide bot difficulty section
    $('.bot-difficulty').hide();
    
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
  show(); // Show timer element
  reset(); // Reset timer value
  start(); // Start timer ticking

  // Update scores (should reflect new population), turn indicator, and player icons
  updatePlayerScoresUI();
  updateTurnIndicator();
  updatePlayerIndicators(); // <<< ADD THIS CALL
}

// Function to calculate player score based on dot stages
function calculatePlayerScore(playerClass) { // e.g., "player--1"
  let score = 0;
  $(".dot." + playerClass).each(function() {
    score += getStageNumber($(this));
  });
  return score;
}

// Function to update the scores in the UI
function updatePlayerScoresUI() {
  const score1 = calculatePlayerScore("player--1");
  const score2 = calculatePlayerScore("player--2");
  $('#player-1-score').text(score1);
  $('#player-2-score').text(score2);
}

// Function to display the multiplayer game over overlay
function showMultiplayerGameOverOverlay(winner) {
  stop(); // Stop timer for both players
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

  // Close the modal and update game mode
  $('body').removeClass('modal-open');
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

// Handler specifically for Mode Selection Buttons (Regular, Random, Multiplayer)
$('.mode-modal .wrapper').on('click', 'div[data-mode]', function(e) {
  // If we're currently in multiplayer mode, notify the other player before cleaning up
  if (isMultiplayer && conn) {
    conn.send({ type: 'modeSwitch' });
    // Give a small delay for the message to be sent
    setTimeout(() => {
      cleanup();
      clearSessionInfo();
      $('.connecting-overlay, .waiting-overlay').remove();
    }, 100);
  }
  
  gameMode = $(this).data('mode');
  console.log("Mode button clicked:", gameMode);

  // General cleanup: hide all specific sections first
  $('.list--mode-regular, .bot-difficulty, .multiplayer-start-options, .game-id-display, .game-id-input').hide();

  // Remove turn indicator if leaving multiplayer mode
  if (isMultiplayer && gameMode !== 'multiplayer') { // Only remove if switching AWAY from MP
    multiplayerStartType = 'blank'; // <<< Reset start type when switching away
    $('.turn-indicator').remove();
    isMultiplayer = false; // Reset flag when switching away
  }

  // Handle specific mode logic
  if (gameMode === 'multiplayer') {
    e.preventDefault();
    e.stopPropagation(); // Keep stopPropagation for this specific case maybe?
    isMultiplayer = true;
    isHost = true; // Assume host role immediately
    
    // Update URL
    var newUrl = window.location.pathname + '?mode=multiplayer';
    window.history.replaceState({}, document.title, newUrl);
    
    // Show start type options
    $('.multiplayer-start-options').show();
    
    // Update selection in the modal
    $('.mode-modal .wrapper div[data-mode]').removeClass('selected');
    $(this).addClass('selected');
    
    // Set body class & keep modal open
    $('body')
      .removeClass('mode-random mode-regular modal-open')
      .addClass('mode-multiplayer modal-open'); 
    
    return false;
  } else if (gameMode === 'regular') {
    // Hide Random mode and multiplayer options
    $('.bot-difficulty, .multiplayer-start-options').hide();

    $('.list--mode-regular').show();
    
    // Set default bot difficulty
    botDifficulty = 'random';
    $('.difficulty-option').removeClass('selected');
    $('.difficulty-option[data-difficulty="random"]').addClass('selected');
    
    // Update selection in the modal
    $('.mode-modal .wrapper div[data-mode]').removeClass('selected');
    $(this).addClass('selected');

    // Set body class & keep modal open
    $('body')
      .removeClass('mode-regular mode-multiplayer')
      .addClass('mode-random modal-open');
    
    // Don't start game yet
    return; // Need return here to prevent modal close
  } else if (gameMode === 'random') {

    $('.bot-difficulty').show();

    // Set default bot difficulty
    botDifficulty = 'random';
    $('.difficulty-option').removeClass('selected');
    $('.difficulty-option[data-difficulty="random"]').addClass('selected');

    // Update selection in the modal
    $('.mode-modal .wrapper div[data-mode]').removeClass('selected');
    $(this).addClass('selected');
    $('.list--mode-regular, .multiplayer-start-options').hide(); // Explicitly hide other sections

    // Set body class & keep modal open
    $('body')
      .removeClass('mode-regular mode-multiplayer')
      .addClass('mode-random modal-open');
    // No return here - allow modal to stay open consistently
  }

  // If we reached here (Regular or Random mode selected), keep modal open
  // (Unless a level/difficulty is clicked later)
  $('body').addClass('modal-open');
});

// Handler specifically for Level Selection Buttons
$('.mode-modal .wrapper').on('click', '.btn-level', function(e) {
  console.log("Level button clicked:", $(this).data('level'));
  gameMode = 'regular';
  level = $(this).data('level');
  $('.level-value').html(level);
  
  var newUrl = window.location.pathname + '?mode=regular&level=' + level;
  window.history.replaceState({}, document.title, newUrl);
  
  // Update selection
  $('.mode-modal .wrapper .btn-level').removeClass('selected'); // Use more specific selector
  $(this).addClass('selected');

  // Close modal and start game
  $('body').removeClass('modal-open');
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

// << NEW Tutorial Functions >>
function startTutorialFlow() {
  console.log('Starting Tutorial Flow');
  isTutorialMode = true;
  tutorialStep = 0; // Start at step 0 (welcome modal)

  // Ensure game mode is set appropriately visually if needed
  // (e.g., hide multiplayer elements if the tutorial starts automatically)
  $('body').removeClass('mode-multiplayer mode-random').addClass('mode-regular');
  // Reset potential game state artifacts
  cleanup(); // Clean PeerJS connections if any
  resetMultiplayerState(); // Reset MP flags
  $(".end.overlay").remove(); // Remove win/loss overlays

  // Show the welcome modal
  $('.modal').removeClass('active'); // Close ALL modals first
  $('body').removeClass('no-backdrop'); // <<< Ensure no-backdrop is removed initially
  $('.tutorial-step-modal').removeClass('active'); // Explicitly hide step modal
  $('.welcome-tutorial-modal').addClass('active');
  $('body').addClass('modal-open');

  // --- Handle Welcome Modal Buttons ---
  $('.welcome-tutorial-modal .btn-start-tutorial').off('click').on('click', function() {
    localStorage.setItem('hasPlayedBefore', 'true'); // Mark as played
    hasPlayedBefore = true;
    $('.welcome-tutorial-modal').removeClass('active');
    $('body').removeClass('modal-open no-backdrop'); // <<< Remove no-backdrop on close
    advanceTutorialStep(); // Move to step 1
  });

  $('.welcome-tutorial-modal .btn-skip-tutorial').off('click').on('click', function() {
    localStorage.setItem('hasPlayedBefore', 'true'); // Mark as played
    hasPlayedBefore = true;
    isTutorialMode = false;
    $('.welcome-tutorial-modal').removeClass('active');
    $('body').removeClass('modal-open no-backdrop'); // <<< Remove no-backdrop on skip
    // Start regular game (Level 1)
    level = 1;
    gameMode = 'regular';
    var newUrl = window.location.pathname + '?mode=regular&level=1';
    window.history.replaceState({}, document.title, newUrl);
    startAnim();
  });
  // Handle backdrop click for welcome modal
  $('.welcome-tutorial-modal .backdrop, .welcome-tutorial-modal .modal-close').off('click').on('click', function() {
     localStorage.setItem('hasPlayedBefore', 'true'); // Mark as played if they close modal
     hasPlayedBefore = true;
     isTutorialMode = false;
     $('.welcome-tutorial-modal').removeClass('active');
     $('body').removeClass('modal-open no-backdrop'); // <<< Remove no-backdrop on close
     // Optionally start Level 1 or just leave them on the main screen
  });
}

function advanceTutorialStep() {
  tutorialStep++;
  console.log(`Advancing to Tutorial Step ${tutorialStep}`);

  if (tutorialStep > 5) { // Assuming 5 steps T1-T5
    endTutorial();
    return;
  }

  // Explicitly hide welcome modal before showing step modal
  $('.welcome-tutorial-modal').removeClass('active');

  // Setup board and show instructions for the current step
  setupTutorialBoard(tutorialStep);
  showTutorialStepModal(tutorialStep);
}

function setupTutorialBoard(step) {
  console.log(`Setting up board for Tutorial Step ${step}`);
  // Stop timer if running
  stop();
  reset();

  // Clear state for checks
  tutorialTargetDotIndex = -1;
  tutorialChainStartIndices = [];
  tutorialStep4Clicked = false; // <<< Reset flag

  // Define map strings or setup logic for each step
  // Estimate dot count if field is empty (e.g., on first load)
  const currentDotCount = $(".field .dot").length;
  const estimatedDotCount = currentDotCount > 0 ? currentDotCount : 45; // Default to 45 if no dots exist
  const emptyMap = Array(estimatedDotCount).fill('0').join('');
  const TUTORIAL_MAP_T1 = emptyMap;
  // T2: P2 Stage 1 (6) at index 15 (<<< Updated stage)
  const TUTORIAL_MAP_T2 = emptyMap.substring(0, 15) + '6' + emptyMap.substring(16);
  // T3: P1 Stage 3 (3) at index 10, P2 Stage 5 (A) at index 11
  const TUTORIAL_MAP_T3 = emptyMap.substring(0, 10) + '3A' + emptyMap.substring(12);
  // T4: P2 Stage 5 (A) at indices 5, 11, 15 and P1 Stage 5 (5) at indices 7, 10
  let t4Arr = emptyMap.split('');
  [5, 11, 15].forEach(i => { if(i < t4Arr.length) t4Arr[i] = 'A'; }); // P2 Stage 5
  [7, 10].forEach(i => { if(i < t4Arr.length) t4Arr[i] = '5'; });     // P1 Stage 5
  const TUTORIAL_MAP_T4 = t4Arr.join('');
  // T5 map no longer needed as we don't load it


  let mapToLoad = "";
  let loadMap = true; // Flag to indicate if buildMapFromString should be called

  switch (step) {
    case 1: // T1: Claim 3 dots
      mapToLoad = TUTORIAL_MAP_T1;
      break;
    case 2: // T2: Make dot explode
      mapToLoad = TUTORIAL_MAP_T2;
      tutorialTargetDotIndex = 15; 
      break;
    case 3: // T3: Explode to capture
      mapToLoad = TUTORIAL_MAP_T3;
      tutorialTargetDotIndex = 10; // Opponent dot is now at index 10
      break;
    case 4: // T4: Chain reaction
      mapToLoad = TUTORIAL_MAP_T4;
      tutorialChainStartIndices = [5, 11, 15]; // User should only click their own dots (P2)
      break;
    case 5: // T5: Completion Screen
      // *** Don't load a map or clear the field for the final step ***
      loadMap = false; // Prevent buildMapFromString
      break;
  }

  // *** Only clear and repopulate board if NOT step 5 ***
  if (step !== 5) {
    // Clear field completely first
    $(".field").empty().removeClass(playerClassClear);
    setDots(); // Create new empty dots
    dots = $(".dot"); // Update reference

    // Load the map string if required for the step
    if (loadMap && mapToLoad) {
      buildMapFromString(mapToLoad);
    }
  } else {
      // Ensure dots reference is up-to-date for step 5 if not reset
      dots = $(".dot"); 
  }


  // Set initial player (User = Player 2)
  currentPlayer = "player--2";
  $(".field").removeClass(playerClassClear).addClass(currentPlayer); // Ensure field has correct player class
  TweenMax.to("html", 0, {"--color-current": 'var(--color-2)'});

  // Update scores, etc. (will reflect final state of step 4 when step 5 is shown)
  updatePlayerScoresUI(); 
  
  // Turn indicator logic
  if (step < 5) {
      $('.turn-indicator').remove();
      $('.players .player').removeClass('current');
  } else {
      // No turn indicator needed on completion screen
      $('.turn-indicator').remove();
      $('.players .player').removeClass('current');
  }
  updatePlayerIndicators();

  // Disable bot for all tutorial steps now
  if (delayedCall) {
    delayedCall.kill();
  }

  // Remove timer start logic for step 5
  /* 
  if(step === 5) {
      show();
      reset();
      start();
  } 
  */
}

function showTutorialStepModal(step) {
  let title = "";
  let instruction = "";
  let objective = "";

  switch (step) {
    case 1:
      title = '<small>Step 1</small><br><span style="color:var(--color-2)">Claiming Dots</span>';
      instruction = 'The game field is made of dots. Each turn you can add 1 dot. Click on empty dots to claim them for your color (<span style="color:var(--color-2)">Player 2</span>).';
      objective = '<strong>Objective</strong><br>Claim any 3 empty dots.';
      break;
    case 2:
      title = '<small>Step 2</small><br><span style="color:var(--color-2)">Growing Dots</span>';
      instruction = 'Clicking your own dot again makes it grow +1. Dots grow from Stage 1 up to Stage 5.';
      objective = '<strong>Objective</strong><br>Click the <span style="color:var(--color-2)">center dot</span> until it reaches Stage 5.';
      break;
    case 3:
      title = '<small>Step 3</small><br><span style="color:var(--color-2)">Explosions & Take-overs</span>';
      instruction = 'Clicking a dot at Stage 5 makes it explode, adding a stage to neighboring dots and converting them to your color.';
      objective = '<strong>Objective</strong><br>Click <span style="color:var(--color-2)">your Stage 5 dot</span> to take over the opponent\'s dot.';
      break;
    case 4:
      title = '<small>Step 4</small><br><span style="color:var(--color-2)">Chain Reactions</span>';
      instruction = 'It all adds up, so one explosion can trigger chain reactions.';
      objective = '<strong>Objective</strong><br>Click one of <span style="color:var(--color-2)">your dots</span> to start a chain reaction.';
      break;
    case 5:
      title = 'Tutorial Complete!';
      instruction = 'You\'ve learned the basics of Dotmination!';
      objective = '&nbsp;'; // Objective shows in feedback area
      break;
  }

  $('#tutorial-step-title').html(title);
  $('#tutorial-step-instruction').html(instruction);
  $('#tutorial-step-objective').html(objective); // Set initial objective

  // Show the modal after a short delay 
  setTimeout(() => {
      $('.tutorial-step-modal').addClass('active');
      $('body').addClass('modal-open no-backdrop'); // <<< Add no-backdrop class
      // Temporarily make backdrop non-clickable during steps?
      // Add click handler for the confirmation button
      $('.tutorial-step-modal .btn-tutorial-confirm').off('click').on('click', function() {
          $('.tutorial-step-modal').removeClass('active');
          $('body').removeClass('modal-open no-backdrop');
      });
  }, 300); // Adjust delay as needed

  // << NEW: Add/Remove step-5 class for button visibility >>
  if (step === 5) {
    $('.tutorial-step-modal').addClass('step-5');
  } else {
    $('.tutorial-step-modal').removeClass('step-5');
  }
}

function checkTutorialStepCompletion(justCompletedStep2 = false) {
  if (!isTutorialMode) return; // Exit if not in tutorial

  let objectiveMet = false;

  switch (tutorialStep) {
    case 1: // Claim 3 dots
      if ($(".dot.player--2").length >= 3) {
        objectiveMet = true;
      }
      break;
    case 2: // Grow dot to Stage 5
      const targetDotT2 = $(".dot").eq(tutorialTargetDotIndex);
      // Objective met when the target dot reaches stage 5
      if (tutorialTargetDotIndex !== -1 && targetDotT2.hasClass('stage--5')) {
           objectiveMet = true;
      }
      break;
    case 3: // Explode to capture
      // Check if the target P1 dot (index stored in tutorialTargetDotIndex) is now P2
      if (tutorialTargetDotIndex !== -1 && $(".dot").eq(tutorialTargetDotIndex).hasClass("player--2")) {
           objectiveMet = true;
      }
      break;
    case 4: // Chain reaction
      // Check if the player clicked a starting dot AND if animations are finished.
      if (tutorialStep4Clicked && $(".dot.increment").length === 0) {
        objectiveMet = true;
      }
      break;
    case 5: // Completion Screen
      // Automatically complete when step 5 is reached
      objectiveMet = true;
      break;
  }

  if (objectiveMet) {
    // Delay slightly before advancing to allow animations to settle
    setTimeout(() => {
      // Only advance if not on the final step (which now has a button)
      if (tutorialStep < 5) {
        advanceTutorialStep();
      }
    }, 1000); // Adjust delay as needed
  }
}

function endTutorial() {
  isTutorialMode = false;
  tutorialStep = 0;
  // Hide the tutorial modal
  $('.tutorial-step-modal').removeClass('active');
  $('body').removeClass('modal-open no-backdrop'); // <<< Remove no-backdrop class

  // Transition to Level 1
  level = 1;
  gameMode = 'regular';
  var newUrl = window.location.pathname + '?mode=regular&level=1';
  window.history.replaceState({}, document.title, newUrl);
  startAnim();
}

// Modify game logic functions to account for tutorial mode

// Example: Modify nextPlayer to not call bot in tutorial steps 1-4
function nextPlayer() {
  $(".field").removeClass(currentPlayer);
  if (currentPlayer == playerArray[0]) {
    currentPlayer = playerArray[1];
    TweenMax.to("html", 0, {"--color-current": 'var(--color-2)'});
  } else {
    currentPlayer = playerArray[0];
    TweenMax.to("html", 0, {"--color-current": 'var(--color-1)'});
    if(delayedCall) {
      delayedCall.kill();
    }
    // Only schedule bot action if not in multiplayer and not in tutorial steps 1-4
    if (!isMultiplayer && !(isTutorialMode && tutorialStep < 5)) {
      const botAction = gameMode === 'regular' ? botActionRandom :
                        botDifficulty === 'smart' ? botActionSmarter : botActionRandom;
      delayedCall = gsap.delayedCall(1, botAction);
    }
  }
  $(".field").addClass(currentPlayer);
  moveAmount++;

  // Update turn indicator locally first for responsiveness
  // Only update if not in tutorial steps 1-4 OR if it's multiplayer
  if (isMultiplayer || !isTutorialMode || tutorialStep >= 5) {
      updateTurnIndicator();
  }

  // Send authoritative game state update from host instead of just turn info
  if (isMultiplayer && isHost && conn) { // Only host sends state after their turn
    conn.send({
      type: 'gameState',
      currentPlayer: currentPlayer, // The NEW current player (opponent)
      moveAmount: moveAmount,
      mapString: generateMapString(), // Current board state
      fieldClasses: $('.field').attr('class') // Reflects new current player
    });
  }
}

// We need to call checkTutorialStepCompletion after a move sequence finishes
// Modify animateNextDot
function animateNextDot(player = currentPlayer, tutorialStep2Flag = false) {
  // Accept the player context (defaults to global if not provided)
  const effectivePlayer = player;

  if ($(".dot.increment").length > 0) {
    var next = $(".dot.increment").eq(0);
    gsap.delayedCall(0.1, incrementDotStage, [next, effectivePlayer]);
  } else {
    $(".field").removeClass("animating");

    // <<< TUTORIAL CHECK & FEEDBACK >>>
    if (isTutorialMode) {
        updateTutorialFeedback();
        checkTutorialStepCompletion();
    }

    const shouldCheckState = !isMultiplayer || isHost || !processingOpponentMove;

    if (shouldCheckState) {
       checkDotmination();
    }

    if (processingOpponentMove) {
      processingOpponentMove = false;
    }
  }
}

function updateTutorialFeedback() {
    if (!isTutorialMode) return;

    let feedbackText = "";
    switch (tutorialStep) {
        case 1:
            const claimedCount = $(".dot.player--2").length;
            const needed = 3 - claimedCount;
            if (needed > 0) {
                feedbackText = `<strong>Objective</strong><br>That's ${claimedCount}! Now claim ${needed} more dot${needed > 1 ? 's' : ''}.`;
            } else {
                feedbackText = "<strong>Objective</strong><br>Great! Objective met.";
            }
            break;
        case 2:
            const targetDotT2 = $(".dot").eq(tutorialTargetDotIndex);
            const currentStageT2 = getStageNumber(targetDotT2);
            if (currentStageT2 === 0 && !targetDotT2.is('[class*="player--"]')) {
                 feedbackText = "<strong>Objective</strong><br>Click the dot to claim it and start growing.";
            } else if (currentStageT2 > 0 && currentStageT2 < 5) {
                const clicksNeeded = 5 - currentStageT2;
                feedbackText = `<strong>Objective</strong><br>Keep clicking... ${clicksNeeded} more click${clicksNeeded > 1 ? 's' : ''} to go!`;
            } else {
                 feedbackText = "<strong>Objective</strong><br>Great! Onto the next step.";
            }
            break;
        case 3:
            const targetDotT3_fb = $(".dot").eq(10); // Opponent dot is index 10
            const explodingDotT3_fb = $(".dot").eq(11); // User dot is index 11
             if (explodingDotT3_fb.hasClass('stage--5')) { 
                 feedbackText = "<strong>Objective</strong><br>Click your Stage 5 dot to capture the opponent's dot!";
             } else if (targetDotT3_fb.hasClass('player--2')) {
                 feedbackText = "<strong>Objective</strong><br>Captured! Objective met.";
             } else {
                 if (explodingDotT3_fb.is('[class*="stage--"]') && explodingDotT3_fb.hasClass('player--2')) {
                     feedbackText = "<strong>Objective</strong><br>Explosion started...";
                 } else {
                     feedbackText = "<strong>Objective</strong><br>Click your dot next to the opponent\'s dot."; // Made color-neutral
                 }
            }
            break;
        case 4:
             if ($(".dot.increment").length > 0) {
                 feedbackText = "<strong>Objective</strong><br>Watch the chain reaction!";
             } else if (tutorialStep4Clicked) {
                 feedbackText = "<strong>Objective</strong><br>Nice chain! Objective met.";
             } else {
                 feedbackText = "<strong>Objective</strong><br>Click any of your blinking dots to start the chain.";
             }
            break;
        case 5:
            feedbackText = "<strong>Congratulations!</strong><br>You finished the tutorial. Click 'Start Level 1' to play.";
            break;
        default:
             feedbackText = "";
    }

    if (feedbackText) {
        $('#tutorial-step-objective').html(feedbackText);
    }
}

$('#btn-quit-tutorial').on('click', function() {
    if (!isTutorialMode) return;

    isTutorialMode = false;
    tutorialStep = 0;

    $('.tutorial-step-modal').removeClass('active');
    $('body').removeClass('modal-open no-backdrop');
});

function getStageNumber(dotElement) {
    const classes = dotElement.attr('class') || '';
    const match = classes.match(/stage--(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

function checkDotmination() {
  if (isTutorialMode && tutorialStep < 5) {
    return; 
  }

  const isGameOver = !(moveAmount < 2 || ($(".dot.player--1").length > 0 && $(".dot.player--2").length > 0));

  if (!isMultiplayer) {
    if (!isGameOver) {
      nextPlayer();
    } else {
      stop();
      sound.play();
      
      // Restore Single-Player Overlay Logic 
      if (currentPlayer == "player--2") { // Player 2 (usually User) is the one who made the winning move
          // --- User Wins --- 
          if (gameMode === 'random') {
            // Calculate stars for random mode
            if(moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 120) {
              var goalMoves = 'active';
            } else {
              var goalMoves = '';
            }
    
            if(moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 60) {
              var goalTime = 'active';
            } else {
              var goalTime = '';
            }
            
            // Show random mode win screen
            $("body .container").append(
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
              '</div>'
            );
            
            TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});

          } else if (level < 100) { // Regular mode win
            if($('body').hasClass('mode-regular')) {
              var levelObj = {'level': level};
              myDotmination['level'] = level;
              
              timeBest = (levelsArray['level' + level] !== undefined) ? levelsArray['level' + level].time : null;
              // Ensure timeBest is treated as duration for subtraction
              let timeBestDuration = timeBest ? moment.duration('00:'+timeBest) : moment.duration(0);
              timeDiff = moment.duration('00:'+$('#time').html()).subtract(timeBestDuration).asMilliseconds();
              
              $('.timediff').remove();
              
              if(timeBest === null || timeDiff < 0) {
                levelsArray['level' + level] = {'time': $('#time').html()};
                myDotmination['levels'] = levelsArray;
              }
              
              if (level < 100 && !levelsArray['level' + (level + 1)]) {
                levelsArray['level' + (level + 1)] = {'time': null};
                myDotmination['levels'] = levelsArray;
              }
              
              myStorage.setObj("myDotmination", myDotmination);
              updateLevelList();
              
              var hasTime = levelsArray['level' + level] && levelsArray['level' + level].time && levelsArray['level' + level].time !== null;
              var wonStarClass = hasTime ? 'active' : '';
              var goalMoves = (moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 120) ? 'active' : '';
              var goalTime = (moment.duration('00:'+$('#time').html()).asSeconds() != 0 && moment.duration('00:'+$('#time').html()).asSeconds() < 60) ? 'active' : '';
              
              $("body .container").append(
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
                '</div>'
              );
              
              TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
            }
          } else { // Level 100 win (loop back)
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
          // --- User Lost --- 
          $("body .container").append(
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
            '</div>'
          );
          TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
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

// << NEW: Start Level 1 Button Handler (after tutorial) >>
$('#btn-start-level-1').on('click', function() {
    if (!isTutorialMode || tutorialStep !== 5) return; // Only act on step 5
    console.log("Starting Level 1 after tutorial completion...");
    endTutorial(); // This function handles the transition
});