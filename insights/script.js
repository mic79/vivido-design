var user_id, user_name, user_totalhours, user_email, user_photo;
var starturl = window.location.pathname.toString().split('/')[2];
var urlkey = document.URL.split('key=')[1];
if(!urlkey) {urlkey = "0";}
console.log('starturl: '+starturl);
console.log('urlkey: '+urlkey);
var currLang = "pt-br";

// Initialize Firebase
var config = {
  apiKey: "AIzaSyDapJcLI0GPY42gGI8AxZPLJXsUvig7wRo",
  authDomain: "nuovo-insights.firebaseapp.com",
  databaseURL: "https://nuovo-insights.firebaseio.com",
  storageBucket: "nuovo-insights.appspot.com",
};
firebase.initializeApp(config);

page.base('/insights');
page('/', function(){
  // some logic to decide which route to redirect to
  console.log('login');
  /*if(admin) {
    page.redirect('/admin');
  } else {
    page.redirect('/guest');
  }*/
  TweenMax.to($('#profile'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#proposal-history'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#todo'), 0.4, {
    autoAlpha: 0
  });
});
page('/profile', function(){
  // some logic to decide which route to redirect to
  if(!user_id) {
    page.redirect('/');
    return;
  }
  console.log('profile');
  //document.getElementById('quickstart-sign-in-status').textContent = 'Signed in';
  TweenMax.to($('#login'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#btn-menu'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#btn-edit'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#btn-listall'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#my-chart-container'), 0, {
    scale: 0,
    autoAlpha:0
  });
  TweenMax.to($('#profile #chart-list li'), 0, {
    scale: 0,
    autoAlpha:0
  });
  //TweenMax.to($('#menu'),0.4,{autoAlpha:1});
  //TweenMax.to($('#menu-right'),0.4,{autoAlpha:1});
  TweenMax.to($('#profile'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#proposal-history'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#todo'), 0.4, {
    autoAlpha: 0
  });
  //if(firstrun) {
    //function getProfileLabels() {
      console.log('getProfileLabels');
      var getProfileLabels = firebase.database().ref('/module_profile/labels/' + currLang).once('value').then(function(snapshot) {
        snapshot.forEach(function(childSnapshot) {
          var key = childSnapshot.key;
          var childData = childSnapshot.val();
          //console.log('key: '+key+', val: '+childData);
          this['profile_'+key] = childData;
        });
        getActivities();
      });
    //}
    //getProfileLabels();
    function getActivities() {
      var getActivities = firebase.database().ref('/activities').once('value').then(function(snapshot) {
        console.log('getActivities');
        $('#chart-listall').html('<h1>Atividades</h1>');
        $('#profile #chart-list').html('');
        snapshot.forEach(function(childSnapshot) {
          var key = childSnapshot.key;
          var childData = childSnapshot.val();
          //console.log('key: '+key+', val: '+childData.label);
          if(childData.label) {
            $('#chart-listall').append('<h2>'+childData.label+'</h2>');
          }
          childSnapshot.forEach(function(childSnapshot2) {
            var key2 = childSnapshot2.key;
            var childData2 = childSnapshot2.val();
            console.log('key: '+key2+', val: '+childData2.label);
            if(childData2.label) {
              $('#profile #chart-list').append('<li data-key="'+key2+'">'+childData2.label+'</li>');
              $('#chart-listall').append('<li data-key="'+key2+'">'+childData2.label+'</li>');
            }
          });
        });
        //getProfileActivities();
        setProfileActivities();
      });
    }
    //getActivities();

    /*var profileActivities = firebase.database().ref('/users/' + user_id + '/profile_activities/');
    profileActivities.on('child_changed', function(data) {
      console.log('child_changed: '+data.key, data.val());
      $('#profile #chart-list li[data-key="'+data.key+'"]').attr('data-value',data.val());
      $('#chart-listall li[data-key="'+data.key+'"] small').html(data.val()+' '+profile_hours);
      //chartUpdate();
      //Pizza.init();
    });*/
    /*function updateProfileActivities(key,value) {
        profileActivities.update({
        key: value
      });
    }*/
    /*//var getProfileActivities = firebase.database().ref('/users/' + user_id + '/profile_activities').once('value').then(function(snapshot) {
    var getProfileActivities = firebase.database().ref('/users/' + user_id + '/profile_activities').on('child_added', function(snapshot) {
    //function getProfileActivities() {
      console.log('getProfileActivities: '+snapshot);
      var valuestotal = 0;
      //firebase.database().ref('/users/' + user_id + '/profile_activities/').on('value', function(snapshot) {
        snapshot.forEach(function(childSnapshot) {
          var key = childSnapshot.key;
          var childData = childSnapshot.val();
          //console.log('key: '+key+', val: '+childData);
          if(childData) {
            $('#profile #chart-list li[data-key="'+key+'"]').attr('data-value',childData).addClass('active');
            $('#chart-listall li[data-key="'+key+'"]').addClass('active').append('<small>'+childData+' '+profile_hours+'</small>');
          }
          valuestotal += parseInt(childData, 10);
        });
        user_totalhours = valuestotal;
        $('#profile #chart-list li').not('.active').remove();
        //startProfile();
      }, function (errorObject) {
        console.log("The read failed: " + errorObject.code);
      });
      //}*/

      var profileActivities = firebase.database().ref('/users/' + user_id + '/profile_activities');
      function setProfileActivities() {
        profileActivities.off('child_added');
        profileActivities.off('child_changed');
        profileActivities.off('child_removed');
        profileActivities.once('value').then(function(snapshot) {
          console.log('once');
          var childAmount = 0;
          var valuestotal = 0;
          snapshot.forEach(function(childSnapshot) {
            var key = childSnapshot.key;
            var childData = childSnapshot.val();
            //console.log('key: '+key+', val: '+childData);
            if(childData) {
              //$('#profile #chart-list li[data-key="'+key+'"]').attr('data-value',childData).addClass('active');
              //$('#chart-listall li[data-key="'+key+'"]').addClass('active').append('<small>'+childData+' '+profile_hours+'</small>');
            }
            valuestotal += parseInt(childData, 10);
            childAmount++;
          });
          user_totalhours = valuestotal;
          //$('#profile #chart-list li').not('.active').remove();
          //startProfile();
          var setup = true;
          var count = 1;
          var valuestotal = 0;
          profileActivities.on('child_added', function(data) {
            //if (!ignoreItems) {
              console.log('child_added: '+data.key, data.val());
              console.log('check: '+$('#profile #chart-list li[data-key="'+data.key+'"]'));
              if(setup) {
                var key = data.key;
                var childData = data.val();
                console.log('key: '+key+', val: '+childData);
                if(childData) {
                  //$('#profile #chart-list li[data-key="'+key+'"]').attr('data-value',childData);
                  //$('#chart-listall li[data-key="'+key+'"] small').html(childData+' '+profile_hours);
                  $('#profile #chart-list li[data-key="'+key+'"]').attr('data-value',childData).addClass('active');
                  $('#chart-listall li[data-key="'+key+'"]').addClass('active').append('<small>'+childData+' '+profile_hours+'</small>');
                }
                valuestotal += parseInt(childData, 10);
                user_totalhours = valuestotal;
                //getActivities();
              } else {
                getActivities();
              }
              console.log('count: '+count+' : '+childAmount);
              if(count >= childAmount) {
                $('#profile #chart-list li').not('.active').remove();
                setup = false;
                startProfile();
              }
              count++;
            //}
          }, function (errorObject) {
            console.log("The read failed: " + errorObject.code);
          });    
          profileActivities.on('child_changed', function(data) {
            console.log('child_changed: '+data.key, data.val());
            console.log('check: '+$('#profile #chart-list li[data-key="'+data.key+'"]'));
            if($('#profile #chart-list li[data-key="'+data.key+'"]')) {
              $('#profile #chart-list li[data-key="'+data.key+'"]').attr('data-value',data.val());
              $('#chart-listall li[data-key="'+data.key+'"] small').html(data.val()+' '+profile_hours);
              if($('#profile #chart-list li').hasClass('current')) {
                $('#profile #chart-list li.current').click();
              } else {
                var values = new Array();
                var valuestotal = 0;
                $('#profile #chart-list li.active').each(function() {
                  values.push(Number($(this).attr('data-value')));
                  valuestotal += parseInt($(this).attr('data-value'), 10);
                });
                user_totalhours = valuestotal;
                $('body').click();
              }
              chartUpdate();
              //Pizza.init();
            } else {
              getActivities();
            }
          });
          profileActivities.on('child_removed', function(data) {
            console.log('child_removed: '+data.key, data.val());
            $('#my-chart g').remove();
            getActivities();
          });
          //ignoreItems = false;
        });
      }
      //setProfileActivities();


    //Promise.all([getProfileLabels, getActivities]).then(function(results) {
    //Promise.all([getProfileLabels, getActivities, getProfileActivities]).then(function(results) {
      function startProfile() {
        console.log('startProfile');
        setPizza();
        TweenMax.to($('#my-chart-container'), 1, {
          scale: 1,
          autoAlpha:1,
          ease: Elastic.easeOut.config(1, 0.5)
        });
        TweenMax.staggerTo($('#profile #chart-list li'), 1, {autoAlpha:1, scale:1, ease: Elastic.easeOut.config(1, 0.5)}, 0.2);
        if(user_photo) {
          $('#chart-logo').html('<img src="'+user_photo+'">');
          TweenMax.to($('#chart-logo'), 0.4, {autoAlpha:1, delay:0.6});
        }
        TweenMax.to($('#chart-title'), 0, {
          text: {
            value: user_totalhours + ' ' + profile_hours
          },
          delay: 0.6
        });
        TweenMax.to($('#chart-title'), 0.4, {
          y: '0px',
          autoAlpha: 1,
          startAt: {
            y: '-30px',
            autoAlpha: 0
          },
          delay: 0.6
        });
        TweenMax.to($('#chart-value'), 0, {
          text: {
            value: user_name + '<hr><small>'+profile_per_month+'</small>'
          },
          delay: 0.4
        });
        TweenMax.to($('#chart-value'), 0.4, {
          y: '0px',
          autoAlpha: 1,
          startAt: {
            y: '-30px',
            autoAlpha: 0
          },
          delay: 0.4
        });
      }
    //});
    //firstrun = false;
  //}
});
page('/proposal-history', function(){
  // some logic to decide which route to redirect to
  console.log('proposal-history');
  //document.getElementById('quickstart-sign-in-status').textContent = 'Signed in';
  TweenMax.to($('#login'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#btn-menu'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#btn-edit'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#btn-listall'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#profile'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#proposal-history'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#todo'), 0.4, {
    autoAlpha: 0
  });
});
page('/todo', function(){
  // some logic to decide which route to redirect to
  console.log('todo');
  //document.getElementById('quickstart-sign-in-status').textContent = 'Signed in';
  TweenMax.to($('#login'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#btn-menu'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#btn-edit'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#btn-listall'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#profile'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#proposal-history'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#todo'), 0.4, {
    autoAlpha: 1
  });
});
page.start();


