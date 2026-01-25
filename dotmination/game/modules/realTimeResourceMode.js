// Dotmination - Real-Time Resource Mode Module

// --- Configuration ---
const INITIAL_RESOURCES = 25;
const RESOURCE_GAIN_INTERVAL = 2000; // ms (2 seconds)
const RESOURCE_GAIN_AMOUNT = 1;
const ACTION_COOLDOWN_DURATION = 100; // ms (0.1 second)
const BOT_THINK_INTERVAL = 200; // ms, how often the bot considers a move

// --- State Variables ---
let player1Resources = 0;
let player2Resources = 0;

let player1CooldownActive = false;
let player2CooldownActive = false;

let resourceIntervalId = null;
let botIntervalId = null;

// --- References to main game functions/variables (will be set by initialize) ---
let mainIncrementDotStage = null;
let mainUpdatePlayerScoresUI = null; // We'll use this to update resource display
let mainGetStageNumber = null;
let mainDots = null; // Reference to the jQuery collection of dots
let mainPlayerArray = null;
let mainBotGetMove = null; // Reference to the original bot logic for adaptation
let mainIsEven = null;
let mainCheckDotmination = null;
let mainShowTimer = null;
let mainResetTimer = null;
let mainStartTimer = null;
let mainStopTimer = null;
let mainAnimateNextDot = null;
let mainSetDots = null; // For initial board setup
let mainBuildMapFromString = null; // For initial board setup

// --- UI Elements ---
let $player1ScoreDisplay = null; // Will be #player-1-score
let $player2ScoreDisplay = null; // Will be #player-2-score

// --- Chain Reaction Lock for RTS Mode ---
let chainInProgress = false;

// --- Pathfinding and Visualization for Bot Aggression ---

// Board dimensions (should match script.js)
const BOT_ROWS = 9;
const BOT_COLS = 5;

// Convert dot index to (row, col)
function indexToCoord(index) {
    let idx = 0;
    for (let row = 0; row < BOT_ROWS; row++) {
        let colsInRow = mainIsEven(row) ? BOT_COLS - 1 : BOT_COLS;
        if (index < idx + colsInRow) {
            return { row, col: index - idx };
        }
        idx += colsInRow;
    }
    return null;
}
// Convert (row, col) to dot index
function coordToIndex(row, col) {
    if (row < 0 || row >= BOT_ROWS) return -1;
    let idx = 0;
    for (let r = 0; r < row; r++) {
        idx += mainIsEven(r) ? BOT_COLS - 1 : BOT_COLS;
    }
    let colsInRow = mainIsEven(row) ? BOT_COLS - 1 : BOT_COLS;
    if (col < 0 || col >= colsInRow) return -1;
    return idx + col;
}
// Get neighbor indices for a given index
function getNeighborIndices(index) {
    const coord = indexToCoord(index);
    if (!coord) return [];
    const { row, col } = coord;
    const neighbors = [];
    const even = mainIsEven(row);
    // Up
    if (row > 0) {
        let upCols = mainIsEven(row - 1) ? BOT_COLS - 1 : BOT_COLS;
        if (col < upCols) neighbors.push(coordToIndex(row - 1, col));
    }
    // Down
    if (row < BOT_ROWS - 1) {
        let downCols = mainIsEven(row + 1) ? BOT_COLS - 1 : BOT_COLS;
        if (col < downCols) neighbors.push(coordToIndex(row + 1, col));
    }
    // Left
    if (col > 0) neighbors.push(coordToIndex(row, col - 1));
    // Right
    let colsInRow = even ? BOT_COLS - 1 : BOT_COLS;
    if (col < colsInRow - 1) neighbors.push(coordToIndex(row, col + 1));
    // Up-left
    if (row > 0 && col > 0) {
        neighbors.push(coordToIndex(row - 1, col - 1));
    }
    // Down-left
    if (row < BOT_ROWS - 1 && col > 0) {
        neighbors.push(coordToIndex(row + 1, col - 1));
    }
    // Up-right
    if (row > 0) {
        let upCols = mainIsEven(row - 1) ? BOT_COLS - 1 : BOT_COLS;
        if (col < upCols - 1) neighbors.push(coordToIndex(row - 1, col + 1));
    }
    // Down-right
    if (row < BOT_ROWS - 1) {
        let downCols = mainIsEven(row + 1) ? BOT_COLS - 1 : BOT_COLS;
        if (col < downCols - 1) neighbors.push(coordToIndex(row + 1, col + 1));
    }
    // Filter out invalid indices
    return neighbors.filter(idx => idx >= 0 && idx < mainDots.length);
}
// Find the highest-stage opponent cell (returns index)
function findHighestStageOpponentCell() {
    let maxStage = -1, maxIdx = -1;
    mainDots.each(function(i) {
        if ($(this).hasClass(mainPlayerArray[1])) {
            const stage = mainGetStageNumber($(this));
            if (stage > maxStage) {
                maxStage = stage;
                maxIdx = i;
            }
        }
    });
    return maxIdx;
}
// Find the bot cell closest to a target index (returns index)
function findNearestBotCell(targetIdx) {
    let minDist = Infinity, minIdx = -1;
    mainDots.each(function(i) {
        if ($(this).hasClass(mainPlayerArray[0])) {
            const d = manhattanDist(indexToCoord(i), indexToCoord(targetIdx));
            if (d < minDist) {
                minDist = d;
                minIdx = i;
            }
        }
    });
    return minIdx;
}
function manhattanDist(a, b) {
    if (!a || !b) return Infinity;
    return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}
