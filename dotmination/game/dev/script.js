// v0.0.21


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

$("body").on("click", ".end", function () {
  // If in random mode, clear the map parameter from URL
  if (gameMode === 'random') {
    var newUrl = window.location.pathname + '?mode=random';
    window.history.replaceState({}, document.title, newUrl);
  }
  
  startAnim();
});

$(".field").on("click", ".dot", function() {
  // Check if we're in multiplayer mode and it's not our turn
  if (isMultiplayer) {
    var isMyTurn = (isHost && currentPlayer === "player--1") || (!isHost && currentPlayer === "player--2");
    if (!isMyTurn) {
      console.log("Not your turn");
      return; // Not this player's turn
    }
  }
  
  if (
    !$(this).closest(".field").hasClass("animating") &&
    ($(this).hasClass(currentPlayer) || !$(this).is('[class*="player--"]'))
  ) {
    // In multiplayer, send the move to the other player
    if (isMultiplayer && conn) {
      const dotIndex = $(this).index();
      console.log("Sending move:", dotIndex);
      
      conn.send({
        type: 'move',
        dotIndex: dotIndex
      });
    }
    
    $(this).closest(".field").addClass("animating");
    $(this)
      .attr("data-increment", parseInt($(this).attr("data-increment")) + 1)
      .addClass("increment");
    incrementDotStage($(this));
  }
});

function nextPlayer() {
  $(".field").removeClass(currentPlayer);
  if (currentPlayer == playerArray[0]) {
    currentPlayer = playerArray[1];
    TweenMax.to("html", 0, {"--color-current": 'var(--color-2)'});
    
    // In multiplayer, handle turn logic
    if (isMultiplayer) {
      waitingForMove = !isHost;
      
      // Don't start bot action in multiplayer
      if (delayedCall) {
        delayedCall.kill();
      }
    } else if (delayedCall) {
      delayedCall.kill();
      delayedCall = gsap.delayedCall(1, botActionRandom);
    }
  } else {
    currentPlayer = playerArray[0];
    TweenMax.to("html", 0, {"--color-current": 'var(--color-1)'});
    
    // In multiplayer, handle turn logic
    if (isMultiplayer) {
      waitingForMove = isHost;
      
      // Don't start bot action in multiplayer
      if (delayedCall) {
        delayedCall.kill();
      }
    } else if (delayedCall) {
      delayedCall.kill();
    }
  }
  $(".field").addClass(currentPlayer);
  moveAmount++;
  //console.log("nextPlayer: " + currentPlayer);
}
//nextPlayer();

function playerClassClear() {
  return playerArray.join(" ");
}

function incrementDotStage(trgt) {
  //console.log('>> index: ' + trgt.index());
  trgt.attr("data-increment", parseInt(trgt.attr("data-increment")) - 1);
  if (parseInt(trgt.attr("data-increment")) <= 0) {
    trgt.removeClass("increment");
  }
  if (!trgt.is('[class*="stage--"]')) {
    trgt.addClass("stage--1 " + currentPlayer);
  } else {
    for (i = 1; i <= stage_amount; i++) {
      var currStage = trgt.is('[class*="stage--' + i + '"]');
      if (currStage && i < stage_amount) {
        trgt
          .removeClass("stage--" + i)
          .removeClass(playerClassClear)
          .addClass("stage--" + (i + 1) + " " + currentPlayer);
        animateNextDot();
        return;
      } else if (currStage && i == stage_amount) {
        trgt.removeClass("stage--" + i).removeClass(playerClassClear);
        if ("vibrate" in navigator) {
          window.navigator.vibrate([10, 10, 10]);
        }
        var k = dots.length;
        //console.log("k: " + k);
        while (--k > -1) {
          if (
            Draggable.hitTest(dots[k], trgt.find(".hitarea")) &&
            k != trgt.index()
          ) {
            //console.log(">> k: " + k);
            $(dots[k]).addClass("increment");
            //trgt.removeClass("increment");
            $(dots[k]).filter(function () {
              $(this).attr(
                "data-increment",
                parseInt($(this).attr("data-increment")) + 1
              );
            });
          }
        }
      }
    }
  }
  animateNextDot();
}