// [START googlecallback]
function onSignIn(googleUser) {
  console.log('Google Auth Response', googleUser);
  // We need to register an Observer on Firebase Auth to make sure auth is initialized.
  var unsubscribe = firebase.auth().onAuthStateChanged(function(firebaseUser) {
    unsubscribe();
    // Check if we are already signed-in Firebase with the correct user.
    if (!isUserEqual(googleUser, firebaseUser)) {
      // Build Firebase credential with the Google ID token.
      // [START googlecredential]
      var credential = firebase.auth.GoogleAuthProvider.credential(
        googleUser.getAuthResponse().id_token);
      // [END googlecredential]
      // Sign in with credential from the Google user.
      // [START authwithcred]
      firebase.auth().signInWithCredential(credential).catch(function(error) {
        // Handle Errors here.
        var errorCode = error.code;
        var errorMessage = error.message;
        // The email of the user's account used.
        var email = error.email;
        // The firebase.auth.AuthCredential type that was used.
        var credential = error.credential;
        // [START_EXCLUDE]
        if (errorCode === 'auth/account-exists-with-different-credential') {
          alert('You have already signed up with a different auth provider for that email.');
          // If you are using multiple auth providers on your app you should handle linking
          // the user's accounts here.
        } else {
          console.error(error);
        }
        // [END_EXCLUDE]
      });
      // [END authwithcred]
    } else {
      console.log('User already signed-in Firebase.');
      console.log('Id: ' + firebaseUser.uid);
      document.getElementById('quickstart-sign-in-status').textContent = 'Awaiting approval';
      var userId = firebase.auth().currentUser.uid;
      console.log('userId: ' + userId);
      /*firebase.database().ref('/users/' + userId).once('value', function(snapshot) {
        var verified = snapshot.val().verified;
        console.log('verified1: ' + verified);
      }, function (errorObject) {
        console.log("The read failed: " + errorObject.code);
      });*/
    }
  });
}
// [END googlecallback]
/**
* Check that the given Google user is equals to the given Firebase user.
*/
// [START checksameuser]
function isUserEqual(googleUser, firebaseUser) {
  if (firebaseUser) {
    var providerData = firebaseUser.providerData;
    for (var i = 0; i < providerData.length; i++) {
      if (providerData[i].providerId === firebase.auth.GoogleAuthProvider.PROVIDER_ID &&
        providerData[i].uid === googleUser.getBasicProfile().getId()) {
        // We don't need to reauth the Firebase connection.
      return true;
    }
  }
}
return false;
}
// [END checksameuser]
function handleSignOut() {
  var googleAuth = gapi.auth2.getAuthInstance();
  googleAuth.signOut().then(function() {
    firebase.auth().signOut();
  });
}

