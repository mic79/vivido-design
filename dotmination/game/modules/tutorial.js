// Manages the interactive tutorial flow and state.
// Interacts with script.js for game actions and UI updates,
// using some globally scoped `window` variables for shared state.

// REMOVED: import * as state from './state.js';
// REMOVED: import * as ui from './ui.js';
// REMOVED: import * as gameLogic from './gameLogic.js';
// REMOVED: import * as storage from './storage.js';
// REMOVED: import * as audio from './audio.js';
import { resetTimer, stopTimer, showTimer, startTimer } from './utils.js'; // Keeping showTimer and startTimer. Removing only isEven.
// Note: Assuming gsap, jQuery, Howl (sound, incrementSound), global functions (buildMapFromString, etc.),
// and global variables (isTutorialMode, tutorialStep, etc.) are available from script.js

// --- Module-scoped variables to hold references from script.js ---
let _checkUrlParameters;
let _startAnim;
let _clearPlayfield;
let _setDots;
let _buildMapFromString;
let _updatePlayerScoresUI;
let _updatePlayerIndicators;
let _getStageNumber;
let _incrementDotStage;
let _dots; // Reference to the jQuery object/NodeList
let _currentPlayer; // String: "player--1" or "player--2"
let _playerArray; // Array: ["player--1", "player--2"]
let _delayedCall; // GSAP delayed call object
let _gameMode; // To store reference to gameMode from script.js
let _level; // Number
let _cleanup;
let _resetMultiplayerState;
let _botDifficulty; // To store reference to botDifficulty from script.js

// Add this flag initialization if not already present (it might be added later)
// window.advancingTutorialStep = false;

// --- Initialization Function ---
export function initialize(refs) {
    console.log("Initializing tutorial module dependencies...");
    _checkUrlParameters = refs.checkUrlParametersFunc;
    _startAnim = refs.startAnimFunc;
    _clearPlayfield = refs.clearPlayfieldFunc;
    _setDots = refs.setDotsFunc;
    _buildMapFromString = refs.buildMapFromStringFunc;
    _updatePlayerScoresUI = refs.updatePlayerScoresUIFunc;
    _updatePlayerIndicators = refs.updatePlayerIndicatorsFunc;
    _getStageNumber = refs.getStageNumberFunc;
    _incrementDotStage = refs.incrementDotStageFunc;
    _dots = refs.dotsRef; // Assuming script.js passes the live reference
    _currentPlayer = refs.currentPlayerRef; // Assuming script.js passes it initially
    _playerArray = refs.playerArrayRef;
    _delayedCall = refs.delayedCallRef; // Pass the reference
    _gameMode = refs.gameModeRef; // Store gameMode reference
    _level = refs.levelRef;
    _cleanup = refs.cleanupFunc;
    _resetMultiplayerState = refs.resetMultiplayerStateFunc;
    _botDifficulty = refs.botDifficultyRef; // Store botDifficulty reference

    // Log checks
     if (typeof _checkUrlParameters !== 'function') console.error("Tutorial Init: checkUrlParameters function missing!");
     if (typeof _startAnim !== 'function') console.error("Tutorial Init: startAnim function missing!");
     if (typeof _clearPlayfield !== 'function') console.error("Tutorial Init: clearPlayfield function missing!");
     if (typeof _incrementDotStage !== 'function') console.error("Tutorial Init: incrementDotStage function missing!");
     if (typeof _gameMode !== 'object' || _gameMode.value === undefined) console.warn("Tutorial Init: gameModeRef might not be correctly passed as a reference object.");
     if (typeof _botDifficulty !== 'object' || _botDifficulty.value === undefined) console.warn("Tutorial Init: botDifficultyRef might not be correctly passed as a reference object.");
    console.log("Tutorial module initialized.");
}

// --- Private Helper Functions (Adapted to use internal refs) ---

