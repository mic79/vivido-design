$('.disabled').on('click', function(e) {
  e.preventDefault();
});

$('.title h2').on('click', 'a:not(.disabled)', function(e) {
  e.preventDefault();
  var page = $(this).parents('.page');
  var currindex = $(this).index();
  //console.log('currindex: ' + currindex);
  gotoQuestion(currindex + 1, page);
});
$('.question').on('click', '.question-btn-next:not(.disabled)', function(e) {
  var page = $(this).parents('.page');
  var currindex = $(this).parents('.question').index();
  //console.log('currindex: ' + currindex);
  gotoQuestion(currindex + 1, page);
});
$('.question').on('click', '.question-btn-send:not(.disabled)', function(e) {
  var currpage = $(this).parents('.page');
  var answers = "";
  currpage.find('label.active').each(function(index, element) {
    var val = $(this).parents('.question-card').html();
    if (val) {
      answers += val;
    }
  });
  currpage.find('.question-card').addClass('saved');
  $(this).parents('.question').addClass('answer');
  $('.answer').html('<div class="col-1-3"><img src="http://nuovo.com.br/agenda/images/screen.jpg" class="animated fadeIn"></div><div class="col-2-3 animated fadeInRight"><h1>Obrigado pelo seu pedido de agendamento</h1><h3>Em breve enviaremos um e-mail de confirmação.</h3></div>');
});

function gotoQuestion(num, page) {
  page.find('.content .title h2 a.current').removeClass('current');
  page.find('.content .title h2 a:nth-child(' + num + ')').addClass('current');
  page.find('.content .question.current').removeClass('current');
  page.find('.content .question:nth-child(' + (num + 1) + ')').addClass('current');
  //page.find('.content .question.current .swiper-container').reInit();
}

$('.swiper-container').each(function() {
  new Swiper($(this), {
    //var mySwiper = new Swiper('.swiper-container', {
    pagination: $(this).find('.pagination'),
    paginationClickable: true,
    slidesPerView: 5,
    spaceBetween: 0,
    loop: false,
    grabCursor: true,
    breakpoints: {
      1440: {
        slidesPerView: 4,
        spaceBetween: 0
      },
      1280: {
        slidesPerView: 3,
        spaceBetween: 0
      },
      768: {
        slidesPerView: 2,
        spaceBetween: 0
      },
      480: {
        slidesPerView: 1,
        spaceBetween: 0
      }
    }
  });
});
$('.swiper-container').on('slideChangeStart', function() {
  //console.log('slide change start');
  $('.swiper-slide-next').addClass('swiper-slide-active');
});
/* Trick to fix clickable links in Slides */
$(".swiper-container .swiper-slide a").bind("click", function() {
  window.open($(this).attr('href'), '_blank');
});

$('div').on('click', '.question-card:not(.saved)', function(e) {
  e.stopPropagation();
  inputCheck($(this).find('label'));
});
$('label').on('click', function(e) {
  e.preventDefault();
});

function inputCheck(trgt) {
  if (!trgt.hasClass('active')) {
    if (trgt.hasClass('radio')) {
      trgt.parents('.question').find('.radio').removeClass('active');
    }
    trgt.addClass('active');
  } else {
    trgt.removeClass('active');
  }
  checkActive(trgt);
}

function checkActive(trgt) {
  if ($('.question.current .active').length > 0) {
    //console.log('One or more selected');
    trgt.parents('.question').find('.question-btn').removeClass('disabled');
    trgt.parents('.page').find('.title h2 a.current').next().removeClass('disabled');
    if ($('.question.current').next().find('.active').length > 0) {
      trgt.parents('.page').find('.title h2 a.current').next().next().removeClass('disabled');
    }
  } else {
    //console.log('None selected');
    trgt.parents('.question').find('.question-btn').addClass('disabled');
    trgt.parents('.page').find('.title h2 a.current').nextAll().addClass('disabled');
  }
}

$('div').on('click', '.form-line label', function() {
  var labelID = $(this).attr('for');
  $('input[name=' + labelID + '],textarea[name=' + labelID + ']').focus();
});
$('input,textarea,checkbox').on('focusin', function() {
  $(this).parent().prev().addClass('focused').removeClass('invalid');
});
$('input,textarea,checkbox').on('focusout', function() {
  $(this).parent().prev().removeClass('focused');
});

$('.your-name input').on('input', function(e) {
  if (validateName($(this).val()) && validateEmail($('.your-email input').val())) {
    $('.question-btn-send').removeClass('disabled');
  } else {
    $('.question-btn-send').addClass('disabled');
  }
});
$('.your-email input').on('input', function(e) {
  if (validateEmail($(this).val()) && validateName($('.your-name input').val())) {
    $('.question-btn-send').removeClass('disabled');
  } else {
    $('.question-btn-send').addClass('disabled');
  }
});

function validateName(sName) {
  var filter = /^[a-zA-Z0-9\.\- áãâäàéêëèíîïìóõôöòúûüùçÁÃÂÄÀÉÊËÈÍÎÏÌÓÕÔÖÒÚÛÜÙÇ]{3,40}$/;
  if (filter.test(sName)) {
    return true;
  } else {
    return false;
  }
}

function validateEmail(sEmail) {
  var filter = /^[\w\-\.\+]+\@[a-zA-Z0-9\.\-]+\.[a-zA-z0-9]{2,4}$/;
  if (filter.test(sEmail)) {
    return true;
  } else {
    return false;
  }
}