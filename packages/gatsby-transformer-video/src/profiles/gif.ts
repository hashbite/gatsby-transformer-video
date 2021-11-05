import { DefaultTransformerFieldArgs, Profile } from '../types'

export const profileGif: Profile<DefaultTransformerFieldArgs> = ({
  filters,
  ffmpegSession,
}) => {
  // High quality gif: https://engineering.giphy.com/how-to-make-gifs-with-ffmpeg/
  filters = [
    ...filters,
    `split [a][b]`,
    `[a] palettegen [p]`,
    `[b][p] paletteuse`,
  ]

  return ffmpegSession
    .videoCodec(`gif`)
    .complexFilter([filters.join()])
    .noAudio()
}