function initApp() {
  console.log('initApp');
  // Auth state changes.
  // [START authstatelistener]
  firebase.auth().onAuthStateChanged(function(user) {
    if (user) {
      // User is signed in.
      var displayName = user.displayName;
      var email = user.email;
      var emailVerified = user.emailVerified;
      var photoURL = user.photoURL;
      var isAnonymous = user.isAnonymous;
      var uid = user.uid;
      var refreshToken = user.refreshToken;
      var providerData = user.providerData;

      user_id = uid;
      user_name = displayName;
      user_email = email;
      user_photo = photoURL;
      $('#menu-list-username').html(user_name);
      $('#menu-list-useremail').html(user_email);
      if(user_photo) {
        $('#menu-list-userphoto').html('<img src="'+user_photo+'">');
      } else {
        $('#menu-list-userphoto').hide();
      }
      // [START_EXCLUDE]
      document.getElementById('quickstart-sign-in-status').textContent = 'Checking..';
      document.getElementById('signout').disabled = false;
      document.getElementById('quickstart-account-details').textContent = JSON.stringify({
        displayName: displayName,
        email: email,
        emailVerified: emailVerified,
        photoURL: photoURL,
        isAnonymous: isAnonymous,
        uid: uid,
        refreshToken: refreshToken,
        providerData: providerData
      }, null, '  ');
      // [END_EXCLUDE]

      writeUserData(uid, displayName, email);

      var userId = firebase.auth().currentUser.uid;
      firebase.database().ref('/users/' + userId).once('value', function(snapshot) {
        var verified = snapshot.val().verified;
        console.log('verified2: ' + verified);
        if (verified == true) {
          if(starturl == '') {
            page('/profile');
          } else {
            page('/'+starturl);
          }
        } else {
          console.log('verified3: ' + verified);
          document.getElementById('quickstart-sign-in-status').textContent = 'Awaiting approval';
        }
      }, function (errorObject) {
        console.log("The read failed: " + errorObject.code);
        if(urlkey != "0") {
          urlkey = "0";
          //console.log('verified: '+verified);
          page.redirect('/');
          initApp();
        } else {
          console.log('Sorry, no access');
          $.alert({
            title: '',
            content: 'Sorry, no access',
            confirmButton: '<i class="material-icons">&#xE876;</i>',
            theme: 'material',
            backgroundDismiss: true
          });
        }
      });
    } else {
      // User is signed out.
      // [START_EXCLUDE]
      document.getElementById('quickstart-sign-in-status').textContent = 'Signed out';
      document.getElementById('signout').disabled = true;
      document.getElementById('quickstart-account-details').textContent = 'null';
      // [END_EXCLUDE]

      TweenMax.to($('#btn-menu'), 0, {
        autoAlpha: 0
      });
      TweenMax.to($('#btn-edit'), 0.4, {
        autoAlpha: 0
      });
      TweenMax.to($('#btn-listall'), 0.4, {
        autoAlpha: 0
      });
      TweenMax.to($('#menu'), 0.4, {
        autoAlpha: 0
      });
      TweenMax.to($('#menu-right'), 0.4, {
        autoAlpha: 0
      });
      TweenMax.to($('#profile'), 0.4, {
        autoAlpha: 0
      });
      $('.menu-bg').click();
      TweenMax.to($('#login'), 0.4, {
        autoAlpha: 1
      });
      page('/');
    }
  });
  // [END authstatelistener]
  document.getElementById('signout').addEventListener('click', handleSignOut, false);
}
window.onload = function() {
  initApp();
};