function advanceTutorialStep() {
    // console.log("TUTORIAL: advanceTutorialStep CALLED. Current step (before inc):", window.tutorialStep);
    // Use global tutorialStep variable
    window.tutorialStep++;
    // console.log(`Advancing to Tutorial Step ${window.tutorialStep}`);

    if (window.tutorialStep > 5) { // Assuming 5 steps T1-T5
        endTutorial(); // Call the exported endTutorial
        window.advancingTutorialStep = false; // Reset flag as tutorial is ending
        window.tutorialActionInProgress = { step: null, index: null }; // Reset action flag
        return;
    }

    // Explicitly hide welcome modal before showing step modal (using jQuery)
    $('.welcome-tutorial-modal').removeClass('active');

    // Setup board and show instructions for the current step
    setupTutorialBoard(window.tutorialStep);
    showTutorialStepModal(window.tutorialStep);
    window.advancingTutorialStep = false; // Reset flag after new step is set up
    window.tutorialActionInProgress = { step: null, index: null }; // Reset action flag for new step
}

function setupTutorialBoard(step) {
    console.log(`Setting up board for Tutorial Step ${step}`);
    // Stop timer if running (using utils)
    stopTimer();
    resetTimer();

    // Clear state for checks (using window vars)
    window.tutorialTargetDotIndex = -1; // This IS used by script.js, KEEP IT.
    window.tutorialChainStartIndices = [];
    window.tutorialStep4Clicked = false; // Reset flag

    // Estimate dot count if field is empty (e.g., on first load)
    // Use internal _dots variable
    if (!_dots || _dots.length === 0) {
         _dots = $('.field .dot'); // Query DOM if internal _dots is empty/null
    }
    const currentDotCount = _dots ? _dots.length : 0;
    const estimatedDotCount = currentDotCount > 0 ? currentDotCount : 45; // Default to 45 if no dots exist
    const emptyMap = Array(estimatedDotCount).fill('0').join('');

    // T2: P2 Stage 1 (6) at index 15 (original script used '6')
    const TUTORIAL_MAP_T2 = emptyMap.substring(0, 15) + '6' + emptyMap.substring(16);

    // T3: P1 Stage 3 (3) at index 10, P2 Stage 5 (A) at index 11
    const TUTORIAL_MAP_T3 = emptyMap.substring(0, 10) + '3A' + emptyMap.substring(12);

    // T4: P2 Stage 5 (A) at indices 5, 11, 15 and P1 Stage 5 (5) at indices 7, 10
    let t4Arr = emptyMap.split('');
    const p2IndicesT4 = [5, 11, 15];
    const p1IndicesT4 = [7, 10];
    p2IndicesT4.forEach(i => { if(i < t4Arr.length) t4Arr[i] = 'A'; }); // P2 Stage 5 (5+5=A hex)
    p1IndicesT4.forEach(i => { if(i < t4Arr.length) t4Arr[i] = '5'; }); // P1 Stage 5
    const TUTORIAL_MAP_T4 = t4Arr.join('');


    let mapToLoad = "";
    let loadMap = true; // Flag to indicate if buildMapFromString should be called

    switch (step) {
      case 1: // T1: Claim 3 dots
        mapToLoad = emptyMap;
        break;
      case 2: // T2: Make dot explode
        mapToLoad = TUTORIAL_MAP_T2;
        window.tutorialTargetDotIndex = 15; // Set the global for Step 2 check in script.js
        break;
      case 3: // T3: Explode to capture
        mapToLoad = TUTORIAL_MAP_T3;
        window.tutorialTargetDotIndex = 10; // Set the global for Step 3 check (opponent's dot)
        break;
      case 4: // T4: Chain reaction
        mapToLoad = TUTORIAL_MAP_T4;
        window.tutorialChainStartIndices = p2IndicesT4; // Use global var
        break;
      case 5: // T5: Completion Screen
        loadMap = false; // Prevent buildMapFromString
        break;
    }

    // Only clear and repopulate board if NOT step 5
    if (step !== 5) {
      // Clear field completely first using internal _clearPlayfield
      // Use the startingPlayer argument (P2 for tutorial)
      if (typeof _clearPlayfield === 'function' && _playerArray) {
          _clearPlayfield('blank', _playerArray[1]); // Use internal _playerArray
      } else {
          console.error("Tutorial Setup: _clearPlayfield function or _playerArray not initialized!");
          // Manual fallback
          $(".field").empty().removeClass(_playerArray ? _playerArray.join(" ") : 'player--1 player--2');
          if(typeof _setDots === 'function') _setDots(); else console.error("Tutorial Setup: _setDots function not initialized!");
          _dots = $('.field .dot');
      }

      // Load the map string if required for the step (using internal _buildMapFromString)
      if (loadMap && mapToLoad) {
        if (typeof _buildMapFromString === 'function') {
            if (!_buildMapFromString(mapToLoad)) {
                 console.error(`Tutorial Step ${step}: Failed to build map from string!`);
                 _buildMapFromString(emptyMap); // Fallback
            }
        } else {
            console.error("Tutorial Setup: _buildMapFromString function not initialized!");
        }
      }
      // Ensure internal _dots variable is updated after clear/build
      _dots = $('.field .dot');

    } else {
        // Ensure internal _dots reference is up-to-date for step 5 if not reset
        if (!_dots || _dots.length === 0) {
            _dots = $('.field .dot');
        }
    }

    // Set initial player (User = Player 2) using internal variables
    _currentPlayer = _playerArray ? _playerArray[1] : "player--2";
    $(".field").removeClass(_playerArray ? _playerArray.join(" ") : 'player--1 player--2').addClass(_currentPlayer); // Ensure field has correct player class
    gsap.to("html", {duration: 0, "--color-current": 'var(--color-2)'});

    // Update scores, etc. using internal functions
    if (typeof _updatePlayerScoresUI === 'function') _updatePlayerScoresUI(); else console.error("Tutorial Setup: _updatePlayerScoresUI function not initialized!");

    // Turn indicator logic
    if (step < 5) {
        $('.turn-indicator').remove();
        $('.players .player').removeClass('current');
    } else {
        // No turn indicator needed on completion screen
        $('.turn-indicator').remove();
        $('.players .player').removeClass('current');
    }
    if (typeof _updatePlayerIndicators === 'function') _updatePlayerIndicators(); else console.error("Tutorial Setup: _updatePlayerIndicators function not initialized!");

    // Disable bot for all tutorial steps (use internal _delayedCall)
    if (_delayedCall) {
      if (typeof _delayedCall.kill === 'function') {
        _delayedCall.kill();
      }
      _delayedCall = null; // Clear internal ref
    }
}