function animateNextDot() {
  if ($(".dot.increment").length > 0) {
    var next = $(".dot.increment").eq(0);
    TweenMax.delayedCall(0, incrementDotStage, [next]);
  } else {
    $(".field").removeClass("animating");
    checkDotmination();
  }
}

function checkDotmination() {
  if (
    moveAmount < 2 ||
    ($(".dot.player--1").length > 0 && $(".dot.player--2").length > 0)
  ) {
    nextPlayer();
  } else {
    //console.log("won by: " + currentPlayer);
    stop();
    sound.play();
    
    if (currentPlayer == "player--2") {
      if (level < 100) {
        if($('body').hasClass('mode-regular')) {
          level++;
        }/*  else {
          var goalMoves = '';
          var goalTime = '';
        } */
        
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
        
        $("body .container").append(
          '<div class="end overlay noselect ' +
            currentPlayer +
            '"><div class="card"><h1>Dotmination!</h1><span class="level-goals"><i class="fas fa-star level-goals-won active"></i><i class="fas fa-star level-goals-moves ' + goalMoves + '"></i><i class="fas fa-star level-goals-time ' + goalTime + '"></i></span><p>Next Level <i class="fas fa-arrow-right"></i></p></div></div>'
        );
        TweenMax.fromTo($('.overlay > .card'), 2, {alpha: 0, scale: 0}, {alpha: 1, scale: 1, ease:Elastic.easeOut});
      } else {
        level = 1;
        $("body .container").append(
          '<div class="end overlay noselect ' +
            currentPlayer +
            '"><div class="card"><h1>Dotmination!</h1><p>Next Level <i class="fas fa-undo"></i></h1></div></div>'
        );
      }
      
      if($('body').hasClass('mode-regular')) {
        var levelObj = {'level': level};
        myDotmination['level'] = level;
        
        timeBest = (levelsArray['level' + (level - 1)] !== undefined) ? levelsArray['level' + (level - 1)].time : null;
        timeDiff = moment.duration($('#time').html()).subtract(timeBest).asMilliseconds();
        
        $('.timediff').remove();
        
        if(!timeBest || timeDiff < 0) {
          //console.log('---- TIME IMPROVED ----');
          levelsArray['level' + (level - 1)] = {'time': $('#time').html()};
          //$('.overlay').append('<div class="timediff">New time record!</div>');
          myDotmination['levels'] = levelsArray;
          myStorage.setObj("myDotmination", myDotmination);
        } else {
          //$('.overlay').append('<div class="timediff">Too slow!</div>');
        }
      }
    } else {
      $("body .container").append(
        '<div class="end overlay noselect ' +
          currentPlayer +
          '"><div class="card"><h1>Dotmination!</h1><span class="level-goals"><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i></span><p>Retry <i class="fas fa-undo"></i></p></div></div>'
      );
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
  currentPlayer = "player--2"; //playerArray[randomNumber];
  $('.level-value').html(level);
  setDots();
  //nextPlayer();
  $(".end").remove();
  $(".dot").removeClass(playerClassClear);
  
  if(gameMode == 'regular') {
    var populate = fieldPopulateByLevel;
  } else {
    var populate = fieldPopulateRandom;
    
    // For random mode, clear the map parameter from URL when starting a new game
    if ($(".end").length > 0) {  // If we're coming from an end screen
      var newUrl = window.location.pathname + '?mode=random';
      window.history.replaceState({}, document.title, newUrl);
    }
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
    populate
  );
}
startAnim();

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
  // Check if there's a map parameter in the URL
  var urlParams = new URLSearchParams(window.location.search);
  var mapParam = urlParams.get('map');
  
  if (mapParam) {
    // Try to build the map from the URL parameter
    var success = buildMapFromString(mapParam);
    if (!success) {
      // If failed, generate a new random map
      generateRandomMap();
    }
  } else {
    // No map parameter, generate a new random map
    generateRandomMap();
  }
  
  // Generate a new map string and update the URL
  var newMapString = generateMapString();
  var newUrl = window.location.pathname + '?mode=random&map=' + newMapString;
  window.history.replaceState({}, document.title, newUrl);
  
  dots = $(".dot");
  gsap.delayedCall(1, nextPlayer);
  show();
  reset();
  start();
}

// Helper function to generate a truly random map
function generateRandomMap() {
  $(".field .dot").each(function(index) {
    var randomStage = Math.floor(Math.random() * (stage_amount + 1));
    var randomPlayerNumber = Math.floor(Math.random() * playerArray.length) + 1;
    
    if (randomStage === 0) {
      // Empty cell
      $(this).removeClass(function(index, className) {
        return (className.match(/(^|\s)stage--\S+/g) || []).join(' ');
      }).removeClass(playerClassClear);
    } else {
      $(this).addClass(
        "stage--" + randomStage + " player--" + randomPlayerNumber
      );
    }
  });
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
}

var colorNeutral = "#7F7F7F";
var colorsArr = [["#12DACE", "#E11168"], ["#1100FF", "#FF3F00"], ["#FF00FF", "#0000FF"], ["#5158af", "#af5160"]];
var colorsIndex = 0;

const hexToRgb = hex =>
  hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i
             ,(m, r, g, b) => '#' + r + r + g + g + b + b)
    .substring(1).match(/.{2}/g)
    .map(x => parseInt(x, 16));

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
  /* TweenMax.to($(".players .player--1"), 1, {
    css: { backgroundColor: colorsArr[colorsIndex][0] },
    overwrite: true
  });
  TweenMax.to($(".players .player--2"), 1, {
    css: { backgroundColor: colorsArr[colorsIndex][1] },
    overwrite: true
  }); */
  
  TweenMax.to("html", 0, {"--color-1": colorsArr[colorsIndex][0]});
  
  TweenMax.to("html", 0, {"--color-1-rgba-0": 'rgba(' + hexToRgb(colorsArr[colorsIndex][0]) + ',0.75)'});
  TweenMax.to("html", 0, {"--color-1-rgba-1": 'rgba(' + hexToRgb(colorsArr[colorsIndex][0]) + ',0.4)'});
  TweenMax.to("html", 0, {"--color-1-rgba-2": 'rgba(' + hexToRgb(colorsArr[colorsIndex][0]) + ',0.3)'});
  TweenMax.to("html", 0, {"--color-1-rgba-3": 'rgba(' + hexToRgb(colorsArr[colorsIndex][0]) + ',0.2)'});
  TweenMax.to("html", 0, {"--color-1-rgba-4": 'rgba(' + hexToRgb(colorsArr[colorsIndex][0]) + ',0.1)'});
  TweenMax.to("html", 0, {"--color-1-rgba-5": 'rgba(' + hexToRgb(colorsArr[colorsIndex][0]) + ',0)'});
  
  TweenMax.to("html", 0, {"--color-2": colorsArr[colorsIndex][1]});
  
  TweenMax.to("html", 0, {"--color-2-rgba-0": 'rgba(' + hexToRgb(colorsArr[colorsIndex][1]) + ',0.75)'});
  TweenMax.to("html", 0, {"--color-2-rgba-1": 'rgba(' + hexToRgb(colorsArr[colorsIndex][1]) + ',0.4)'});
  TweenMax.to("html", 0, {"--color-2-rgba-2": 'rgba(' + hexToRgb(colorsArr[colorsIndex][1]) + ',0.3)'});
  TweenMax.to("html", 0, {"--color-2-rgba-3": 'rgba(' + hexToRgb(colorsArr[colorsIndex][1]) + ',0.2)'});
  TweenMax.to("html", 0, {"--color-2-rgba-4": 'rgba(' + hexToRgb(colorsArr[colorsIndex][1]) + ',0.1)'});
  TweenMax.to("html", 0, {"--color-2-rgba-5": 'rgba(' + hexToRgb(colorsArr[colorsIndex][1]) + ',0)'});
  
  var currentColor;
  if($('.field').hasClass('player--1')) {
    currentColor = 1;
  } else {
    currentColor = 2;
  }
  TweenMax.to("html", 0, {"--color-current": colorsArr[colorsIndex][currentColor - 1]});
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
});

