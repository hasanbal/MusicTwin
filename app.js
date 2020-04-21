
const axios = require("axios");
var path = require('path');

var express = require('express'); // Express web server framework
var request = require('request'); // "Request" library
var cors = require('cors');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');

var client_id = ''; // Your client id
var client_secret = ''; // Your secret
//var redirect_uri = 'https://musictwinfinder.herokuapp.com/callback/'; // Your redirect uri

// Your web app's Firebase configuration
var firebase = require("firebase");
var firebaseConfig = {

};
// Initialize Firebase
firebase.initializeApp(firebaseConfig);
var ref = firebase.database().ref("Users");
var refLog = firebase.database().ref("Log");


/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
var generateRandomString = function(length) {
  var text = '';
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

var stateKey = 'spotify_auth_state';

var app = express();

app.use(express.static(__dirname + '/public'))
   .use(cors())
   .use(cookieParser());


app.set("view engine", "ejs");
app.set('views', path.join(__dirname, '/public'));
app.use(express.static(__dirname + '/public/assets'));

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

app.get('/login', function(req, res) {
  var redirect_uri = 'https://' + req.get('host') + "/callback/";
  var state = generateRandomString(16);
  res.cookie(stateKey, state);

  // your application requests authorization
  var scope = 'user-read-private user-read-email';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});

app.get('/', function(req,res){
  res.render("index");
});
async function get_tracks(id, access_token){
    var trackss = [];
    var options = {
      method: 'GET',
      url: 'https://api.spotify.com/v1/playlists/'+id + '/tracks',
      headers: { 'Authorization': 'Bearer ' + access_token },
      json: true            
    };
    var res = await axios(options);
    await asyncForEach(res.data.items, async item=>{
      trackss.push(item.track.id);
    });

    return trackss;
}

async function binary_search(arr, x) { 
   
    let start=0, end=arr.length-1; 

    while (start<=end){ 
        let mid=Math.floor((start + end)/2); 
   
        if (arr[mid]===x) return true; 
  
        else if (arr[mid] < x)  
             start = mid + 1; 
        else
             end = mid - 1; 
    } 
   
    return false; 
}


async function calculate_score(list1, list2){
  var score=0;
  for(var track in list1){
    var check = list2.indexOf(list1[track]);
    if(check != -1){
      score += 1;
    }
  }
  return Math.round((1000*score)/list2.length);
}



app.get('/callback', function(req, res) {
  var redirect_uri = 'https://' + req.get('host') + "/callback/";

  var code = req.query.code || null;
  var state = req.query.state || null;
  var storedState = req.cookies ? req.cookies[stateKey] : null;

  if (state === null || state !== storedState) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  } else {
    res.clearCookie(stateKey);
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
      },
      json: true
    };

    request.post(authOptions, function(error, response, body) {
      if (!error && response.statusCode === 200) {

        var access_token = body.access_token,
            refresh_token = body.refresh_token;

        var playlists = [];
        var user_id = "";
        var display_name = "";
        var tracks = [];

        var MusicTwin = {"id":null, "display_name":null, "score":-1};

        var options = {
          url: 'https://api.spotify.com/v1/me',
          headers: { 'Authorization': 'Bearer ' + access_token },
          json: true
        };

        request.get(options, function(error, response, body) {

          user_id = body.id;
          display_name = body.display_name;

          var options = {
            url: 'https://api.spotify.com/v1/users/'+body.id+'/playlists',
            headers: { 'Authorization': 'Bearer ' + access_token },
            json: true
          };
          request.get(options, async function(error, response, body){
            await asyncForEach(body.items, async playlist => {
              var owner = 0;
              if(playlist.owner.id == user_id)
                owner = 1;

              playlists.push({"name":playlist.name,
                            "count":playlist.tracks.total,
                            "id": playlist.id,
                            "owner":owner});


              var temp = await get_tracks(playlist.id, access_token);
              tracks.push.apply(tracks, temp);
              console.log(playlist.name);
            });

            //TODO: add firebase
            tracks.sort();
            tracks = tracks.filter((x, i, a) => a.indexOf(x) == i);

            ref.child(user_id).child("Tracks").set(tracks);
            ref.child(user_id).update({"display_name":display_name});
            ref.child(user_id).child("config").update({
              "access_token":access_token,
              "refresh_token":refresh_token,
              "id":user_id,
              "display_name":display_name
            });


            var snapshot = await ref.once("value");

            var data = snapshot.val();
            for(var _user in data){
              if(_user == user_id)
                continue;
              
              var score = await calculate_score(tracks , data[_user]["Tracks"]);

              if(score > MusicTwin.score){
                MusicTwin.score = score;
                MusicTwin.id = _user;
                MusicTwin.display_name = data[_user]["display_name"];
              }

            }
            refLog.push({
              "twin1id":user_id,
              "twin2id":MusicTwin.id,
              "score":MusicTwin.score,
              "twin1display":display_name,
              "twin2display":MusicTwin.display_name
            });

            var frontendData = {
              "playlists":playlists,
              "display_name":display_name,
              "id":user_id,
              "MusicTwin" : MusicTwin
            };
            console.log("Frontend Data");
            console.log(frontendData);
            res.render("result",{data:frontendData});

          });
        });

        // we can also pass the token to the browser to make requests from there
        // res.redirect('/#' +
        //   querystring.stringify({
        //     access_token: access_token,
        //     refresh_token: refresh_token
        //   }));
      }
      //  else {
      //   res.redirect('/#' +
      //     querystring.stringify({
      //       error: 'invalid_token'
      //     }));
      // }
    });
  }

});

app.get('/refresh_token', function(req, res) {

  // requesting access token from refresh token
  var refresh_token = req.query.refresh_token;
  var authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: { 'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64')) },
    form: {
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    },
    json: true
  };

  request.post(authOptions, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      var access_token = body.access_token;
      res.send({
        'access_token': access_token
      });
    }
  });
});

if(process.env.PORT == null){
    app.listen(8888,function(){
        console.log("Connected");
    });
}else{
    app.listen(process.env.PORT, "0.0.0.0",function(){
        console.log("Connected");
    });
}