function showTutorialStepModal(step) {
    let title = "";
    let instruction = "";
    let objective = ""; // Initial objective text

    switch (step) {
      case 1:
        title = '<small>Step 1</small><br><span style="color:var(--color-2)">Claiming Dots</span>';
        instruction = 'The game field is made of dots. Each turn you can add 1 dot. Click on empty dots to claim them for your color (<span style="color:var(--color-2)">Player 2</span>).';
        objective = '<strong>Objective</strong><br>Claim any 3 empty dots.';
        break;
      case 2:
        title = '<small>Step 2</small><br><span style="color:var(--color-2)">Growing Dots</span>';
        instruction = 'Clicking your own dot again makes it grow +1. Dots grow from Stage 1 up to Stage 5.';
        objective = '<strong>Objective</strong><br>Click the center dot until it reaches Stage 5.';
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
        objective = '&nbsp;'; // Objective set by dynamic feedback
        break;
    }

    $('#tutorial-step-title').html(title);
    $('#tutorial-step-instruction').html(instruction);
    $('#tutorial-step-objective').html(objective); // Set initial objective

    // Show the modal after a short delay (using jQuery)
    setTimeout(() => {
        // Ensure other modals are closed before opening
        $('.modal').removeClass('active');
        $('.tutorial-step-modal').addClass('active'); // Open modal directly
        $('body').addClass('modal-open no-backdrop'); // Add class to prevent blur
    }, 300); // Adjust delay as needed

    // Add/Remove step-5 class for button visibility
    if (step === 5) {
      $('.tutorial-step-modal').addClass('step-5');
    } else {
      $('.tutorial-step-modal').removeClass('step-5');
    }
    // Ensure feedback is updated when modal appears
    updateTutorialFeedback(step, -1);
}