$('.modal .wrapper').on('click', function(e) {
  e.stopImmediatePropagation();
});

$('.modal-close').on('click', function() {
  $(this).closest('.modal').removeClass('active');
  $('body').removeClass('modal-open');
});
// END Modal

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
  
  $(Object.keys(levelsArray)).each(function(index) {
    var itemTimeAsSeconds = moment.duration('00:'+levelsArray['level'+(index + 1)].time).asSeconds();
    
    // Check Best Time
    if(bestTimeAsSeconds == undefined) {
      bestTimeAsSeconds = itemTimeAsSeconds;
      bestTimeIndex = index;
    } else if(bestTimeAsSeconds > itemTimeAsSeconds) {
      bestTimeAsSeconds = itemTimeAsSeconds;
      bestTimeIndex = index;
    }
    $('.profile-modal .best-time').attr('data-level', bestTimeIndex + 1);
    $('.profile-modal .best-time h1').html(levelsArray['level'+(bestTimeIndex + 1)].time);
    $('.profile-modal .best-time .time-level').html('Level ' + (bestTimeIndex + 1));
    
    // Check Worst Time
    if(worstTimeAsSeconds == undefined) {
      worstTimeAsSeconds = itemTimeAsSeconds;
      worstTimeIndex = index;
    } else if(worstTimeAsSeconds < itemTimeAsSeconds) {
      worstTimeAsSeconds = itemTimeAsSeconds;
      worstTimeIndex = index;
    }
    $('.profile-modal .worst-time').attr('data-level', worstTimeIndex + 1);
    $('.profile-modal .worst-time h1').html(levelsArray['level'+(worstTimeIndex + 1)].time);
    $('.profile-modal .worst-time .time-level').html('Level ' + (worstTimeIndex + 1));
  });
}
// END Profile modal