function writeUserData(userId, name, email) {
  var ref = firebase.database().ref('users/' + userId);
  ref.update({
    username: name,
    email: email,
    urlkey: urlkey,
    verified: true,
    date_lastaccess: firebase.database.ServerValue.TIMESTAMP
  });
  ref.child('date_created').set(firebase.database.ServerValue.TIMESTAMP);
}

/* ---------- OUTROS ---------- */
function setPizza() {
  if (!Modernizr.touch) {
    Pizza.init(document.body, {
      donut: false,
      donut_inner_ratio: 0.4,
      percent_offset: 60,
      stroke_width: 0,
      show_percent: true,
      animation_speed: 500,
      animation_type: 'elastic'
    });
  } else {
    Pizza.init(document.body, {
      donut: false,
      donut_inner_ratio: 0.4,
      percent_offset: 30,
      stroke_width: 0,
      show_percent: true,
      animation_speed: 500,
      animation_type: 'elastic'
    });
  }
}
//setPizza();

// MENU
$('#menu-list').on('click', function(e) {
  e.stopPropagation(); 
});
$('#menu-list ul a').on('click', function(e) {
  e.stopPropagation();
  e.preventDefault();
  page($(this).attr('href'));
  $('.menu-bg').click();
});
TweenMax.to($('#menu, #menu-right'), 0, {
  autoAlpha: 0
});
$('.menu-bg').on('click', function(e) {
  e.stopPropagation();
  TweenMax.to($('#menu, #menu-right'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#menu-list'), 0.4, {
    x: '-220px'
  });
  TweenMax.to($('#menu-chart-list'), 0.4, {
    x: '220px'
  });
});
$('#btn-menu').on('click', function(e) {
  e.stopPropagation();
  TweenMax.to($('#menu'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#menu-list'), 1, {
    x: '0px',
    startAt: {
      x: '-220px'
    }
  });
});

