import { FfmpegCommand, FfprobeData, FfprobeStream } from 'fluent-ffmpeg'
import { Actions, NodePluginArgs } from 'gatsby'

export interface VideoStreamMetadata {
  videoStream: FfprobeStream
  currentFps: number
}

export type Profile<T extends DefaultTransformerFieldArgs> = (args: {
  fieldArgs: T
  ffmpegSession: FfmpegCommand
  filters: string[]
  videoStreamMetadata: VideoStreamMetadata
}) => FfmpegCommand

export interface ConvertVideoResult {
  publicPath: string
}

export type Transformer<T extends DefaultTransformerFieldArgs> = (
  args: VideoTransformerArgs<T>
) => Promise<ConvertVideoResult>

export interface ProfileConfig<T extends DefaultTransformerFieldArgs> {
  extension: string
  converter: Profile<T>
}
export interface ConvertVideoArgs<T extends DefaultTransformerFieldArgs> {
  profile: Profile<T>
  sourcePath: string
  cachePath: string
  publicPath: string
  fieldArgs: T
  info: FfprobeData
}

export interface VideoNode {
  internal: VideoNodeInternal
  id: string
  absolutePath: string
  file: VideoNodeContentfulFile
  contentful_id: string
}

interface VideoNodeInternal {
  type: `File` | `ContentfulAsset`
  contentDigest: string
  mediaType: string
}
interface VideoNodeContentfulFile {
  url: string
  fileName: string
  details: VideoNodeContentfulFileDetails
  contentType: string
}
interface VideoNodeContentfulFileDetails {
  size: string
}

export interface GatsbyTransformerVideoOptions {
  ffmpegPath: string
  ffprobePath: string
  downloadBinaries: boolean
  profiles: Record<string, ProfileConfig<DefaultTransformerFieldArgs>>
}

export interface VideoTransformerArgs<T extends DefaultTransformerFieldArgs> {
  publicDir: string
  path: string
  name: string
  fieldArgs: T
  info: FfprobeData
}

export interface DefaultTransformerFieldArgs {
  maxWidth: number
  maxHeight: number
  duration: number
  fps: number
  saturation: number
  overlay: string
  overlayX: string
  overlayY: string
  overlayPadding: number
  publicPath: string
}

export interface H264TransformerFieldArgs extends DefaultTransformerFieldArgs {
  crf: number
  preset: string
  maxRate: string
  bufSize: string
}

export interface H265TransformerFieldArgs extends DefaultTransformerFieldArgs {
  crf: number
  preset: string
  maxRate: string
  bufSize: string
}

export interface VP9TransformerFieldArgs extends DefaultTransformerFieldArgs {
  crf: number
  preset: string
  bitRate: string
  minRate: string
  maxRate: string
  bufSize: string
  cpuUsed: number
}

export interface ScreenshotTransformerHelpers
  extends Pick<Actions, 'createNode'>,
    Pick<
      NodePluginArgs,
      'cache' | 'getNode' | 'getCache' | 'createNodeId' | 'store'
    > {}

export interface ScreenshotTransformerFieldArgs {
  timestamps: string[]
  width: number
}
