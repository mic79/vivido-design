// botLogic.js - Module for Dotmination bot decision-making
import { getStageNumber } from './utils.js'; // Import from utils

const BOT_CONSTANTS = {
    SCORE_THRESHOLD: 5,
    RECENT_MOVES_LIMIT: 3,
    CHAIN_WEIGHT: 2,
    DISRUPT_WEIGHT: 1.5,
    EARLY_GAME_TURNS: 10,
    MIN_VIABLE_TARGETS: 3,
    HIGH_STAGE_THRESHOLD: 3,
    // VISUAL_FEEDBACK_DELAY: 1000 // This will be passed in gameState
};

// --- Utility Functions ---
function visualFeedback(dot, delay) {
    if (dot && dot.length) {
        dot.addClass("bot-choice");
        setTimeout(() => dot.removeClass("bot-choice"), delay);
    }
}

// --- Bot Action: Random ---
function botActionRandom(gameState) {
    // gameState provides:
    // - gameState.targets (jQuery collection of clickable dots for bot - P1)
    // - gameState.player1Stage5 (jQuery collection of P1 S5 dots)
    // - gameState.player2Stage5 (jQuery collection of P2 S5 dots)
    // - gameState.hitTest (function from Draggable.hitTest)
    // - gameState.dots (jQuery collection of all dots)

    if (!gameState.targets || gameState.targets.length === 0) {
        console.log("Bot (Random): No valid targets found.");
        return;
    }

    let offensiveS5MoveTargets = [];

    if (gameState.player1Stage5 && gameState.player1Stage5.length > 0 && 
        gameState.player2Stage5 && gameState.player2Stage5.length > 0) {
        
        gameState.player1Stage5.each(function() {
            const botS5Dot = $(this); // Bot's own Stage 5 dot
            let canHitOpponentS5 = false;

            // Check if this botS5Dot, when exploded, hits any of opponent's S5 dots
            // To do this, we simulate the explosion: check neighbors of botS5Dot
            gameState.dots.each(function() {
                const neighbor = $(this);
                if (botS5Dot.attr("data-index") === neighbor.attr("data-index")) return; // Skip self

                // Is this neighbor an opponent's S5 dot AND would it be hit by botS5Dot exploding?
                if (gameState.hitTest(neighbor[0], botS5Dot.find(".hitarea")[0])) {
                    // Now check if this neighbor is one of the opponent's S5 dots
                    let isOpponentS5Neighbor = false;
                    gameState.player2Stage5.each(function() {
                        if ($(this).attr("data-index") === neighbor.attr("data-index")) {
                            isOpponentS5Neighbor = true;
                            return false; // break jQuery each loop
                        }
                    });
                    if (isOpponentS5Neighbor) {
                        canHitOpponentS5 = true;
                        return false; // break jQuery each loop for gameState.dots
                    }
                }
            });

            if (canHitOpponentS5) {
                offensiveS5MoveTargets.push(botS5Dot); // Add bot's S5 dot to potential clicks
            }
        });
    }

    let chosenDot;
    if (offensiveS5MoveTargets.length > 0) {
        // Bot has an S5 move that can affect opponent's S5
        const randomIndex = Math.floor(Math.random() * offensiveS5MoveTargets.length);
        chosenDot = offensiveS5MoveTargets[randomIndex];
        console.log("Bot (Random) choosing offensive S5 move, clicking its own S5 dot at index:", chosenDot.index());
    } else {
        // No S5 offensive move, or no S5 dots involved. Pick a random valid target.
        const randomDotIndex = Math.floor(Math.random() * gameState.targets.length);
        chosenDot = gameState.targets.eq(randomDotIndex);
        console.log("Bot (Random) clicking general dot at index:", chosenDot.index());
    }

    if (chosenDot && chosenDot.length) {
        visualFeedback(chosenDot, gameState.visualFeedbackDelay);
        chosenDot.click();
    } else {
        console.log("Bot (Random): Failed to choose any dot.");
    }
}

// --- Bot Action: Smarter ---
function logBotChoice(choice, data) {
    console.log(
        "Bot (Smart) chose dot " + choice.attr("data-index") +
        " (stage " + getStageNumber(choice) + ") with score " +
        Math.round(data.score) + " (chain: " + Math.round(data.chain) +
        ", disrupt: " + Math.round(data.disrupt) + ")"
    );
}

