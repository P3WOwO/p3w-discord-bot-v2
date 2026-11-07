const { DisTube } = require('distube');
const { YouTubePlugin } = require('@distube/youtube');
const { SpotifyPlugin } = require('@distube/spotify');
const { SoundCloudPlugin } = require('@distube/soundcloud');

function createMusic(client) {
  const ffmpegPath = require('ffmpeg-static');

  return new DisTube(client, {
    // Searches plain text on YouTube, while provider URLs are resolved by their own plugins.
    plugins: [
      new YouTubePlugin(),
      new SoundCloudPlugin(),
      new SpotifyPlugin(),
    ],
    emitNewSongOnly: true,
    ffmpeg: {
      path: ffmpegPath || 'ffmpeg',
    },
  });
}

module.exports = { createMusic };