// BFS path from startIdx to goalIdx (returns array of indices)
function bfsPath(startIdx, goalIdx) {
    if (startIdx === -1 || goalIdx === -1) return [];
    const queue = [startIdx];
    const visited = new Set([startIdx]);
    const prev = {};
    while (queue.length > 0) {
        const curr = queue.shift();
        if (curr === goalIdx) break;
        for (const nIdx of getNeighborIndices(curr)) {
            if (!visited.has(nIdx)) {
                visited.add(nIdx);
                prev[nIdx] = curr;
                queue.push(nIdx);
            }
        }
    }
    // Reconstruct path
    let path = [];
    let curr = goalIdx;
    while (curr !== undefined && curr !== startIdx) {
        path.push(curr);
        curr = prev[curr];
    }
    if (curr === startIdx) path.push(startIdx);
    path.reverse();
    return path;
}
// Highlight path cells and draw SVG line
function visualizeBotPath(path) {
    // Remove previous highlights/lines
    mainDots.removeClass('bot-path');
    $('#bot-path-svg').remove();
    if (!path || path.length < 2) return;
    // Highlight cells
    for (const idx of path) {
        mainDots.eq(idx).addClass('bot-path');
    }
    // Draw SVG line overlay
    const svg = $('<svg id="bot-path-svg" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:50;"></svg>');
    let points = '';
    for (const idx of path) {
        const dot = mainDots.eq(idx);
        const offset = dot.offset();
        const fieldOffset = $('.field').offset();
        const x = offset.left - fieldOffset.left + dot.width()/2;
        const y = offset.top - fieldOffset.top + dot.height()/2;
        points += `${x},${y} `;
    }
    svg.append(`<polyline points="${points.trim()}" fill="none" stroke="#00F" stroke-width="4" stroke-opacity="0.5" stroke-linecap="round" stroke-linejoin="round" />`);
    $('.field').append(svg);
}

// --- Initialization and Teardown ---

/**
 * Initializes the Real-Time Resource mode.
 * Called when this game mode is selected and started.
 * @param {object} mainGameRefs - References to functions and variables from script.js
 */
export function initialize(mainGameRefs) {
    console.log("RTR Mode: Initializing...");
    mainIncrementDotStage = mainGameRefs.incrementDotStageFunc;
    mainUpdatePlayerScoresUI = mainGameRefs.updatePlayerScoresUIFunc; // Or a dedicated resource update function
    mainGetStageNumber = mainGameRefs.getStageNumberFunc;
    mainDots = mainGameRefs.dotsRef;
    mainPlayerArray = mainGameRefs.playerArrayRef;
    // mainBotGetMove = mainGameRefs.getBotMove; // We'll need to adapt this
    mainIsEven = mainGameRefs.isEvenFunc;
    mainCheckDotmination = mainGameRefs.checkDotminationFunc;
    mainShowTimer = mainGameRefs.showTimerFunc;
    mainResetTimer = mainGameRefs.resetTimerFunc;
    mainStartTimer = mainGameRefs.startTimerFunc;
    mainStopTimer = mainGameRefs.stopTimerFunc;
    mainAnimateNextDot = mainGameRefs.animateNextDotFunc;
    mainSetDots = mainGameRefs.setDotsFunc;
    mainBuildMapFromString = mainGameRefs.buildMapFromStringFunc;


    // Cache UI elements for resource display
    $player1ScoreDisplay = $('#player-1-score');
    $player2ScoreDisplay = $('#player-2-score');

    // Note: Bot logic adaptation will be more involved.
}

/**
 * Starts a new game in Real-Time Resource mode.
 */