function evaluateOpponentDot(opponentDot, targetData) { // Removed smarterGameState from here, use targetData.hitTest
    const stage = getStageNumber(opponentDot);
    if (stage > targetData.myStage) {
        // Simplified safety check: if opponent dot is stronger, our dot is considered less safe.
        // A more complex check would involve simulating explosions.
        if (stage >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD +1 && targetData.myStage < 2) {
            targetData.isSafe = false;
        }
    }
    if (stage >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD) {
        targetData.disruptPotential += stage * BOT_CONSTANTS.DISRUPT_WEIGHT;
    }
}

function evaluatePlayerDot(playerDot, targetData) {
    const stage = getStageNumber(playerDot);
    if (stage >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD) {
        targetData.chainPotential += (5 - stage) * BOT_CONSTANTS.CHAIN_WEIGHT;
    }
}

function calculateScore(targetData, turnCount) {
    return (targetData.chainPotential * BOT_CONSTANTS.CHAIN_WEIGHT) +
           targetData.disruptPotential +
           (targetData.myStage === 0 && targetData.neighbors < 3 ? 5 : 0) + // Bonus for claiming sparse empty dots
           (turnCount < BOT_CONSTANTS.EARLY_GAME_TURNS &&
            targetData.disruptPotential >= BOT_CONSTANTS.HIGH_STAGE_THRESHOLD * 2 ? 5 : 0); // Aggression if high disruption found early
}

function evaluateTarget(target, smarterGameState) { // target is a jQuery dot object
    const targetData = {
        dot: target,
        isSafe: true,
        myStage: getStageNumber(target),
        chainPotential: 0,
        disruptPotential: 0,
        neighbors: 0,
        hitTest: smarterGameState.hitTest // Pass hitTest down for use in evaluateOpponentDot if needed indirectly
    };

    smarterGameState.dots.each(function() {
        const dot = $(this); // Ensure jQuery object
        if (!smarterGameState.hitTest(target[0], dot.find(".hitarea")[0]) ||
            dot.attr("data-index") === target.attr("data-index")) return;

        targetData.neighbors++;

        if (dot.hasClass("player--2")) { // Opponent's dot
            evaluateOpponentDot(dot, targetData);
        } else if (dot.hasClass("player--1")) { // Bot's own dot
            evaluatePlayerDot(dot, targetData);
        }
    });
    return targetData;
}