// Mode Modal
$('.level, .random, .mode-modal .backdrop').on('click', function(e) {
  e.stopPropagation();
  $('body').toggleClass('modal-open');
  
  if($('body').hasClass('modal-open')) {
    updateLevelList();
  }
});

// Fix the multiplayer mode selection and button behavior
$('.mode-modal .wrapper').on('click', '.card', function(e) {
  if($(this).hasClass('btn-level')) {
    gameMode = 'regular';
    level = $(this).data('level');
    $('.level-value').html(level);
    
    // Update URL for regular mode
    var newUrl = window.location.pathname + '?mode=regular&level=' + level;
    window.history.replaceState({}, document.title, newUrl);
    
    startAnim();
  } else if($(this).data('mode') === 'multiplayer') {
    gameMode = 'multiplayer';
    
    // Don't close the modal for multiplayer
    $('.multiplayer-options').show();
    $('.game-id-display, .game-id-input').hide();
    
    // Update URL for multiplayer mode
    var newUrl = window.location.pathname + '?mode=multiplayer';
    window.history.replaceState({}, document.title, newUrl);
    
    // Update UI - make sure only this button is selected
    $('.mode-modal .card').removeClass('selected');
    $(this).addClass('selected');
    
    $('body')
      .removeClass('mode-random mode-regular')
      .addClass('mode-multiplayer');
      
    return; // Don't proceed with the rest of the function
  } else {
    gameMode = $(this).data('mode');
    
    // Update URL for the selected mode
    if (gameMode === 'random') {
      // For random mode, we'll add the map parameter when the map is generated
      var newUrl = window.location.pathname + '?mode=random';
      window.history.replaceState({}, document.title, newUrl);
    } else {
      var newUrl = window.location.pathname + '?mode=' + gameMode;
      window.history.replaceState({}, document.title, newUrl);
    }
  }
    
  // Update the selection UI
  $('.mode-modal .card').removeClass('selected');
  $(this).addClass('selected');
  
  $('body')
    .removeClass('mode-random mode-regular mode-multiplayer modal-open')
    .addClass('mode-'+gameMode);
  
  if(gameMode === 'regular' && !$(this).hasClass('btn-level')) {
    $('body').addClass('modal-open');
  } else {
    startAnim();
  }
});

