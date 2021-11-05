import { H265TransformerFieldArgs, Profile } from '../types'

export const profileH265: Profile<H265TransformerFieldArgs> = ({
  ffmpegSession,
  filters,
  fieldArgs,
  videoStreamMetadata,
}) => {
  const { crf, preset, maxRate, bufSize, fps } = fieldArgs
  const { currentFps } = videoStreamMetadata

  const outputOptions = [
    crf && `-crf ${crf}`,
    preset && `-preset ${preset}`,
    !crf &&
      maxRate &&
      bufSize &&
      `-x265-params vbv-maxrate=${maxRate}:vbv-bufsize=${bufSize}`,
    `-movflags +faststart`,
    `-bf 2`,
    `-g ${Math.floor((fps || currentFps) / 2)}`,
    `-pix_fmt yuv420p`,
    `-tag:v hvc1`,
  ]
    .filter(Boolean)
    .map((v) => v.toString())

  return (
    ffmpegSession
      .videoCodec(`libx265`)
      .complexFilter([filters.join()])
      .outputOptions(outputOptions)
      .audioCodec(`aac`)
      .audioQuality(5)
      // Apple devices support aac only with stereo
      .audioChannels(2)
  )
}