export function startRealTimeResourceGame() {
    console.log("RTR Mode: Starting game...");

    // 1. Reset game state (timers, resources, cooldowns)
    resetModeState();

    // 2. Setup initial board: Empty, P1 owns index 6 (Stage 5), P2 owns index 33 (Stage 5)
    // This requires mainSetDots to create the grid, then we modify specific dots.
    if (typeof mainSetDots === 'function') {
        mainSetDots(); // Creates the grid of dots
    }
    mainDots = $('.dot'); // Re-fetch dots after mainSetDots

    // Clear all existing player/stage classes first
    if (mainDots && mainDots.length > 0) {
        mainDots.removeClass(function(index, className) {
            return (className.match(/(^|\s)(stage--|player--)\S+/g) || []).join(' ');
        }).attr("data-increment", "0"); // Reset increment attribute

        const p1InitialDot = mainDots.eq(6);
        const p2InitialDot = mainDots.eq(33);

        if (p1InitialDot.length) {
            p1InitialDot.removeClass(playerClassClear()).addClass('stage--5 ' + mainPlayerArray[0]);
        }
        if (p2InitialDot.length) {
            p2InitialDot.removeClass(playerClassClear()).addClass('stage--5 ' + mainPlayerArray[1]);
        }
    } else {
        console.error("RTR Mode: Dots not available for initial setup.");
        return;
    }
    
    // Ensure field class reflects the human player's perspective (Player 2)
    $('.field').removeClass(playerClassClear()).addClass(mainPlayerArray[1]); 
    // Set the current theme color to Player 2's color
    // Ensure gsap is available or use a fallback if it might not be loaded when this module runs standalone
    if (typeof gsap !== 'undefined') {
        gsap.to("html", 0, {"--color-current": 'var(--color-2)'});
    } else {
        document.documentElement.style.setProperty('--color-current', 'var(--color-2)');
    }


    // 3. Initialize resources
    player1Resources = INITIAL_RESOURCES;
    player2Resources = INITIAL_RESOURCES;
    updateResourceDisplay();

    // 4. Start resource generation interval
    resourceIntervalId = setInterval(grantResourcesToPlayers, RESOURCE_GAIN_INTERVAL);

    // 5. Start bot thinking interval (if bot is active - for now, always start for P1)
    //    The bot will be Player 1 (index 0 in mainPlayerArray)
    botIntervalId = setInterval(runBotLogic, BOT_THINK_INTERVAL);

    // 6. Reset and start game timer (optional, but good for consistency)
    if (typeof mainResetTimer === 'function') mainResetTimer();
    if (typeof mainStartTimer === 'function') mainStartTimer();
    if (typeof mainShowTimer === 'function') mainShowTimer(); // Ensure timer is visible

    console.log("RTR Mode: Game started. P1 Resources:", player1Resources, "P2 Resources:", player2Resources);
}

/**
 * Handles a dot click in Real-Time Resource mode.
 * @param {jQuery} clickedDot - The jQuery object of the clicked dot.
 * @param {string} actingPlayer - The player who clicked (e.g., "player--1", "player--2").
 */
export function handleRealTimeDotClick(clickedDot, actingPlayer) {
    const playerIndex = mainPlayerArray.indexOf(actingPlayer); // 0 for player--1, 1 for player--2

    // --- GLOBAL CHAIN LOCK: Only allow if no chain is in progress ---
    if (chainInProgress) {
        return;
    }
    chainInProgress = true;

    // 1. Check if player is on cooldown
    if (playerIndex === 0 && player1CooldownActive) {
        chainInProgress = false; return;
    }
    if (playerIndex === 1 && player2CooldownActive) {
        chainInProgress = false; return;
    }

    // 2. Check if player has resources
    const currentResources = (playerIndex === 0) ? player1Resources : player2Resources;
    if (currentResources < 1) {
        chainInProgress = false; return;
    }

    // 3. Check if the clicked dot is owned by the acting player
    if (!clickedDot.hasClass(actingPlayer)) {
        chainInProgress = false; return;
    }

    // 4. All checks passed, proceed with action
    console.log(`RTR Mode: ${actingPlayer} clicked dot ${clickedDot.data('index')}`);

    // Spend resource
    if (playerIndex === 0) {
        player1Resources--;
    } else {
        player2Resources--;
    }
    updateResourceDisplay();

    // Activate cooldown
    if (playerIndex === 0) {
        player1CooldownActive = true;
        setTimeout(() => { player1CooldownActive = false; }, ACTION_COOLDOWN_DURATION);
    } else {
        player2CooldownActive = true;
        setTimeout(() => { player2CooldownActive = false; }, ACTION_COOLDOWN_DURATION);
    }

    // Call main game logic to increment dot stage
    // The original incrementDotStage handles animations and subsequent checks (like checkDotmination via animateNextDot)
    if (typeof mainIncrementDotStage === 'function') {
         clickedDot.closest(".field").addClass("animating"); // Standard practice before increment
         clickedDot
            .attr("data-increment", parseInt(clickedDot.attr("data-increment")) + 1)
            .addClass("increment");
        mainIncrementDotStage(clickedDot, actingPlayer);
    }
}

/**
 * Stops the Real-Time Resource mode game.
 * Clears intervals and resets state.
 */
export function stopRealTimeResourceGame() {
    console.log("RTR Mode: Stopping game...");
    resetModeState();
    if (typeof mainStopTimer === 'function') mainStopTimer();
}


// --- Helper Functions ---

function playerClassClear() {
    if (mainPlayerArray && mainPlayerArray.length > 0) {
        return mainPlayerArray.join(" ");
    }
    return "player--1 player--2"; // Fallback
}

function resetModeState() {
    if (resourceIntervalId) {
        clearInterval(resourceIntervalId);
        resourceIntervalId = null;
    }
    if (botIntervalId) {
        clearInterval(botIntervalId);
        botIntervalId = null;
    }
    player1Resources = 0;
    player2Resources = 0;
    player1CooldownActive = false;
    player2CooldownActive = false;
    updateResourceDisplay(); // Clear display
}