$('#btn-edit').on('click', function(e) {
  $(this).toggleClass('active');
  if ($(this).hasClass('active')) {
    editOn();
  } else {
    editOff();
  }
  e.stopPropagation();
});
$('#btn-listall').on('click', function(e) {
  e.stopPropagation();
  TweenMax.to($('#menu-right'), 0.4, {
    autoAlpha: 1
  });
  TweenMax.to($('#menu-chart-list'), 1, {
    x: '0px',
    startAt: {
      x: '220px'
    }
  });
});

function editOn() {
  if ($('#profile #chart-list li').hasClass('current')) {
    var value = $('#profile #chart-list li.current').attr('data-value');
    $('.dial').val(value).trigger('change');
    TweenMax.to($('#btn-del'), 0.4, {
      autoAlpha: 1
    });
    TweenMax.to($('#my-chart-control'), 0.4, {
      autoAlpha: 1
    }); 
  }
}

function editOff() {
  TweenMax.to($('#btn-del'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#my-chart-control'), 0.4, {
    autoAlpha: 0
  });
}
TweenMax.to($('#chart-title'), 0, {
  y: '30px',
  autoAlpha: 0,
  text: {
    value: '.'
  }
});
TweenMax.to($('#chart-value'), 0, {
  y: '30px',
  autoAlpha: 0,
  text: {
    value: '.'
  }
});
TweenMax.to($('#btn-del'), 0, {
  autoAlpha: 0
});
TweenMax.to($('#my-chart-control'), 0, {
  autoAlpha: 0
});