function updateLevelList() {
  //console.log('updateLevelList', levelsArray);
  var list = $('.list--mode-regular');
  var listWrapper = $(list).find('ul');
  var listItem = $(list).find('li');
  
  $(listWrapper).html('');
  $.each( levelsArray, function( key, value ) {
    if(key !== 'level0') {
      if(moment.duration('00:'+value.time).asSeconds() != 0 && moment.duration('00:'+value.time).asSeconds() < 120) {
        var goalMoves = 'active';
      } else {
        var goalMoves = '';
      }
      
      if(moment.duration('00:'+value.time).asSeconds() != 0 && moment.duration('00:'+value.time).asSeconds() < 60) {
        var goalTime = 'active';
      } else {
        var goalTime = '';
      }
      
      $(listWrapper).append('<li class="card btn btn-level" data-level="' + key.split('level')[1] + '"><h2 class="level-number">' + key.split('level')[1] + '</h2><span class="level-time">' + value.time + '</span><span class="level-goals"><i class="fas fa-star level-goals-won active"></i><i class="fas fa-star level-goals-moves ' + goalMoves + '"></i><i class="fas fa-star level-goals-time ' + goalTime + '"></i></span></li>');
    }
    
    if(key.split('level')[1] == level) {
      $('li[data-level="'+ level +'"]').addClass('selected');
    }
  });
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
  //gsap.delayedCall(3, startup);
  gsap.to('.intro', {duration: 0.3, delay:2, autoAlpha: 0});
  gsap.delayedCall(2, startAnim);
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

// Add a function to check URL parameters on page load
function checkUrlParameters() {
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
    } else if (mode === 'multiplayer') {
      // Check for multiplayer ID parameter
      var idParam = urlParams.get('id');
      if (idParam) {
        // Auto-join the game if ID is provided
        $('#join-id').val(idParam);
        isHost = false;
        isMultiplayer = true;
        initPeer();
        connectToPeer(idParam);
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
    var $newButton = $('<div class="' + buttonClass + '" data-mode="multiplayer"><i class="fas fa-users"></i><span>Multiplayer</span></div>');
    
    // Add it after the random button
    $('.mode-modal .card[data-mode="random"]').after($newButton);
  }
  
  // Add the multiplayer options to the modal if they don't exist
  if ($('.multiplayer-options').length === 0) {
    $('.mode-modal .wrapper').append(`
      <div class="multiplayer-options" style="display: none;">
        <h3>Multiplayer Game</h3>
        <div class="multiplayer-buttons">
          <button id="create-game" class="btn-primary">Create Game</button>
          <button id="join-game" class="btn-primary">Join Game</button>
        </div>
      </div>
      
      <div class="game-id-display" style="display: none;">
        <h3>Game ID</h3>
        <p>Share this ID with your opponent: <span id="game-id"></span></p>
        <button class="btn-primary copy-id">Copy ID</button>
      </div>
      
      <div class="game-id-input" style="display: none;">
        <h3>Enter Game ID</h3>
        <input type="text" id="join-id" placeholder="Paste Game ID here">
        <button class="btn-primary btn-connect">Connect</button>
      </div>
    `);
    
    console.log("Added multiplayer options to modal");
  }
  
  // Create Game button handler
  $(document).off('click', '#create-game').on('click', '#create-game', function(e) {
    // Prevent any default behavior
    e.preventDefault();
    e.stopPropagation();
    
    console.log("Create game clicked");
    
    // Set state
    isHost = true;
    isMultiplayer = true;
    gameMode = 'multiplayer';
    
    // Update body class
    $('body')
      .removeClass('mode-random mode-regular modal-open')
      .addClass('mode-multiplayer');
    
    // Force the URL to be multiplayer mode
    var newUrl = window.location.pathname + '?mode=multiplayer';
    window.history.replaceState({}, document.title, newUrl);
    
    // Initialize PeerJS
    initPeer();
    
    // Update UI
    $('.multiplayer-options').hide();
    $('.game-id-display').show();
    
    // Show waiting overlay immediately
    showWaitingOverlay();
    
    // Start the multiplayer game with empty field
    startMultiplayerAnim();
    
    // Prevent the modal from closing automatically
    return false;
  });
  
  // Join Game button handler
  $(document).off('click', '#join-game').on('click', '#join-game', function(e) {
    // Prevent any default behavior
    e.preventDefault();
    e.stopPropagation();
    
    console.log("Join game clicked");
    
    // Set state
    isHost = false;
    isMultiplayer = true;
    gameMode = 'multiplayer';
    
    // Update body class
    $('body')
      .removeClass('mode-random mode-regular')
      .addClass('mode-multiplayer');
    
    // Force the URL to be multiplayer mode
    var newUrl = window.location.pathname + '?mode=multiplayer';
    window.history.replaceState({}, document.title, newUrl);
    
    // Initialize PeerJS
    initPeer();
    
    // Update UI - show the input field
    $('.multiplayer-options').hide();
    $('.game-id-input').show();
    
    // Prevent the modal from closing
    return false;
  });
  
  // Connect button handler
  $(document).off('click', '.btn-connect').on('click', '.btn-connect', function(e) {
    // Prevent any default behavior
    e.preventDefault();
    e.stopPropagation();
    
    const gameId = $('#join-id').val().trim();
    if (gameId) {
      console.log("Connecting to game:", gameId);
      
      // Force the URL to be multiplayer mode with the correct ID
      var newUrl = window.location.pathname + '?mode=multiplayer&id=' + gameId;
      window.history.replaceState({}, document.title, newUrl);
      
      // Connect to the peer
      connectToPeer(gameId);
      
      // Close the modal
      $('body').removeClass('modal-open');
    }
  });
});

