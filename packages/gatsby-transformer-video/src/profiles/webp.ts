import { DefaultTransformerFieldArgs, Profile } from '../types'

export const profileWebP: Profile<DefaultTransformerFieldArgs> = ({
  filters,
  ffmpegSession,
}) => {
  const outputOptions = [
    `-preset picture`,
    `-compression_level 6`,
    `-loop 0`,
  ].filter(Boolean)

  return ffmpegSession
    .videoCodec(`libwebp`)
    .complexFilter([filters.join()])
    .outputOptions(outputOptions)
    .noAudio()
}