$('#profile #chart-list').on('click', 'li', function(e) {
  var title = $(this).html();
  var value = $(this).attr('data-value');
  //console.log('clicked: ' + title + ', value: ' + value);
  $('#profile #chart-list li').removeClass('current');
  $(this).addClass('current');
  TweenMax.to($('#profile #chart-list li'), 0.6, {
    scale: 1,
    ease: Elastic.easeOut
  });
  TweenMax.to($('#profile #chart-list li.current'), 0.6, {
    scale: 1.1,
    ease: Elastic.easeOut
  });
  TweenMax.to($('#chart-logo'), 0.4, {
    autoAlpha: 0
  });
  TweenMax.to($('#chart-title'), 0.4, {
    y: '30px',
    autoAlpha: 0,
    delay: 0.2
  });
  TweenMax.to($('#chart-title'), 0, {
    text: {
      value: value + ' ' + profile_hours
    },
    delay: 0.6
  });
  TweenMax.to($('#chart-title'), 0.4, {
    y: '0px',
    autoAlpha: 1,
    startAt: {
      y: '-30px',
      autoAlpha: 0
    },
    delay: 0.6
  });
  TweenMax.to($('#chart-value'), 0.4, {
    y: '30px',
    autoAlpha: 0
  });
  TweenMax.to($('#chart-value'), 0, {
    text: {
      value: title + '<hr><small>'+profile_per_month+'</small>'
    },
    delay: 0.4
  });
  TweenMax.to($('#chart-value'), 0.4, {
    y: '0px',
    autoAlpha: 1,
    startAt: {
      y: '-30px',
      autoAlpha: 0
    },
    delay: 0.4
  });
  if ($('#btn-edit').hasClass('active')) {
    $('.dial').val(value).trigger('change');
    TweenMax.to($('#btn-del'), 0.4, {
      autoAlpha: 1
    });
    TweenMax.to($('#my-chart-control'), 0.4, {
      autoAlpha: 1
    }); 
  }
  e.stopPropagation();
});
$('#chart-listall').on('click', 'li', function(e) {
  e.stopPropagation();
  console.log('length: '+$('#chart-listall li.active').length);
  if($(this).hasClass('active')) {
    var key = $(this).attr('data-key');
    var value = $(this).find('small').html();
    //$(this).removeClass('active').find('small').remove();
    updateProfileActivities(key,null);
  } else if($('#chart-listall li.active').length < 6) {
    var key = $(this).attr('data-key');
    var value = 20;
    //$(this).addClass('active').append('<small>'+value+' '+profile_hours+'</small>');
    updateProfileActivities(key,value);
  } else {
    $.alert({
      title: '',
      content: 'Max. 6 atividades',
      confirmButton: '<i class="material-icons">&#xE876;</i>',
      theme: 'material',
      backgroundDismiss: true
    });
    return;
  }

});
$('#btn-del').on('click', function(e) {
  e.stopPropagation();
  var i = $('#profile #chart-list li.current').index();
  $('#profile #chart-list li.current').remove();
  //$('#my-chart g').eq(i).remove();
  chartUpdate();
});
$('#my-chart-control').on('click', 'canvas', function(e) {
  e.stopPropagation();
});
$('body').on('click', function() {
  $('#profile #chart-list li').removeClass('current');
  TweenMax.to($('#profile #chart-list li'), 0.6, {
    scale: 1,
    ease: Elastic.easeOut
  });
  if(user_photo) {
    TweenMax.to($('#chart-logo'), 0.4, {
      autoAlpha: 1,
      delay: 0.4
    });
  }
  TweenMax.to($('#chart-title'), 0.4, {
    y: '30px',
    autoAlpha: 0,
    delay: 0.2
  });
  TweenMax.to($('#chart-title'), 0, {
    text: {
      value: user_totalhours + ' ' + profile_hours
    },
    delay: 0.6
  });
  TweenMax.to($('#chart-title'), 0.4, {
    y: '0px',
    autoAlpha: 1,
    startAt: {
      y: '-30px',
      autoAlpha: 0
    },
    delay: 0.6
  });
  TweenMax.to($('#chart-value'), 0.4, {
    y: '30px',
    autoAlpha: 0
  });
  TweenMax.to($('#chart-value'), 0, {
    text: {
      value: user_name + '<hr><small>'+profile_per_month+'</small>'
    },
    delay: 0.4
  });
  TweenMax.to($('#chart-value'), 0.4, {
    y: '0px',
    autoAlpha: 1,
    startAt: {
      y: '-30px',
      autoAlpha: 0
    },
    delay: 0.4
  });
  TweenMax.to($('#btn-del'), 0, {
    autoAlpha: 0
  });
  TweenMax.to($('#my-chart-control'), 0.4, {
    autoAlpha: 0
  });
});

