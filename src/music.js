const { DisTube } = require('distube');
const { YouTubePlugin } = require('@distube/youtube');
const { SpotifyPlugin } = require('@distube/spotify');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { YandexMusicPlugin } = require('distube-yandex-music-plugin');

function createMusic(client, config = {}) {
  const ffmpegPath = require('ffmpeg-static');

  // @distube/youtube 1.1.x uses the current @distube/ytdl-core 5.x engine.
  // The engine solves YouTube player signatures locally and mints PO tokens.
  const youtube = new YouTubePlugin({
    ytdlOptions: config.YT_COOKIE ? { cookie: config.YT_COOKIE } : {},
  });

  const plugins = [
    youtube,
    new SoundCloudPlugin(),
    new SpotifyPlugin(),
  ];

  // Yandex Music needs a real user token and UID, kept outside the repository.
  if (config.YANDEX_MUSIC_OAUTH_TOKEN && config.YANDEX_MUSIC_UID) {
    plugins.push(new YandexMusicPlugin({
      oauthToken: config.YANDEX_MUSIC_OAUTH_TOKEN,
      uid: config.YANDEX_MUSIC_UID,
    }));
    console.log('✅ Yandex Music source enabled');
  } else {
    console.log('ℹ️ Yandex Music source is installed but disabled: set YANDEX_MUSIC_OAUTH_TOKEN and YANDEX_MUSIC_UID');
  }

  return new DisTube(client, {
    plugins,
    emitNewSongOnly: true,
    ffmpeg: {
      path: ffmpegPath || 'ffmpeg',
    },
  });
}

module.exports = { createMusic };
