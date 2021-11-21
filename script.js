$(".overlay .close-btn").on("click", function() {
  //if($(this).hasClass('current')) {
  $(".overlay").removeClass("current");
  $(".grid-item").removeClass("current");
  //}
});

var swiperHorizontal = new Swiper(".swiper-container.horizontal", {
  spaceBetween: 5,
  centeredSlides: true,
  loop: true,
  autoplay: 6000,
  autoplayDisableOnInteraction: false,
  slidesPerView: "auto",
  slideToClickedSlide: true,
  loopedSlides: 0
});

$('.menu .logo').on('click', function() {
  $(".menu-item").removeClass("current");
  swiperScroll.slideTo($('.swiper-scroll').find('[data-section="' + $(this).attr('data-section') + '"]').index());
});

$(".menu-item").on("click", function() {
  $(".menu-item").removeClass("current");
  $(this).addClass("current");
  swiperMenu.slidePrev();
  swiperScroll.slideTo($('.swiper-scroll').find('[data-section="' + $(this).attr('data-section') + '"]').index());
});

var swiperMenu = new Swiper(".swiper-container.swiper-menu", {
  slidesPerView: "auto",
  initialSlide: 0,
  resistanceRatio: 0.00000000000001,
  watchSlidesProgress: true,
  on: {
    transitionStart: function(slider) {
      if (swiperMenu.progress == 0) {
        //TweenMax.to($('.swiper-scroll .swiper-scrollbar'), 0.4, {autoAlpha: 1});
      } else {
        TweenMax.to($('.swiper-scroll .swiper-scrollbar'), 0.2, {autoAlpha: 0});
      }
    },
    transitionEnd: function(slider) {
      //console.log("onTransitionEnd: " + swiperMenu.progress);
      //swiperScroll.update(true);
      if (swiperMenu.progress == 0) {
        $(".all").removeClass("open");
        TweenMax.to($('.swiper-scroll .swiper-scrollbar'), 0.6, {autoAlpha: 1});
        if(swiperScroll.progress == 0) {
          $('#demo')[0].play();
        }
      } else {
        $(".all").addClass("open");
        $('#demo')[0].pause();
        //TweenMax.to($('.swiper-scroll .swiper-scrollbar'), 0.4, {autoAlpha: 0});
      }
    },
    slideNextTransitionStart: function(slider) {
      //console.log("next");
      $(".all").addClass("open");
    },
    slidePrevTransitionEnd: function(slider) {
      //console.log("prev");
      $(".all").removeClass("open");
    }
  },
  slideToClickedSlide: false
});

$(".menu-btn").on("click", ".menu-icon", function() {
  $(".all").toggleClass("open");
  //console.log("> " + swiperMenu.progress);
  if (swiperMenu.progress == 0) {
    swiperMenu.slideNext();
  } else {
    swiperMenu.slidePrev();
  }
});

var swiperScroll = new Swiper(".swiper-container.swiper-scroll", {
  scrollbar: {
    el: '.swiper-scroll .swiper-scrollbar',
    draggable: true,
  },
  direction: "vertical",
  slidesPerView: "auto",
  mousewheel: true,
  freeMode: false,
  freeModeSticky: true,
  on: {
    transitionStart: function(slider) {
      swiperMenu.slidePrev();
    },
    setTranslate: function(slider) {
      //$(".swiper-scroll .swiper-slide-active .player").YTPPause();
      /* TweenMax.to($(".swiper-scroll .swiper-slide-active .videoTitle"), 0.6, {
        alpha: 1
      });
      TweenMax.to($(".swiper-scroll .swiper-slide-active .videoOverlay"), 0.6, {
        alpha: 0.5
      }); */
      //$(".swiper-scroll .swiper-slide-active .player").YTPMute();
    },
    transitionEnd: function(slider) {
      var tgt = $(
        ".swiper-scroll .swiper-slide-prev .player, .swiper-scroll .swiper-slide-next .player"
      );
      //tgt.YTPPause();
      /* TweenMax.to(tgt.parent().find(".videoTitle"), 0.6, { alpha: 1 });
      TweenMax.to(tgt.parent().find(".videoOverlay"), 0.6, { alpha: 0.5 }); */
      //$(".swiper-scroll .swiper-slide-active .player").YTPPlay();
      if(swiperScroll.progress == 0) {
        $('#demo')[0].play();
      } else {
        $('#demo')[0].pause();
      }
      $(".menu-item").removeClass("current");
      $('.menu-item[data-section="' + $('.swiper-scroll .swiper-slide-active').attr('data-section') + '"]').addClass("current");
    },
    slideNextTransitionEnd: function(slider) {
      $(".icon-scrolldown").remove();
    },
    onScroll: function(slider) {
      swiperMenu.slidePrev();
      //$(".swiper-scroll .swiper-slide-active .player").YTPPause();
      /* TweenMax.to($(".swiper-scroll .swiper-slide-active .videoTitle"), 0.6, {
        alpha: 1
      });
      TweenMax.to($(".swiper-scroll .swiper-slide-active .videoOverlay"), 0.6, {
        alpha: 0.5
      }); */
      //$(".swiper-scroll .swiper-slide-active .player").YTPMute();
    }
  }
});

$(".swiper-menu .swiper-slide:nth-child(1)").on("click", function() {
  swiperMenu.slidePrev();
});

// TODO: Add update for Video adapting to Desktop/Mobile.
function updateVideoSize() {}

function checkWindow() {
  var v = $(window);

  $("body")
    .removeClass("is-desktop")
    .removeClass("is-mobile");

  if ($(v).width() > 768) {
    $("body").addClass("is-desktop");
  } else if ($(v).width() <= 767.99) {
    $("body").addClass("is-mobile");
  }

  updateVideoSize();
}

$(function() {
  checkWindow();
});

$(window).on("resize", function() {
  checkWindow();
});

function videoMuteToggle(val) {
  var video = $('#demo')[0];
  $('.btn-video-mute').removeClass('is-muted');
  if (video.muted && val == undefined) {
    video.muted = false;
  } else {
    video.muted = true;
    $('.btn-video-mute').addClass('is-muted');
  }
}
videoMuteToggle('muted');

$('.btn-video-mute').on('click', function() {
  videoMuteToggle();
});