// Add these variables at the top of your script with other variable declarations
let peer = null;
let conn = null;
let isHost = false;
let isMultiplayer = false;
let waitingForMove = false;
let lastMoveData = null;

// Properly create the Create Game click handler
$(document).off('click', '#create-game').on('click', '#create-game', function(e) {
  // Prevent any default behavior
  e.preventDefault();
  e.stopPropagation();
  
  console.log("Create game clicked");
  
  // Set state
  isHost = true;
  isMultiplayer = true;
  gameMode = 'multiplayer';
  
  // Update body class
  $('body')
    .removeClass('mode-random mode-regular modal-open')
    .addClass('mode-multiplayer');
  
  // Force the URL to be multiplayer mode
  var newUrl = window.location.pathname + '?mode=multiplayer';
  window.history.replaceState({}, document.title, newUrl);
  
  // Initialize PeerJS
  initPeer();
  
  // Update UI
  $('.multiplayer-options').hide();
  $('.game-id-display').show();
  
  // Show waiting overlay immediately
  showWaitingOverlay();
  
  // Start the multiplayer game with empty field
  startMultiplayerAnim();
  
  // Prevent the modal from closing automatically
  return false;
});

// Properly create the Join Game click handler
$(document).off('click', '#join-game').on('click', '#join-game', function(e) {
  // Prevent any default behavior
  e.preventDefault();
  e.stopPropagation();
  
  console.log("Join game clicked");
  
  // Set state
  isHost = false;
  isMultiplayer = true;
  gameMode = 'multiplayer';
  
  // Update body class
  $('body')
    .removeClass('mode-random mode-regular')
    .addClass('mode-multiplayer');
  
  // Force the URL to be multiplayer mode
  var newUrl = window.location.pathname + '?mode=multiplayer';
  window.history.replaceState({}, document.title, newUrl);
  
  // Initialize PeerJS
  initPeer();
  
  // Update UI - show the input field
  $('.multiplayer-options').hide();
  $('.game-id-input').show();
  
  // Prevent the modal from closing
  return false;
});

// Properly create the Connect button click handler
$(document).off('click', '.btn-connect').on('click', '.btn-connect', function(e) {
  // Prevent any default behavior
  e.preventDefault();
  e.stopPropagation();
  
  const gameId = $('#join-id').val().trim();
  if (gameId) {
    console.log("Connecting to game:", gameId);
    
    // Force the URL to be multiplayer mode with the correct ID
    var newUrl = window.location.pathname + '?mode=multiplayer&id=' + gameId;
    window.history.replaceState({}, document.title, newUrl);
    
    // Connect to the peer
    connectToPeer(gameId);
    
    // Close the modal
    $('body').removeClass('modal-open');
  }
});

// Add the connectToPeer function if missing
function connectToPeer(peerId) {
  console.log("Connecting to peer:", peerId);
  
  // Initialize peer if not already done
  if (!peer) {
    initPeer();
    
    // Need to wait for peer to be ready
    function tryConnect() {
      if (peer && peer.id) {
        conn = peer.connect(peerId);
        setupConnection();
      } else {
        setTimeout(tryConnect, 500);
      }
    }
    
    tryConnect();
  } else {
    conn = peer.connect(peerId);
    setupConnection();
  }
}

