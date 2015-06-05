#!/usr/bin/env node

var player = require('chromecast-player')();
var opts = require('minimist')(process.argv.slice(2));
var chalk = require('chalk');
var keypress = require('keypress');
var ui = require('playerui')();
var circulate = require('array-loop');
var xtend = require('xtend');
var unformatTime = require('./utils/unformat-time');
var debug = require('debug')('castnow');
var debouncedSeeker = require('debounced-seeker');
var noop = function() {};

// plugins
var directories = require('./plugins/directories');
var localfile = require('./plugins/localfile');
var torrent = require('./plugins/torrent');
var youtubeplaylist = require('./plugins/youtubeplaylist');
var youtube = require('./plugins/youtube');
var transcode = require('./plugins/transcode');
var subtitles = require('./plugins/subtitles');

// if (opts.help) {
//   return console.log([
//     '',
//     'Usage: castnow [<media>, <media>, ...] [OPTIONS]',
//     '',
//     'Option                  Meaning',
//     '--tomp4                 Convert file to mp4 while playback',
//     '--device <name>         The name of the chromecast device that should be used',
//     '--address <ip>          The IP address of your chromecast device',
//     '--subtitles <path/url>  Path or URL to an SRT or VTT file',
//     '--myip <ip>             Your main IP address',
//     '--quiet               No output',
//     '--peerflix-* <value>    Pass options to peerflix',
//     '--ffmpeg-* <value>      Pass options to ffmpeg',
//     '--type <val>            Explicity set the mime-type (e.g. "video/mp4")',
//     '--bypass-srt-encoding   Disable automatic UTF8 encoding of SRT subtitles',
//     '--seek <value>          Seek to the specified time on start using the format hh:mm:ss or mm:ss',

//     '--help                  This help screen',
//     '',
//     'Player controls',
//     '',
//     'Key                     Meaning',
//     'space                   Toggle between play and pause',
//     'm                       Toggle between mute and unmute',
//     'up                      Volume Up',
//     'down                    Volume Down',
//     'left                    Seek backward',
//     'right                   Seek forward',
//     'n                       Next in playlist',
//     's                       Stop playback',
//     'quit                    Quit',
//     ''
//   ].join('\n'));
// }

var last = function(fn, l) {
  return function() {
    var args = Array.prototype.slice.call(arguments);
    args.push(l);
    l = fn.apply(null, args);
    return l;
  };
};

var ctrl = function(err, p, ctx) {

  if (err) {
    debug('player error: %o', err);
    console.log(chalk.red(err));
  }

  var playlist = ctx.options.playlist;
  var volume;

  ctx.once('closed', function() {
    console.log(chalk.red('lost connection'));
  });

  // get initial volume
  p.getVolume(function(err, status) {
    volume = status;
  });

  var seek = debouncedSeeker(function(offset) {
    if (offset === 0) return;
    var seconds = Math.max(0, (p.getPosition() / 1000) + offset);
    debug('seeking to %s', seconds);
    p.seek(seconds);
  }, 500);

  var updateTitle = function() {
    p.getStatus(function(err, status) {
      if (!status || !status.media ||
          !status.media.metadata ||
          !status.media.metadata.title) return;

      var metadata = status.media.metadata;
      var title;
      if (metadata.artist) {
        title = metadata.artist + ' - ' + metadata.title;
      } else {
        title = metadata.title;
      }
      console.log(chalk.blue('Title: ' + title));
    });
  };

  var initialSeek = function() {
    var seconds = unformatTime(ctx.options.seek);
    debug('seeking to %s', seconds);
    p.seek(seconds);
  };

  p.on('playing', updateTitle);

  if (!ctx.options.disableSeek && ctx.options.seek) {
    p.once('playing', initialSeek);
  }

  updateTitle();

  var nextInPlaylist = function() {
    if (ctx.mode !== 'launch') return;
    if (!playlist.length) return process.exit();
    p.stop(function() {
      // ui.showLabels('state');
      debug('loading next in playlist: %o', playlist[0]);
      p.load(playlist[0], noop);
      playlist.shift();
    });
  };

  p.on('status', last(function(status, memo) {
    if (status.playerState !== 'IDLE') return;
    if (status.idleReason !== 'FINISHED') return;
    if (memo && memo.playerState === 'IDLE') return;
    nextInPlaylist();
    return status;
  }));

  return {
    // toggle between play / pause
    playPause: function() {
      if (p.currentSession.playerState === 'PLAYING') {
        p.pause();
      } else if (p.currentSession.playerState === 'PAUSED') {
        p.play();
      }
    },

    // play
    play: function() {
      if (p.currentSession.playerState === 'PAUSED') {
        p.play();
      }
    },

    // pause
    pause: function() {
      if (p.currentSession.playerState === 'PLAYING') {
        p.pause();
      }
    },

    // toggle between mute / unmute
    toggleMute: function() {
      if(!volume) { 
        return; 
      } else if (volume.muted) {
        p.unmute(function(err, status) {
          if (err) return;
          volume = status;
        });
      } else {
        p.mute(function(err, status) {
          if (err) return;
          volume = status;
        });
      }
    },

    // volume up
    volumeUp: function() {
      if (!volume || volume.level >= 1) return;
      p.setVolume(Math.min(volume.level + 0.05, 1), function(err, status) {
        if (err) return;
        volume = status;
      });
    },

    // volume down
    volumeDown: function() {
      if (!volume || volume.level <= 0) return;
      p.setVolume(Math.max(volume.level - 0.05, 0), function(err, status) {
        if (err) return;
        volume = status;
      });
    },

    // next item in playlist
    next: function() {
      nextInPlaylist();
    },

    // stop playback
    stop: function() {
      p.stop();
    },

    // quit
    quit: function() {
      // Try do something like quit
    },

    // Rewind, one "seekCount" per press
    seekLeft: function() {
      seek(-30);
    },

    // Forward, one "seekCount" per press
    seekRight: function() {
      seek(30);
    }
  };
};

player.use(directories);
player.use(torrent);
player.use(localfile);
player.use(youtubeplaylist);
player.use(youtube);
player.use(transcode);
player.use(subtitles);

// Play first item
player.use(function(ctx, next) {
  if (ctx.mode !== 'launch') return next();
  ctx.options = xtend(ctx.options, ctx.options.playlist[0]);
  ctx.options.playlist.shift();
  next();
});

module.exports = {
  setup: function(opts) {
    return {
      then: function(callback) {
        cb = function(err, p, ctx) {
          controller = ctrl(err, p, ctx);
          callback(controller);
        };

        if (!opts.playlist) {
          player.attach(opts, cb);
        } else {
          player.launch(opts, cb);
        }
      }
    };
  }
};