// Internal function to check completion logic
function checkTutorialStepCompletionInternal(step, targetIndex) {
    console.log(`Checking completion for Step ${step}, Target Index: ${targetIndex}`);
    // Use internal _dots reference
    if (!_dots || _dots.length === 0) _dots = $('.field .dot');
    if (targetIndex < 0) { 
        if (step === 2 || step === 3) { 
             console.warn(`Tutorial Check: Invalid targetIndex ${targetIndex} for Step ${step}`);
             return false; 
        }
    } 
    else if (targetIndex >= _dots.length) { 
         console.warn(`Tutorial Check: targetIndex ${targetIndex} out of bounds (Dots: ${_dots.length})`);
         return false; 
    }

    // Use internal _getStageNumber reference
    if (typeof _getStageNumber !== 'function') {
        console.error("Tutorial Check: _getStageNumber function not initialized!");
        return false;
    }
    const getStage = (index) => {
        const dot = _dots.eq(index);
        return dot.length ? _getStageNumber(dot) : 0;
    };

    switch (step) { // Use passed step parameter
        case 1: // T1: Claim 3 dots
            const claimedDots = _dots.filter('.player--2').length;
            console.log(`Step 1 Check: Claimed ${claimedDots} dots`);
            return claimedDots >= 3;
        case 2: // T2: Make dot explode (reach Stage 5)
            // Check the stage of the specific dot that was clicked (targetIndex)
            const stageT2 = getStage(targetIndex);
            console.log(`Step 2 Check: Dot ${targetIndex} is Stage ${stageT2}`);
            return stageT2 >= 5; // Objective: Reach Stage 5
        case 3: // T3: Explode to capture
            // Check if the opponent's dot (index 10) is now P2's color
            const opponentDot = _dots.eq(10); // Opponent dot is at index 10
            const isCaptured = opponentDot && opponentDot.hasClass('player--2');
            console.log(`Step 3 Check: Opponent dot (10) captured? ${isCaptured}`);
            return isCaptured;
        case 4: // T4: Chain reaction (Check if at least one opponent dot was captured)
            // Check if ANY dot that started as P1 (indices 7, 10) is now P2
            const p1IndicesT4 = [7, 10];
            const chainCaptureOccurred = p1IndicesT4.some(index => {
                const dot = _dots.eq(index);
                return dot && dot.hasClass('player--2');
            });
            console.log(`Step 4 Check: Chain capture occurred? ${chainCaptureOccurred}`);
            return chainCaptureOccurred || window.tutorialStep4Clicked; // Use the flag set in handleTutorialDotClick if direct check fails
        default:
            return false; // No check needed for other steps
    }
}

