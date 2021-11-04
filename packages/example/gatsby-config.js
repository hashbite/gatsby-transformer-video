module.exports = {
  flags: {
    PRESERVE_FILE_DOWNLOAD_CACHE: true,
    PRESERVE_WEBPACK_CACHE: true,
  },
  plugins: [
    {
      resolve: `gatsby-source-filesystem`,
      options: {
        name: `videos`,
        path: `./videos/`,
      },
    },
    {
      resolve: `gatsby-source-contentful`,
      options: {
        // This space is for testing purposes only.
        // Never store your Contentful credentials in your projects config file.
        // Use: https://www.gatsbyjs.com/docs/how-to/local-development/environment-variables/
        spaceId: `k8iqpp6u0ior`,
        accessToken: `hO_7N0bLaCJFbu5nL3QVekwNeB_TNtg6tOCB_9qzKUw`,
      },
    },
    {
      resolve: `gatsby-transformer-video`,
      options: {
        profiles: {
          sepia: {
            extension: `mp4`,
            converter: function({ ffmpegSession, videoStreamMetadata }) {
              const { currentFps } = videoStreamMetadata

              const outputOptions = [
                `-crf 31`,
                `-preset slow`,
                `-movflags +faststart`,
                `-profile:v high`,
                `-bf 2	`,
                `-g ${Math.floor(currentFps / 2)}`,
                `-coder 1`,
                `-pix_fmt yuv420p`,
              ].filter(Boolean)

              return ffmpegSession
                .videoCodec(`libx264`)
                .videoFilters(
                  `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131`
                )
                .outputOptions(outputOptions)
                .noAudio()
            },
          },
        },
      },
    },
    `gatsby-plugin-gatsby-cloud`,
  ],
}