// Fix the setupConnection function to handle connection properly
function setupConnection() {
  console.log("Setting up connection");
  
  conn.on('open', function() {
    console.log('Connection established');
    
    // Hide waiting overlay
    $('.waiting-overlay').remove();
    
    // Clear the field for both players
    startMultiplayerAnim();
    
    // Set initial player states
    currentPlayer = "player--1"; // Always start with player 1
    
    // Set waiting state based on player
    if (isHost) {
      // Host is player 1, goes first
      waitingForMove = false;
    } else {
      // Client is player 2, waits for host's move
      waitingForMove = true;
    }
    
    // Update UI
    $(".field").removeClass(playerClassClear).addClass(currentPlayer);
    
    // Set color
    TweenMax.to("html", 0, {"--color-current": 'var(--color-1)'});
    
    // Add player indicators
    updatePlayerIndicators();
    
    // Update turn indicator
    updateTurnIndicator();
    
    // Send initial game state if host
    if (isHost) {
      sendGameState();
    }
    
    // Close the modal
    $('body').removeClass('modal-open');
  });
  
  conn.on('data', function(data) {
    console.log('Received data:', data);
    
    if (data.type === 'move') {
      // Handle opponent's move
      handleOpponentMove(data.dotIndex);
    } else if (data.type === 'gameState') {
      // Handle initial game state
      applyGameState(data.state);
    } else if (data.type === 'gameEnd') {
      // Handle game end message
      var winner = data.winner;
      var youWon = (isHost && winner === "player--1") || (!isHost && winner === "player--2");
      showGameEndMessage(youWon);
    } else if (data.type === 'disconnect') {
      // Handle disconnect message
      console.log("Received disconnect message:", data.message);
      alert('The other player has disconnected.');
      resetMultiplayer();
      
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
  });
}

// Add a function to update player indicators
function updatePlayerIndicators() {
  // Remove any existing indicators
  $('.player-indicator').remove();
  
  // Add "You" indicator to show which player you are
  if (isHost) {
    $('.player.player--1').append('<span class="player-indicator">(You)</span>');
    $('.player.player--2').append('<span class="player-indicator">(Opponent)</span>');
  } else {
    $('.player.player--2').append('<span class="player-indicator">(You)</span>');
    $('.player.player--1').append('<span class="player-indicator">(Opponent)</span>');
  }
}

// Add a function to update the turn indicator
function updateTurnIndicator() {
  // Remove any existing indicators
  $('.turn-indicator').remove();
  
  // Add the turn indicator
  if ((currentPlayer === 'player--1' && isHost) || (currentPlayer === 'player--2' && !isHost)) {
    // It's your turn
    $('header').append('<div class="turn-indicator your-turn">Your Turn</div>');
  } else {
    // It's opponent's turn
    $('header').append('<div class="turn-indicator opponent-turn">Opponent\'s Turn</div>');
  }
}

// Initialize PeerJS
function initPeer() {
  console.log("Initializing PeerJS connection");
  
  // Don't initialize if already initialized
  if (peer) {
    console.log("PeerJS already initialized");
    return;
  }
  
  // Force the game mode to be multiplayer
  gameMode = 'multiplayer';
  
  // Create the peer
  peer = new Peer({
    debug: 2 // Set debug level for testing
  });
  
  peer.on('open', function(id) {
    console.log('PeerJS connection opened with ID:', id);
    $('#game-id').text(id);
    
    // Force the URL to be correct for multiplayer
    var correctUrl = window.location.pathname + '?mode=multiplayer&id=' + id;
    window.history.replaceState({}, document.title, correctUrl);
    
    // Make sure the body class is correct
    $('body')
      .removeClass('mode-random mode-regular')
      .addClass('mode-multiplayer');
  });
  
  peer.on('connection', function(connection) {
    console.log('Incoming connection from peer');
    conn = connection;
    setupConnection();
    
    if (isHost) {
      // Host starts the game when connection is established
      $('body').removeClass('modal-open');
      $('.waiting-overlay').remove();
    }
  });
  
  peer.on('error', function(err) {
    console.error('PeerJS error:', err);
    alert('Connection error: ' + err.message);
  });
}

// Function to show waiting overlay
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