// Internal function to update objective text/feedback
function updateTutorialFeedback(step, targetIndex) {
    console.log(`Updating feedback for Step ${step}, Target Index: ${targetIndex}`);
    // Use internal _dots reference
    if (!_dots || _dots.length === 0) _dots = $('.field .dot');

    // Use internal _getStageNumber reference
    if (typeof _getStageNumber !== 'function') {
        console.error("Tutorial Feedback: _getStageNumber function not initialized!");
        return;
    }
    const getStage = (index) => {
        if (index < 0 || index >= _dots.length) {
            console.warn(`Tutorial Feedback getStage: Invalid index ${index}`);
            return 0;
        }
        const dot = _dots.eq(index);
        return dot.length ? _getStageNumber(dot) : 0;
    };

    let objectiveText = "";
    const objectiveElement = $('#tutorial-step-objective');

    switch (step) { // Use passed step parameter
        case 1: // T1: Claim 3 dots
            const claimedDots = _dots.filter('.player--2').length;
            objectiveText = `<strong>Objective</strong><br>Claim any 3 empty dots. (${claimedDots}/3 claimed)`;
            break;
        case 2: // T2: Make dot explode
            if (targetIndex !== -1 && targetIndex < _dots.length) {
                const stageT2 = getStage(targetIndex);
                if (stageT2 < 5) {
                    objectiveText = `<strong>Objective</strong><br>Click the center dot until it reaches Stage 5.<br>(Currently Stage ${stageT2}/5)`;
                } else {
                    objectiveText = `<strong>Objective</strong><br>Dot reached Stage 5! Click it again to see it explode.`; // Should actually advance here
                }
            } else {
                 // Fallback or initial text if targetIndex is invalid somehow
                 objectiveText = '<strong>Objective</strong><br>Click the <span style="color:var(--color-2)">center dot</span> until it reaches Stage 5.';
            }
            break;
        case 3: // T3: Explode to capture
            // Check if the opponent's dot (index 10) is captured
             const opponentDot = _dots.eq(10); // Original opponent dot index is 10
             if (opponentDot && opponentDot.hasClass('player--2')) {
                objectiveText = `<strong>Objective</strong><br>Opponent's dot captured!`;
            } else {
                 // Check if player dot (index 11) is Stage 5
                 if (targetIndex === 11) { // Check if the click was on the player's dot (index 11)
                    const stageT3 = getStage(targetIndex);
                     if(stageT3 >= 5) {
                        objectiveText = `<strong>Objective</strong><br>Click <span style="color:var(--color-2)">your Stage 5 dot</span> again to take over the opponent's dot.`;
                    } else {
                         // This case shouldn't normally happen as setup places a Stage 5 dot for player
                         objectiveText = `<strong>Objective</strong><br>Click <span style="color:var(--color-2)">your dot</span> until it's Stage 5, then click again.`;
                    }
                 } else {
                    // Initial state or clicked wrong dot
                    objectiveText = `<strong>Objective</strong><br>Click <span style="color:var(--color-2)">your Stage 5 dot</span> to take over the opponent's dot.`;
                 }
            }
            break;
        case 4: // T4: Chain reaction
            // Check if chain capture occurred or flag set
            const p1IndicesT4 = [7, 10];
            const chainCaptureOccurred = p1IndicesT4.some(index => {
                 const dot = _dots.eq(index);
                 return dot && dot.hasClass('player--2');
             });
            if (chainCaptureOccurred || window.tutorialStep4Clicked) {
                objectiveText = `<strong>Objective</strong><br>Chain reaction complete!`;
            } else {
                objectiveText = `<strong>Objective</strong><br>Click one of <span style="color:var(--color-2)">your dots</span> to start a chain reaction.`;
            }
            break;
        case 5: // T5: Completion Screen
             objectiveText = `&nbsp;`;
            break;
        default:
            objectiveText = "&nbsp;"; // Default empty
            break;
    }

    objectiveElement.html(objectiveText); // Update the objective text
}


// --- Exported Functions ---

export function startTutorialFlow() {
    console.log('Starting Tutorial Flow (Module) - Modal only');
    // <<< Initialize advancement flag (if still used by other parts of tutorial.js, keep it) >>>
    // window.advancingTutorialStep = false; 
    // window.tutorialActionInProgress = { step: null, index: null };

    window.isTutorialMode = true; // Global flag for script.js checks
    window.tutorialStep = 0;    // Start at welcome/step 0

    // Ensure other modals are closed and tutorial welcome modal is shown
    $('.modal').removeClass('active');
    $('.tutorial-step-modal').removeClass('active'); // Explicitly hide step modal
    $('.welcome-tutorial-modal').addClass('active');
    $('body').addClass('modal-open'); // To show modal overlay
    // $('body').removeClass('no-backdrop'); // Let default modal backdrop behavior apply
}