function findViableTargets(smarterGameState) {
    const viableTargets = [];
    smarterGameState.targets.each(function() {
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
        const p1Dot = $(smarterGameState.player1Stage5[i]); // Bot's S5 dot
        for (let j = 0; j < smarterGameState.player2Stage5.length; j++) {
            const p2Dot = $(smarterGameState.player2Stage5[j]); // Opponent's S5 dot
            
            // Check if bot's S5 can explode onto opponent's S5
            // This implies p1Dot is the one being clicked to explode
            // The target of the click is p1Dot, effect on p2Dot
            if (smarterGameState.hitTest(p2Dot[0], p1Dot.find(".hitarea")[0])) {
                 // We need to click p1Dot to make it explode.
                 // The original logic was: if (Draggable.hitTest($(dots).eq(j), $(lvl5[i]).find(".hitarea")))
                 // which means if opponent's dot S5 (dots[j]) is hit by OUR S5 exploding dot (lvl5[i])
                 // So, the bot clicks ITS OWN S5 dot (lvl5[i])
                console.log("Bot (Smart) trying S5 direct explosion: Clicking its own S5 dot at index " + p1Dot.data("index") + " to affect opponent S5 dot at " + p2Dot.data("index"));
                visualFeedback(p1Dot, smarterGameState.visualFeedbackDelay);
                // updateRecentMoves is managed by getBotMove after a choice is made
                p1Dot.click();
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
    visualFeedback(choice, smarterGameState.visualFeedbackDelay);
    // updateRecentMoves is managed by getBotMove
    choice.click();
    return true;
}

function evaluateFallbackTarget(target, smarterGameState) {
    const data = { disrupt: 0, chain: 0 };
    smarterGameState.dots.each(function() {
        const dot = $(this);
        if (!smarterGameState.hitTest(target[0], dot.find(".hitarea")[0]) ||
            dot.attr("data-index") === target.attr("data-index")) return;

        if (dot.hasClass("player--2")) {
            data.disrupt = Math.max(data.disrupt, getStageNumber(dot));
        } else if (dot.hasClass("player--1")) {
            data.chain += (5 - getStageNumber(dot));
        }
    });
    return data;
}

function findFallbackTargets(smarterGameState) {
    const fallbackTargets = [];
    smarterGameState.targets.each(function() {
        const target = $(this);
        if (smarterGameState.recentMoves.includes(target.attr("data-index"))) return; // Skip recent

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
        console.log("Bot (Smart) fell back to dot " + choice.attr("data-index") +
                    " (Disrupt: " + choiceData.disrupt + ", Chain: " + choiceData.chain + ")");
        visualFeedback(choice, smarterGameState.visualFeedbackDelay);
        // updateRecentMoves is managed by getBotMove
        choice.click();
        return true;
    }
    return false;
}

function executeRandomMove(smarterGameState) {
    if (smarterGameState.targets.length === 0) {
        console.log("Bot (Smart-RandomFallback): No targets.");
        return;
    }
    const availableTargets = smarterGameState.targets.filter(function() {
        return !smarterGameState.recentMoves.includes($(this).attr("data-index"));
    });
    
    const targetPool = availableTargets.length > 0 ? availableTargets : smarterGameState.targets;
    const randomDot = targetPool.eq(Math.floor(Math.random() * targetPool.length));

    console.log("Bot (Smart) fell back to random dot " + randomDot.attr("data-index"));
    visualFeedback(randomDot, smarterGameState.visualFeedbackDelay);
    // updateRecentMoves is managed by getBotMove
    randomDot.click();
}

function botActionSmarter(smarterGameState) {
    // Ensure all required jQuery collections are present
    if (!smarterGameState.targets || !smarterGameState.player1Stage5 || !smarterGameState.player2Stage5 || !smarterGameState.dots) {
        console.error("Bot (Smart): Missing critical game state collections.");
        executeRandomMove(smarterGameState); // Fallback to less critical random
        return;
    }
    
    if (tryStage5Hits(smarterGameState)) {
      updateRecentMoves(null, smarterGameState, true); // Pass null as moveIndex, but update anyway
      return;
    }
    
    const viableTargets = findViableTargets(smarterGameState);
    if (executeViableMove(viableTargets, smarterGameState)) {
      updateRecentMoves(viableTargets[0].dot.attr("data-index"), smarterGameState);
      return;
    }
    
    if (executeFallbackStrategy(smarterGameState)) {
      // Find the chosen dot again if possible to update recent moves
      // This is a bit indirect; ideally, executeFallbackStrategy would return the choice.
      // For now, let's assume the click happened and proceed.
      updateRecentMoves(null, smarterGameState, true); // Pass null as moveIndex, but update anyway
      return;
    }
    
    executeRandomMove(smarterGameState);
    updateRecentMoves(null, smarterGameState, true); // Pass null as moveIndex, but update anyway
}

// This function will be managed by the calling script (script.js)
// and the recentMoves array will be passed as part of smarterGameState.
function updateRecentMoves(moveIndex, smarterGameState, forceUpdate = false) {
    if (moveIndex || forceUpdate) { // Only add if there's an actual move or forced
        if (moveIndex) { // Only add actual moves to recentMoves
            smarterGameState.recentMoves.push(moveIndex);
        }
        while (smarterGameState.recentMoves.length > BOT_CONSTANTS.RECENT_MOVES_LIMIT) {
            smarterGameState.recentMoves.shift();
        }
    }
}


// --- Main Exported Function ---
export function getBotMove(gameState, difficulty, recentMovesArray, hitTestFunc, visualFeedbackDelayVal) {
    // Prepare the state object for the bot logic
    const botGameState = {
        dots: gameState.dots,               // All dots jQuery collection
        player1Dots: gameState.player1Dots, // Bot's dots
        player2Dots: gameState.player2Dots, // Opponent's dots
        targets: gameState.targets,         // Bot's clickable dots
        
        player1Stage5: gameState.player1Dots.filter(".stage--5"),
        player2Stage5: gameState.player2Dots.filter(".stage--5"),
        
        turnCount: gameState.player1Dots.length, // Simple turn count proxy
        recentMoves: recentMovesArray, // Managed by script.js, passed in
        hitTest: hitTestFunc,          // Function from script.js (Draggable.hitTest)
        visualFeedbackDelay: visualFeedbackDelayVal
    };

    if (difficulty === 'smart') {
        botActionSmarter(botGameState);
    } else {
        botActionRandom(botGameState); // botActionRandom also uses parts of botGameState
    }
}

// Note: The original bot code directly called .click() on jQuery elements.
// This module will continue that pattern. The .click() will trigger
// the event handlers in script.js, which then call incrementDotStage, etc.
// The `updateRecentMoves` function is now called within `getBotMove` context
// or within the specific bot actions if they make a definitive choice.
// For simplicity, `script.js` will manage the `recentBotMoves` array and pass it in. 