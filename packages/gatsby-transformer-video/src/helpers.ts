import { FfprobeData } from 'fluent-ffmpeg'
import { ensureDir } from 'fs-extra'
import { NodePluginArgs } from 'gatsby'
import { fetchRemoteFile, IFetchRemoteFileOptions } from 'gatsby-core-utils'
import { arch, platform } from 'os'
import PQueue from 'p-queue'
import { parse, resolve } from 'path'

import { analyzeAndFetchVideo, executeFfprobe } from './ffmpeg'
import {
  ConvertVideoResult,
  DefaultTransformerFieldArgs,
  VideoNode,
  WrongFileTypeError,
} from './types'

interface processResultHelpers
  extends Pick<NodePluginArgs, 'store' | 'reporter'> {}

// Analyze the resulting video and prepare field return values
export async function processResult(
  { publicPath }: ConvertVideoResult,
  { store, reporter }: processResultHelpers
) {
  const program = store.getState().program
  const rootDir = program.directory

  try {
    const result: FfprobeData = await executeFfprobe(publicPath)

    const {
      format_name: formatName,
      format_long_name: formatLongName,
      start_time: startTime,
      duration: duration,
      size: size,
      bit_rate: bitRate,
    } = result.format

    const { width, height } = result.streams[0]
    const aspectRatio = (width || 1) / (height || 1)

    const path = publicPath.replace(resolve(rootDir, `public`), ``)

    const { name, ext } = parse(publicPath)

    return {
      path,
      absolutePath: publicPath,
      name,
      ext,
      formatName,
      formatLongName,
      startTime: startTime || null,
      duration: duration || null,
      size: size || null,
      bitRate: bitRate || null,
      width,
      height,
      aspectRatio,
    }
  } catch (err) {
    reporter.error(`Unable to analyze video file: ${publicPath}`)
    throw err
  }
}

interface prepareAndAnalyzeVideoArgs
  extends Pick<NodePluginArgs, 'store' | 'reporter' | 'cache'> {
  video: VideoNode
  fieldArgs: DefaultTransformerFieldArgs
}

// Get source videos metadata and download the file if required
export async function prepareAndAnalyzeVideo({
  video,
  fieldArgs,
  store,
  reporter,
  cache,
}: prepareAndAnalyzeVideoArgs) {
  const program = store.getState().program
  const rootDir = program.directory
  const { type } = video.internal

  let fileType = null
  if (type === `File`) {
    fileType = video.internal.mediaType
  }

  if (type === `ContentfulAsset`) {
    fileType = video.file.contentType
  }

  if (!fileType) {
    throw new Error(
      `Unable to extract asset file type for ${type} (${video.id})`
    )
  }

  if (fileType.indexOf(`video/`) === -1) {
    throw new WrongFileTypeError()
  }

  const metadata = await analyzeAndFetchVideo({
    video,
    fieldArgs,
    type,
    reporter,
    cache,
  })

  if (!metadata) {
    throw new Error(
      `Unable to read metadata from:\n\n${JSON.stringify(video, null, 2)}`
    )
  }

  const { path, filename: name, info } = metadata
  const publicDir = resolve(rootDir, `public`, fieldArgs.publicPath)

  await ensureDir(publicDir)

  return {
    publicDir,
    path,
    name,
    info,
  }
}

interface GenerateTaskLabelArgs<T extends DefaultTransformerFieldArgs> {
  video: VideoNode
  profileName: string
}

export function generateTaskLabel({
  video,
  profileName,
}: GenerateTaskLabelArgs<DefaultTransformerFieldArgs>) {
  const { base, file, contentful_id, id } = video

  const label = `Video ${base || file.fileName}:${contentful_id ||
    id} (${profileName})`

  return label
}

const DEFAULT_BIN = resolve(`.bin`, `gatsby-transformer-video`)
export function getCacheDirs({
  cacheDirectory = `.cache-video`,
  cacheDirectoryBin = DEFAULT_BIN,
}) {
  const cachePathBin = resolve(cacheDirectoryBin, `${platform()}-${arch()}`)
  const cachePathActive = resolve(cacheDirectory)
  const cachePathRolling = resolve(`${cacheDirectory}-rolling`)

  return { cachePathBin, cachePathActive, cachePathRolling }
}

// Queue file for downloading till fetchRemoteFile supports queing
const queueDownload = new PQueue({
  concurrency: 3,
  intervalCap: 10,
  interval: 1000,
  carryoverConcurrencyCount: true,
})
export async function queueFetchRemoteFile(fetchData: IFetchRemoteFileOptions) {
  return queueDownload.add(() => fetchRemoteFile(fetchData))
}