export function checkStartTutorial() {
    // Read from localStorage first
    window.hasPlayedBefore = localStorage.getItem('hasPlayedBefore') === 'true';

    console.log('checkStartTutorial called. hasPlayedBefore:', window.hasPlayedBefore);

    const urlParams = new URLSearchParams(window.location.search);
    const mode = urlParams.get('mode');
    // const map = urlParams.get('map'); // Not used for starting anim here
    // const difficulty = urlParams.get('difficulty'); // Not used for starting anim here
    const joinId = urlParams.get('join'); // Check for join ID specifically

    if (!window.hasPlayedBefore && !mode && !joinId) { // Only start tutorial if no specific mode/join is requested
        startTutorialFlow(); // This will now ONLY show the welcome modal
    } else {
        // If it's not a first-time user for the tutorial, or URL overrides,
        // set tutorial mode to false. Actual game start (startAnim)
        // will be handled by script.js's $(document).ready or signinAnim.onComplete.
        window.isTutorialMode = false;
        console.log("checkStartTutorial: Not a new user for tutorial OR URL mode override. Tutorial inactive. Game start handled by script.js.");

        // Still ensure gameMode and related parameters are updated from URL if present,
        // as script.js logic might depend on these values being fresh.
        if (mode) {
            if (_gameMode && typeof _gameMode.value !== 'undefined') {
                 _gameMode.value = mode;
            } else {
                console.warn("checkStartTutorial: _gameMode reference not available to set mode from URL.");
            }
            if (mode === 'random') {
                if (_botDifficulty && typeof _botDifficulty.value !== 'undefined') {
                    _botDifficulty.value = urlParams.get('difficulty') || 'random';
                } else {
                    console.warn("checkStartTutorial: _botDifficulty reference not available to set from URL.");
                }
            }
            // Call _checkUrlParameters from script.js to handle further URL-specific setups
            // like setting level for 'regular' mode, and setting body classes.
            if(typeof _checkUrlParameters === 'function') {
                _checkUrlParameters(); // This function in script.js also sets body classes.
            } else {
                console.error("checkStartTutorial: _checkUrlParameters function reference not found!");
            }
        }
        // DO NOT call _startAnim() from here. Let script.js handle it.
    }
}

export function handleWelcomeStartClick() {
    console.log("Welcome modal 'Start Tutorial' clicked.");
    localStorage.setItem('hasPlayedBefore', 'true'); // Mark as played
    window.hasPlayedBefore = true;
    $('.welcome-tutorial-modal').removeClass('active');
    $('body').removeClass('modal-open no-backdrop'); // Remove no-backdrop on close
    advanceTutorialStep(); // Move to step 1
}

export function endTutorial() {
    console.log("Ending Tutorial (Module - Tutorial Scope Only)");
    window.isTutorialMode = false;
    window.tutorialStep = 0;
    window.tutorialStep4Clicked = false;
    window.tutorialChainStartIndices = [];

    $('.tutorial-step-modal').removeClass('active');
    $('.welcome-tutorial-modal').removeClass('active'); // Ensure welcome modal is also closed
    $('body').removeClass('no-backdrop modal-open'); // Remove both classes
    console.log("Tutorial UI elements hidden and flags reset.");
}

export function quitTutorial() {
    console.log("Quitting Tutorial (Module - Global Dep)");
    // Use global localStorage, hasPlayedBefore
    localStorage.setItem('hasPlayedBefore', 'true');
    window.hasPlayedBefore = true;
    endTutorial(); // Local call
}