function grantResourcesToPlayers() {
    player1Resources += RESOURCE_GAIN_AMOUNT;
    player2Resources += RESOURCE_GAIN_AMOUNT;
    // console.log(`RTR Mode: Resources granted. P1: ${player1Resources}, P2: ${player2Resources}`);
    updateResourceDisplay();
}

function updateResourceDisplay() {
    if ($player1ScoreDisplay) $player1ScoreDisplay.text(player1Resources);
    if ($player2ScoreDisplay) $player2ScoreDisplay.text(player2Resources);
}

// --- Bot Logic (Adapted for Real-Time, Smart) ---

// --- Smart Bot Logic (adapted from botLogic.js) ---
const BOT_CONSTANTS = {
    SCORE_THRESHOLD: 5,
    RECENT_MOVES_LIMIT: 3,
    CHAIN_WEIGHT: 2,
    DISRUPT_WEIGHT: 1.5,
    EARLY_GAME_TURNS: 10,
    MIN_VIABLE_TARGETS: 3,
    HIGH_STAGE_THRESHOLD: 3
};
let recentBotMoves = [];

function visualFeedback(dot, delay) {
    if (dot && dot.length) {
        dot.addClass("bot-choice");
        setTimeout(() => dot.removeClass("bot-choice"), delay);
    }
}

function logBotChoice(choice, data) {
    // Optionally log bot choices for debugging
}

function evaluateOpponentDot(opponentDot, targetData) {
    const stage = mainGetStageNumber(opponentDot);
    if (stage > targetData.myStage) {
        if (stage >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD + 1 && targetData.myStage < 2) {
            targetData.isSafe = false;
        }
    }
    if (stage >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD) {
        targetData.disruptPotential += stage * BOT_CONSTANTS.DISRUPT_WEIGHT;
    }
}

function evaluatePlayerDot(playerDot, targetData) {
    const stage = mainGetStageNumber(playerDot);
    if (stage >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD) {
        targetData.chainPotential += (5 - stage) * BOT_CONSTANTS.CHAIN_WEIGHT;
    }
}

function calculateScore(targetData, turnCount) {
    return (targetData.chainPotential * BOT_CONSTANTS.CHAIN_WEIGHT) +
        targetData.disruptPotential +
        (targetData.myStage === 0 && targetData.neighbors < 3 ? 5 : 0) +
        (turnCount < BOT_CONSTANTS.EARLY_GAME_TURNS &&
            targetData.disruptPotential >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD * 2 ? 5 : 0);
}

function evaluateTarget(target, smarterGameState) {
    const targetData = {
        dot: target,
        isSafe: true,
        myStage: mainGetStageNumber(target),
        chainPotential: 0,
        disruptPotential: 0,
        neighbors: 0,
        hitTest: smarterGameState.hitTest
    };
    smarterGameState.dots.each(function () {
        const dot = $(this);
        if (!smarterGameState.hitTest(target[0], dot.find(".hitarea")[0]) ||
            dot.attr("data-index") === target.attr("data-index")) return;
        targetData.neighbors++;
        if (dot.hasClass(mainPlayerArray[1])) { // Opponent's dot
            evaluateOpponentDot(dot, targetData);
        } else if (dot.hasClass(mainPlayerArray[0])) { // Bot's own dot
            evaluatePlayerDot(dot, targetData);
        }
    });
    return targetData;
}