$(".dial").val(28).knob({
  'displayInput': false,
  /*'lineCap':'round',*/
  'height': '96%',
  'width': '96%',
  'thickness': 0.02,
  'bgColor': '#fcfcfc',
  'fgColor': '#e5e5e5',
  'min': 0,
  'max': 160,
  'change': function(v) {
    chartUpdate(Math.round(v));
  },
  'release' : function (v) {
    //chartUpdate(Math.round(v));
    updateProfileActivities($('#profile #chart-list li.current').attr('data-key'),Math.round(v));
  }
});
function userTotalHours() {
  var values = new Array();
  var valuestotal = 0;
  $('#profile #chart-list li.active').each(function() {
    values.push(Number($(this).attr('data-value')));
    valuestotal += parseInt($(this).attr('data-value'), 10);
  });
  user_totalhours = valuestotal;
}

function chartUpdate(v) {
  if (v) {
    $('#chart-title').html(Math.round(v) + ' ' + profile_hours);
    $('#profile #chart-list li.current').attr('data-value', Math.round(v));
  }
  var values = new Array();
  var valuestotal = 0;
  $('#profile #chart-list li.active').each(function() {
    values.push(Number($(this).attr('data-value')));
    valuestotal += parseInt($(this).attr('data-value'), 10);
  });
  user_totalhours = valuestotal;
  //userTotalHours();
  //console.log('values: '+values+', total: '+valuestotal);
  var i = 0;
  $('#my-chart g text').each(function() {
    i++;
    var newval = Math.round(values[i - 1] / valuestotal * 100);
    $(this).html(newval + '%');
  });
  Pizza.init(document.body, {
    data: values
  });
  /*if(!v) {
    $('#my-chart g').last().remove();
    $('body').click();
  }*/
}

function updateProfileActivities(key,value) {
  console.log('updateProfileActivities key: '+key+', value: '+value);
  var updates = {};
  updates[key] = value;
  firebase.database().ref('/users/' + user_id + '/profile_activities').update(updates);
}

$('#menu-chart-list').niceScroll({
  cursorborderradius: 0,
  cursorwidth: 2,
  cursorcolor: '#888',
  cursorborder: '10px solid transparent',
  railalign: 'right',
  autohidemode: false,
  horizrailenabled: false,
  zindex: 99
});