export function handleTutorialDotClick(clickedIndex) {
    console.log(`Tutorial Dot Click: Index ${clickedIndex}, Current Step: ${window.tutorialStep}`);
    // Use internal _dots, _currentPlayer, _playerArray
    if (!_dots || _dots.length === 0) _dots = $('.field .dot'); // Ensure dots ref is valid

    if (clickedIndex < 0 || clickedIndex >= _dots.length) {
        console.warn("Tutorial: Invalid dot index clicked.");
        return true; // Still handled by tutorial module
    }

    const $dot = _dots.eq(clickedIndex);
    const dotOwner = $dot.hasClass('player--1') ? _playerArray[0] : ($dot.hasClass('player--2') ? _playerArray[1] : 'empty');
    const isPlayerDot = dotOwner === _currentPlayer; // User is always Player 2 (_currentPlayer)
    const isOpponentDot = dotOwner !== 'empty' && !isPlayerDot;
    const isEmptyDot = dotOwner === 'empty';

    // MOVED: window.tutorialCheckInfo = null; 

    // Step-specific click handling
    switch (window.tutorialStep) {
        case 1: // T1: Claim 3 dots - NO ANIMATION, check immediately
            window.tutorialCheckInfo = null; // Clear for new action or if no action needed
            if (isEmptyDot) {
                console.log("Step 1: Claiming empty dot.");
                // Use the internal reference _incrementDotStage
                 if (typeof _incrementDotStage === 'function') {
                    _incrementDotStage($dot); // <<< PASS $dot OBJECT
                    // Update feedback AFTER incrementing
                    updateTutorialFeedback(window.tutorialStep, clickedIndex); // Pass step and index
                    // Check completion AFTER incrementing
                    if (checkTutorialStepCompletionInternal(window.tutorialStep, clickedIndex)) { // Pass step and index
                        console.log("Step 1 Completed. Advancing...");
                         advanceTutorialStep();
                    }
                 } else {
                    console.error("Tutorial Click: _incrementDotStage function not initialized!");
                 }
            } else {
                //console.log("Step 1: Clicked non-empty dot (ignored). Dot owner: " + dotOwner);
                // Optionally provide feedback: "Click only empty dots"
            }
            break;

        case 2: // T2: Make dot explode (reach Stage 5) - ANIMATES, check on completion
            if (window.tutorialActionInProgress.step === window.tutorialStep && window.tutorialActionInProgress.index === clickedIndex) {
                console.log(`Step ${window.tutorialStep}: Action already in progress for dot ${clickedIndex}. Ignoring click.`);
                return true; // Keep existing tutorialCheckInfo, don't clear it
            }
            window.tutorialCheckInfo = null; // Clear for new action
            if (clickedIndex === 15 && isPlayerDot) {
                console.log("Step 2: Incrementing target dot. Storing check info.");
                window.tutorialActionInProgress = { step: window.tutorialStep, index: clickedIndex }; // Set action flag
                window.tutorialCheckInfo = { step: window.tutorialStep, index: clickedIndex };
                 if (typeof _incrementDotStage === 'function') {
                    _incrementDotStage($dot);
                 } else {
                    console.error("Tutorial Click: _incrementDotStage function not initialized!");
                 }
            } else {
                console.log(`Step 2: Clicked wrong dot (${clickedIndex}) or non-player dot.`);
            }
            break;

        case 3: // T3: Explode to capture opponent - ANIMATES, check on completion
            if (window.tutorialActionInProgress.step === window.tutorialStep && window.tutorialActionInProgress.index === clickedIndex) {
                //console.log(`Step ${window.tutorialStep}: Action already in progress for dot ${clickedIndex}. Ignoring click.`);
                return true; // Keep existing tutorialCheckInfo, don't clear it
            }
            window.tutorialCheckInfo = null; // Clear for new action
            if (clickedIndex === 11 && isPlayerDot) {
                console.log("Step 3: Incrementing player dot (index 11). Storing check info.");
                window.tutorialActionInProgress = { step: window.tutorialStep, index: clickedIndex }; // Set action flag
                 window.tutorialCheckInfo = { step: window.tutorialStep, index: clickedIndex };
                 if (typeof _incrementDotStage === 'function') {
                     _incrementDotStage($dot);
                 } else {
                     console.error("Tutorial Click: _incrementDotStage function not initialized!");
                 }
            } else {
                console.log(`Step 3: Clicked wrong dot (${clickedIndex}), non-player dot, or not dot 11.`);
            }
            break;

        case 4: // T4: Chain reaction - ANIMATES, check on completion
            if (window.tutorialActionInProgress.step === window.tutorialStep && window.tutorialActionInProgress.index === clickedIndex) {
                console.log(`Step ${window.tutorialStep}: Action already in progress for dot ${clickedIndex}. Ignoring click.`);
                return true; // Keep existing tutorialCheckInfo, don't clear it
            }
            window.tutorialCheckInfo = null; // Clear for new action
             const playerStartIndicesT4 = [5, 11, 15];
             if (playerStartIndicesT4.includes(clickedIndex) && isPlayerDot) {
                 //console.log("Step 4: Triggering chain reaction. Storing check info.");
                 window.tutorialActionInProgress = { step: window.tutorialStep, index: clickedIndex }; // Set action flag
                 window.tutorialStep4Clicked = true; // This flag might be used by checkTutorialStepCompletionInternal
                 window.tutorialCheckInfo = { step: window.tutorialStep, index: clickedIndex }; // Set for the new action
                 if (typeof _incrementDotStage === 'function') {
                     _incrementDotStage($dot);
                 } else {
                     console.error("Tutorial Click: _incrementDotStage function not initialized!");
                 }
             } else {
                 console.log(`Step 4: Clicked wrong dot (${clickedIndex}) or non-player dot.`);
             }
            break;

        default:
            window.tutorialCheckInfo = null; // Clear if step doesn't use it
            //console.log(`Tutorial: Click ignored in step ${window.tutorialStep}`);
            break;
    }
    return true;
}