function findViableTargets(smarterGameState) {
    const viableTargets = [];
    smarterGameState.targets.each(function () {
        const target = $(this);
        const targetData = evaluateTarget(target, smarterGameState);
        if (targetData.isSafe) {
            const score = calculateScore(targetData, smarterGameState.turnCount);
            if (score > BOT_CONSTANTS.SCORE_THRESHOLD || viableTargets.length < BOT_CONSTANTS.MIN_VIABLE_TARGETS) {
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

function tryStage5Hits(smarterGameState) {
    if (smarterGameState.player1Stage5.length === 0 || smarterGameState.player2Stage5.length === 0) return false;
    for (let i = 0; i < smarterGameState.player1Stage5.length; i++) {
        const p1Dot = $(smarterGameState.player1Stage5[i]);
        for (let j = 0; j < smarterGameState.player2Stage5.length; j++) {
            const p2Dot = $(smarterGameState.player2Stage5[j]);
            if (smarterGameState.hitTest(p2Dot[0], p1Dot.find(".hitarea")[0])) {
                visualFeedback(p1Dot, 0); // No delay for RTS
                handleRealTimeDotClick(p1Dot, mainPlayerArray[0]);
                return true;
            }
        }
    }
    return false;
}

function executeViableMove(viableTargets, smarterGameState) {
    if (viableTargets.length === 0) return false;
    viableTargets.sort((a, b) => b.score - a.score);
    const choice = viableTargets[0].dot;
    logBotChoice(choice, viableTargets[0]);
    visualFeedback(choice, 0);
    handleRealTimeDotClick(choice, mainPlayerArray[0]);
    return true;
}

function evaluateFallbackTarget(target, smarterGameState) {
    const data = { disrupt: 0, chain: 0 };
    smarterGameState.dots.each(function () {
        const dot = $(this);
        if (!smarterGameState.hitTest(target[0], dot.find(".hitarea")[0]) ||
            dot.attr("data-index") === target.attr("data-index")) return;
        if (dot.hasClass(mainPlayerArray[1])) {
            data.disrupt = Math.max(data.disrupt, mainGetStageNumber(dot));
        } else if (dot.hasClass(mainPlayerArray[0])) {
            data.chain += (5 - mainGetStageNumber(dot));
        }
    });
    return data;
}

function findFallbackTargets(smarterGameState) {
    const fallbackTargets = [];
    smarterGameState.targets.each(function () {
        const target = $(this);
        if (recentBotMoves.includes(target.attr("data-index"))) return;
        const fallbackData = evaluateFallbackTarget(target, smarterGameState);
        if (fallbackData.disrupt >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD || fallbackData.chain > 0) {
            fallbackTargets.push({
                dot: target,
                score: (fallbackData.chain * BOT_CONSTANTS.CHAIN_WEIGHT) +
                    (fallbackData.disrupt * BOT_CONSTANTS.DISRUPT_WEIGHT),
                disrupt: fallbackData.disrupt,
                chain: fallbackData.chain
            });
        }
    });
    return fallbackTargets;
}

function executeFallbackStrategy(smarterGameState) {
    const fallbackTargets = findFallbackTargets(smarterGameState);
    if (fallbackTargets.length > 0) {
        fallbackTargets.sort((a, b) => b.score - a.score);
        const choiceData = fallbackTargets[0];
        const choice = choiceData.dot;
        visualFeedback(choice, 0);
        handleRealTimeDotClick(choice, mainPlayerArray[0]);
        return true;
    }
    return false;
}

function executeRandomMove(smarterGameState) {
    if (smarterGameState.targets.length === 0) {
        return;
    }
    const availableTargets = smarterGameState.targets.filter(function () {
        return !recentBotMoves.includes($(this).attr("data-index"));
    });
    const targetPool = availableTargets.length > 0 ? availableTargets : smarterGameState.targets;
    const randomDot = targetPool.eq(Math.floor(Math.random() * targetPool.length));
    visualFeedback(randomDot, 0);
    handleRealTimeDotClick(randomDot, mainPlayerArray[0]);
}

function updateRecentMoves(moveIndex, forceUpdate = false) {
    if (moveIndex || forceUpdate) {
        if (moveIndex) {
            recentBotMoves.push(moveIndex);
        }
        while (recentBotMoves.length > BOT_CONSTANTS.RECENT_MOVES_LIMIT) {
            recentBotMoves.shift();
        }
    }
}

// --- Proactive Defense Logic ---
const DEFENSE_MIN_DIST = 2;
const DEFENSE_MAX_DIST = 4;

function findDefensiveBandCells(goalIdx) {
    // Returns array of bot cell indices that are DEFENSE_MIN_DIST <= dist <= DEFENSE_MAX_DIST from goalIdx
    let band = [];
    mainDots.each(function(i) {
        if ($(this).hasClass(mainPlayerArray[0])) {
            const dist = shortestPathLength(i, goalIdx);
            if (dist >= DEFENSE_MIN_DIST && dist <= DEFENSE_MAX_DIST) {
                band.push(i);
            }
        }
    });
    return band;
}
// Helper: shortest path length between two indices (BFS, returns Infinity if unreachable)
function shortestPathLength(startIdx, goalIdx) {
    if (startIdx === -1 || goalIdx === -1) return Infinity;
    if (startIdx === goalIdx) return 0;
    const queue = [[startIdx, 0]];
    const visited = new Set([startIdx]);
    while (queue.length > 0) {
        const [curr, dist] = queue.shift();
        for (const nIdx of getNeighborIndices(curr)) {
            if (nIdx === goalIdx) return dist + 1;
            if (!visited.has(nIdx)) {
                visited.add(nIdx);
                queue.push([nIdx, dist + 1]);
            }
        }
    }
    return Infinity;
}
// Visualize defensive band cells (green ring)
function visualizeDefensiveBand(band) {
    mainDots.removeClass('bot-path-defend');
    $('#bot-path-defend-svg').remove();
    if (!band || band.length === 0) return;
    for (const idx of band) {
        mainDots.eq(idx).addClass('bot-path-defend');
    }
    // Optionally, draw a green polyline from the closest band cell to the goal
    // (for now, just highlight the cells)
}

// --- Improved Chain Overtake: All valid buffers are orange, never purple ---
let persistentChainPlan = null;

function findAllChainOvertakePlans(opponentStage5) {
    let plans = [];
    let allBufferIndices = new Set();
    // Collect all bot-owned neighbors of ANY opponent stage 5 cell as buffers
    for (const oppIdx of opponentStage5) {
        const oppNeighbors = getNeighborIndices(oppIdx);
        for (const idx of oppNeighbors) {
            if (mainDots.eq(idx).hasClass(mainPlayerArray[0])) {
                allBufferIndices.add(idx);
            }
        }
    }
    // For each buffer, find all bot-owned neighbors (potential bombs)
    for (const bufferIdx of allBufferIndices) {
        const bufferNeighbors = getNeighborIndices(bufferIdx);
        // Only consider as bombs if not also a buffer for any opponent cell
        const bombCandidates = bufferNeighbors.filter(nIdx =>
            mainDots.eq(nIdx).hasClass(mainPlayerArray[0]) &&
            !allBufferIndices.has(nIdx) &&
            mainGetStageNumber(mainDots.eq(nIdx)) < 5
        );
        // Require at least two bombs, and they must be adjacent to the same buffer AND to each other
        for (let i = 0; i < bombCandidates.length; i++) {
            for (let j = i + 1; j < bombCandidates.length; j++) {
                const bomb1 = bombCandidates[i];
                const bomb2 = bombCandidates[j];
                // Bombs must be adjacent to each other
                if (getNeighborIndices(bomb1).includes(bomb2)) {
                    // All three must be bot-owned and not at max stage
                    if (
                        mainDots.eq(bufferIdx).hasClass(mainPlayerArray[0]) && mainGetStageNumber(mainDots.eq(bufferIdx)) < 4 &&
                        mainDots.eq(bomb1).hasClass(mainPlayerArray[0]) && mainGetStageNumber(mainDots.eq(bomb1)) < 5 &&
                        mainDots.eq(bomb2).hasClass(mainPlayerArray[0]) && mainGetStageNumber(mainDots.eq(bomb2)) < 5
                    ) {
                        plans.push({
                            buffer: bufferIdx,
                            bombs: [bomb1, bomb2],
                            bufferStage: mainGetStageNumber(mainDots.eq(bufferIdx)),
                            bombStages: [mainGetStageNumber(mainDots.eq(bomb1)), mainGetStageNumber(mainDots.eq(bomb2))],
                            oppIdx: opponentStage5.find(oppIdx => getNeighborIndices(oppIdx).includes(bufferIdx))
                        });
                    }
                }
            }
        }
    }
    plans.allBufferIndices = allBufferIndices;
    return plans;
}

function pickBestChainPlan(plans) {
    if (!plans || plans.length === 0) return null;
    plans.sort((a, b) => (b.bufferStage + b.bombStages[0] + b.bombStages[1]) - (a.bufferStage + a.bombStages[0] + a.bombStages[1]));
    return plans[0];
}

function visualizeAllChainPlans(plans, bestPlan) {
    mainDots.removeClass('bot-path-chain-buffer bot-path-chain-bomb bot-path-chain-best-buffer bot-path-chain-best-bomb');
    $('#bot-path-chain-svg').remove();
    if (!plans || plans.length === 0) return;
    // Mark all valid buffers as orange
    if (plans.allBufferIndices) {
        for (const idx of plans.allBufferIndices) {
            mainDots.eq(idx).addClass('bot-path-chain-buffer');
        }
    }
    // Only mark bombs and buffer of the best plan as strong color
    if (bestPlan) {
        mainDots.eq(bestPlan.buffer).addClass('bot-path-chain-best-buffer');
        for (const idx of bestPlan.bombs) {
            mainDots.eq(idx).addClass('bot-path-chain-best-bomb');
        }
    }
}

function isChainPlanStillValid(plan) {
    if (!plan) return false;
    // Buffer and bombs must still be bot-owned
    if (!mainDots.eq(plan.buffer).hasClass(mainPlayerArray[0])) return false;
    for (const idx of plan.bombs) {
        if (!mainDots.eq(idx).hasClass(mainPlayerArray[0])) return false;
    }
    // Bombs must still be adjacent to buffer and to each other
    if (!getNeighborIndices(plan.buffer).includes(plan.bombs[0]) ||
        !getNeighborIndices(plan.buffer).includes(plan.bombs[1]) ||
        !getNeighborIndices(plan.bombs[0]).includes(plan.bombs[1])) return false;
    // Opponent cell must still be stage 5
    if (!mainDots.eq(plan.oppIdx).hasClass(mainPlayerArray[1]) || mainGetStageNumber(mainDots.eq(plan.oppIdx)) !== 5) return false;
    return true;
}

function runSmartBotLogic() {
    if ($('.field').hasClass('animating')) return;
    if (player1CooldownActive || player1Resources < 1) return;
    const botPlayerClass = mainPlayerArray[0];
    const opponentPlayerClass = mainPlayerArray[1];
    const dots = $('.dot');
    const player1Dots = $(`.dot.${botPlayerClass}`);
    const player2Dots = $(`.dot.${opponentPlayerClass}`);
    // Find the highest-stage opponent cell
    const goalIdx = findHighestStageOpponentCell();
    const goalStage = goalIdx !== -1 ? mainGetStageNumber(mainDots.eq(goalIdx)) : 0;
    // Calculate opponentStage5 here
    const opponentStage5 = [];
    mainDots.each(function(i) {
        if ($(this).hasClass(mainPlayerArray[1]) && mainGetStageNumber($(this)) === 5) {
            opponentStage5.push(i);
        }
    });
    // Find all chain plans
    let chainPlans = findAllChainOvertakePlans(opponentStage5);
    let bestPlan = pickBestChainPlan(chainPlans);
    // Plan persistence: keep working on the last best plan if still valid
    if (persistentChainPlan && isChainPlanStillValid(persistentChainPlan)) {
        bestPlan = persistentChainPlan;
    } else if (bestPlan) {
        persistentChainPlan = bestPlan;
    } else {
        persistentChainPlan = null;
    }
    visualizeAllChainPlans(chainPlans, bestPlan);
    if (goalStage === 5 && bestPlan) {
        // Only work on the bombs/buffer of the persistent plan
        let targets = $();
        // If all bombs are at 5 and buffer at 4, trigger bombs (explode)
        if (bestPlan.bombs.every(idx => mainGetStageNumber(mainDots.eq(idx)) === 5) && mainGetStageNumber(mainDots.eq(bestPlan.buffer)) === 4) {
            targets = $(bestPlan.bombs.map(idx => mainDots.eq(idx)).filter(dot => dot.length > 0));
        } else {
            for (const idx of bestPlan.bombs) {
                if (mainGetStageNumber(mainDots.eq(idx)) < 5) targets = targets.add(mainDots.eq(idx));
            }
            if (mainGetStageNumber(mainDots.eq(bestPlan.buffer)) < 4) {
                targets = targets.add(mainDots.eq(bestPlan.buffer));
            }
        }
        const smarterGameState = {
            dots: dots,
            player1Dots: player1Dots,
            player2Dots: player2Dots,
            targets: targets.length > 0 ? targets : player1Dots,
            player1Stage5: player1Dots.filter('.stage--5'),
            player2Stage5: player2Dots.filter('.stage--5'),
            turnCount: player1Dots.length,
            hitTest: Draggable.hitTest
        };
        if (tryStage5Hits(smarterGameState)) {
            updateRecentMoves(null, true);
            return;
        }
        const viableTargets = findViableTargets(smarterGameState);
        if (executeViableMove(viableTargets, smarterGameState)) {
            updateRecentMoves(viableTargets[0].dot.attr("data-index"));
            return;
        }
        if (executeFallbackStrategy(smarterGameState)) {
            updateRecentMoves(null, true);
            return;
        }
        executeRandomMove(smarterGameState);
        updateRecentMoves(null, true);
        return;
    } else if (goalStage === 5) {
        // No valid plan, but try to build toward one
        let potentialTargets = $();
        let allBufferIndices = chainPlans.allBufferIndices || new Set();
        // All bot-owned cells adjacent to any buffer or opponent stage 5
        for (const oppIdx of opponentStage5) {
            const oppNeighbors = getNeighborIndices(oppIdx);
            for (const idx of oppNeighbors) {
                if (mainDots.eq(idx).hasClass(mainPlayerArray[0])) {
                    potentialTargets = potentialTargets.add(mainDots.eq(idx));
                }
            }
        }
        for (const bufferIdx of allBufferIndices) {
            const bufferNeighbors = getNeighborIndices(bufferIdx);
            for (const idx of bufferNeighbors) {
                if (mainDots.eq(idx).hasClass(mainPlayerArray[0])) {
                    potentialTargets = potentialTargets.add(mainDots.eq(idx));
                }
            }
        }
        // Remove duplicates
        potentialTargets = potentialTargets.filter(function(i, el) {
            return potentialTargets.index(el) === i;
        });
        if (potentialTargets.length > 0) {
            // Increment these cells to build toward a valid plan
            const smarterGameState = {
                dots: dots,
                player1Dots: player1Dots,
                player2Dots: player2Dots,
                targets: potentialTargets,
                player1Stage5: player1Dots.filter('.stage--5'),
                player2Stage5: player2Dots.filter('.stage--5'),
                turnCount: player1Dots.length,
                hitTest: Draggable.hitTest
            };
            const viableTargets = findViableTargets(smarterGameState);
            if (executeViableMove(viableTargets, smarterGameState)) {
                updateRecentMoves(viableTargets[0].dot.attr("data-index"));
                return;
            }
            if (executeFallbackStrategy(smarterGameState)) {
                updateRecentMoves(null, true);
                return;
            }
            executeRandomMove(smarterGameState);
            updateRecentMoves(null, true);
            return;
        }
        // If no potential targets, only then fallback to direct attack
    }
    // If the opponent's highest-stage cell is less than 5, prefer direct attack
    persistentChainPlan = null;
    const startIdx = findNearestBotCell(goalIdx);
    const path = bfsPath(startIdx, goalIdx);
    visualizeBotPath(path); // blue
    // Defensive band logic
    const defensiveBand = findDefensiveBandCells(goalIdx);
    visualizeDefensiveBand(defensiveBand); // green
    // Check if any defensive band cell is at stage 5
    let defenseSecure = false;
    for (const idx of defensiveBand) {
        if (mainGetStageNumber(mainDots.eq(idx)) === 5) {
            defenseSecure = true;
            break;
        }
    }
    let targets;
    if (defensiveBand.length > 0 && !defenseSecure) {
        // Prioritize defensive band cells
        let bandSet = new Set(defensiveBand);
        targets = player1Dots.filter(function() {
            return bandSet.has($(this).index());
        });
    } else {
        // Prioritize path cells for action
        let pathSet = new Set(path);
        targets = player1Dots.filter(function() {
            return pathSet.has($(this).index());
        });
    }
    const smarterGameState = {
        dots: dots,
        player1Dots: player1Dots,
        player2Dots: player2Dots,
        targets: targets.length > 0 ? targets : player1Dots,
        player1Stage5: player1Dots.filter('.stage--5'),
        player2Stage5: player2Dots.filter('.stage--5'),
        turnCount: player1Dots.length,
        hitTest: Draggable.hitTest
    };
    if (tryStage5Hits(smarterGameState)) {
        updateRecentMoves(null, true);
        return;
    }
    const viableTargets = findViableTargets(smarterGameState);
    if (executeViableMove(viableTargets, smarterGameState)) {
        updateRecentMoves(viableTargets[0].dot.attr("data-index"));
        return;
    }
    if (executeFallbackStrategy(smarterGameState)) {
        updateRecentMoves(null, true);
        return;
    }
    executeRandomMove(smarterGameState);
    updateRecentMoves(null, true);
}

// Replace the old runBotLogic with the smart version
function runBotLogic() {
    runSmartBotLogic();
}

// Placeholder for more advanced bot logic adaptation if needed
// function getAdaptedBotMove() { ... }

// Make sure to call initialize() from script.js when the mode is first set up,
// passing the necessary references from the main game. 

// --- Game Over Overlay for RTS Mode ---
export function showGameOverOverlay(winner) {
    // winner: 'player--1' or 'player--2'
    stopRealTimeResourceGame();
    // Remove any existing overlay
    $(".end.overlay").remove();
    // Determine if the local player won
    const localPlayerWon = (winner === mainPlayerArray[1]);
    const message = localPlayerWon ? "You Win!" : "You Lose!";
    const winnerClass = winner;
    const overlayHtml = `
      <div class="end overlay noselect ${winnerClass}">
        <div class="card">
          <h1>${message}</h1>
          <p class="retry">Restart <i class="fas fa-undo"></i></p>
        </div>
      </div>
    `;
    $("body .container").append(overlayHtml);
    // Animate overlay
    if (typeof TweenMax !== 'undefined') {
      TweenMax.fromTo($('.overlay > .card'), 2, { alpha: 0, scale: 0 }, { alpha: 1, scale: 1, ease: Elastic.easeOut });
    } else if (typeof gsap !== 'undefined') {
      gsap.fromTo($('.overlay > .card'), {alpha: 0, scale: 0}, {duration: 2, alpha: 1, scale: 1, ease:"elastic.out(1, 0.3)"});
    } else {
      $('.overlay > .card').css({alpha: 1, transform: 'scale(1)'});
    }
}

// --- Hook to clear the global chain lock when a chain reaction is finished ---
// This function should be called at the end of the chain reaction (after animateNextDot in script.js)
export function clearActiveChainPlayerLock() {
    chainInProgress = false;
}

// Add CSS for .bot-path highlight (for dev/debug)
// $('<style>.bot-path{box-shadow:0 0 0 4px #00F,0 0 12px #00F3;z-index:10 !important;}</style>').appendTo('head');
// Add CSS for .bot-path-defend highlight (green ring)
// $('<style>.bot-path-defend{box-shadow:0 0 0 4px #0F0,0 0 12px #0F03;z-index:10 !important;}</style>').appendTo('head');
// Add CSS for chain overtake highlights (stronger for best plan)
// $('<style>.bot-path-chain-buffer{box-shadow:0 0 0 4px orange,0 0 12px orange;z-index:10 !important;}.bot-path-chain-bomb{box-shadow:0 0 0 4px purple,0 0 12px purple;z-index:10 !important;}.bot-path-chain-best-buffer{box-shadow:0 0 0 6px #ff9800,0 0 16px #ff9800;z-index:11 !important;}.bot-path-chain-best-bomb{box-shadow:0 0 0 6px #b400ff,0 0 16px #b400ff;z-index:11 !important;}</style>').appendTo('head'); 
// $('<style>.bot-path-chain-buffer{box-shadow:0 0 0 4px orange,0 0 12px orange;z-index:10 !important;}.bot-path-chain-bomb{box-shadow:0 0 0 4px purple,0 0 12px purple;z-index:10 !important;}.bot-path-chain-best-buffer{box-shadow:0 0 0 6px #ff9800,0 0 16px #ff9800;z-index:11 !important;}.bot-path-chain-best-bomb{box-shadow:0 0 0 6px #b400ff,0 0 16px #b400ff;z-index:11 !important;}</style>').appendTo('head'); 