import { DefaultProfileArgs } from 'src/types'

export default function profileGif({
  ffmpegSession,
  filters,
}: DefaultProfileArgs) {
  // High quality gif: https://engineering.giphy.com/how-to-make-gifs-with-ffmpeg/
  filters = [
    filters,
    `split [a][b]`,
    `[a] palettegen [p]`,
    `[b][p] paletteuse`,
  ].join(`,`)

  return ffmpegSession
    .videoCodec(`gif`)
    .complexFilter([filters])
    .noAudio()
}