// Called by script.js (e.g., animateNextDot callback) to check completion AFTER animations/effects.
export function handleTutorialCompletionCheck(step, targetIndex) {
    // Check for completion based on the state AFTER the action/animation triggered by targetIndex
    // console.log(`TUTORIAL: handleTutorialCompletionCheck for Step ${step}, Target Index: ${targetIndex}`);

    // Update feedback based on the potentially new state
    updateTutorialFeedback(step, targetIndex); // Pass step and index

    const objectiveMet = checkTutorialStepCompletionInternal(step, targetIndex);
    // console.log(`TUTORIAL: objectiveMet = ${objectiveMet} for Step ${step}`);

    if (objectiveMet) {
        // console.log(`TUTORIAL: Step ${step} objective met. Current advancingTutorialStep: ${window.advancingTutorialStep}`);
        
        if (window.advancingTutorialStep) {
            // console.log("TUTORIAL: Advancement already in progress, skipping duplicate call to advance.");
            // DO NOT reset tutorialActionInProgress here. It should persist until the step actually changes
            // or if the initial action failed (handled in the 'else' block).
            return;
        }
        window.advancingTutorialStep = true;
        // console.log("TUTORIAL: Set advancingTutorialStep = true. Scheduling advanceTutorialStep call.");
        // DO NOT reset tutorialActionInProgress here. The action for the current step/dot is considered
        // "in progress" (i.e., successfully initiated and awaiting step transition) until advanceTutorialStep completes
        // and resets it for the *new* step.

        setTimeout(() => {
            // console.log("TUTORIAL: setTimeout fired. Calling advanceTutorialStep. Current step (before call):", window.tutorialStep);
            advanceTutorialStep(); // This will set advancingTutorialStep to false and reset tutorialActionInProgress for the new step
        }, 150); // Small delay before advancing
    } else {
        // console.log(`TUTORIAL: Step ${step} objective NOT met after check.`);
        // If objective not met, the action for this dot is considered over, allow retry.
        window.tutorialActionInProgress = { step: null, index: null }; 
    }
}

export function isTutorialActive() {
    // Use global isTutorialMode
    return window.isTutorialMode === true;
}

// Helper function to get stage number (0-5) from a dot element
function getStageNumber(dotElement) {
  for (let i = 1; i <= 5; i++) {
    if (dotElement.hasClass(`stage--${i}`)) {
      return i;
    }
  }
  return 0; // Not claimed or stage 0
} 