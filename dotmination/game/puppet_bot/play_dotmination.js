const puppeteer = require('puppeteer');

(async () => {
    // Launch non-headless browser so the user can watch the AI play live
    const browser = await puppeteer.launch({ 
        headless: false, 
        defaultViewport: null,
        args: ['--start-maximized'] 
    });
    
    const page = await browser.newPage();
    
    // Proxy browser console logs to the Node console
    page.on('console', msg => console.log('BROWSER:', msg.text()));

    console.log("Navigating to the game to set preferences...");
    await page.goto('http://localhost:8080/');

    // Set localStorage to pretend we've completed the tutorial
    await page.evaluate(() => {
        localStorage.setItem('hasPlayedBefore', 'true');
    });

    console.log("Navigating directly to Random Mode (Harder Bot)...");
    await page.goto('http://localhost:8080/?mode=random&difficulty=smart');

    // Click START (if it appears)
    console.log("Waiting for Start button...");
    try {
        await page.waitForSelector('.btn-signin', { timeout: 2000 });
        await page.click('.btn-signin');
    } catch(e) {
        console.log("Start button not found or game auto-started.");
    }

    // Wait 2 seconds for the population animation
    await new Promise(r => setTimeout(r, 2000));

    console.log("Game started. AI is now playing...");

    // Main Game Loop
    const interval = setInterval(async () => {
        try {
            // Check for game over (we only check the single .end overlay, or level goals card)
            const isGameOver = await page.evaluate(() => {
                return document.querySelectorAll('.overlay > .card').length > 0 && 
                       document.querySelector('.end');
            });

            if (isGameOver) {
                console.log("Victory screen detected! 3-Star rating achieved.");
                clearInterval(interval);
                console.log("Leaving the browser open for 10 seconds to admire the victory...");
                setTimeout(() => {
                    browser.close();
                    process.exit(0);
                }, 10000);
                return;
            }

            // Execute a strategic turn if it is Player 2's turn
            await page.evaluate(() => {
                const field = document.querySelector('.field');
                if (!field) return;
                
                const isPlayer2Turn = field.classList.contains('player--2');
                const isAnimating = field.classList.contains('animating');
                console.log("Tick: p2turn=" + isPlayer2Turn + " anim=" + isAnimating);
                
                if (!isPlayer2Turn) return;
                if (isAnimating) return;

                const myDots = Array.from(document.querySelectorAll('.dot.player--2'));
                const oppDots = Array.from(document.querySelectorAll('.dot.player--1'));
                const emptyDots = Array.from(document.querySelectorAll('.dot:not(.player--1):not(.player--2)'));

                const getStage = dot => parseInt(dot.className.match(/stage--(\d)/)?.[1] || 1);
                
                const getAdjacent = (dot, collection) => {
                    if (!window.Draggable) return [];
                    return collection.filter(opp => window.Draggable.hitTest(opp, dot.querySelector('.hitarea')));
                };

                const isSafe = (dot, isMyDot) => {
                    const currentStage = isMyDot ? getStage(dot) : 0;
                    if (currentStage === 5) return true;
                    const opps = getAdjacent(dot, oppDots);
                    if (opps.length === 0) return true;
                    
                    const maxOppStage = Math.max(...opps.map(getStage));
                    if (maxOppStage === 5) return false;
                    return maxOppStage <= (currentStage + 1);
                };

                const myS5 = myDots.filter(d => getStage(d) === 5);
                const oppS5 = oppDots.filter(d => getStage(d) === 5);
                const myS4 = myDots.filter(d => getStage(d) === 4);
                const oppS4 = oppDots.filter(d => getStage(d) === 4);

                // Priority 1: Explode S5 near opp S5
                for (let dot of myS5) {
                    if (getAdjacent(dot, oppS5).length > 0) { console.log("Clicking P1"); dot.click(); return; }
                }
                
                // Priority 2: Grow S4 near opp S4 safely
                for (let dot of myS4) {
                    if (getAdjacent(dot, oppS4).length > 0 && isSafe(dot, true)) { console.log("Clicking P2"); dot.click(); return; }
                }

                // Priority 3: Explode S5 near ANY opponent
                for (let dot of myS5) {
                    if (getAdjacent(dot, oppDots).length > 0) { console.log("Clicking P3"); dot.click(); return; }
                }

                // Priority 4: Grow my dots near opponents safely
                const myDocsSorted = [...myDots].sort((a,b) => getStage(b) - getStage(a));
                for (let dot of myDocsSorted) {
                    const opps = getAdjacent(dot, oppDots);
                    if (opps.length > 0 && isSafe(dot, true)) {
                        console.log("Clicking P4"); dot.click(); return; 
                    }
                }

                // Priority 5: Claim empty dot safely near an opponent
                for (let dot of emptyDots) {
                    const opps = getAdjacent(dot, oppDots);
                    if (opps.length > 0 && isSafe(dot, false)) {
                        console.log("Clicking P5"); dot.click(); return;
                    }
                }

                // Priority 6: Explode ANY S5
                if (myS5.length > 0) { console.log("Clicking P6"); myS5[0].click(); return; }

                // Priority 7: Grow highest staged safe dot
                for (let dot of myDocsSorted) {
                    if (isSafe(dot, true)) { console.log("Clicking P7"); dot.click(); return; }
                }

                // Priority 8: Claim safe empty dot
                for (let dot of emptyDots) {
                    if (isSafe(dot, false)) { console.log("Clicking P8"); dot.click(); return; }
                }

                // Desperation fallback
                if (emptyDots.length > 0) { console.log("FB1"); emptyDots[0].click(); return; }
                if (myDots.length > 0) { console.log("FB2"); myDots[0].click(); return; }
            });
        } catch (e) {
            console.error("Loop error:", e.message);
        }
    }, 100); // Evaluating the DOM and clicking every 100ms
})();
