import axios from 'axios'
import { FfprobeData } from 'fluent-ffmpeg'
import fs from 'fs'
import { access, ensureDir } from 'fs-extra'
import { NodePluginArgs } from 'gatsby'
import reporter from 'gatsby-cli/lib/reporter'
import PQueue from 'p-queue'
import { extname, parse, resolve } from 'path'

import { analyzeVideo, executeFfprobe } from './ffmpeg'
import {
  ConvertVideoResult,
  DefaultTransformerFieldArgs,
  VideoNode,
  WrongFileTypeError,
} from './types'

const downloadQueue = new PQueue({ concurrency: 3 })

const downloadCache = new Map()

// @todo we can use it now!

/**
 * Download and cache video from Contentful for further processing
 *
 * This is not using createRemoteFileNode of gatsby-source-filesystem because of:
 *
 * Retry is currently broken: https://github.com/gatsbyjs/gatsby/issues/22010
 * Downloaded files are not cached properly: https://github.com/gatsbyjs/gatsby/issues/8324 & https://github.com/gatsbyjs/gatsby/pull/8379
 */
export async function cacheContentfulVideo({
  video,
  cacheDir,
  contentDigest,
}: {
  video: VideoNode
  cacheDir: string
  contentDigest: string
}) {
  const {
    file: { url, fileName },
  } = video

  const path = resolve(cacheDir, `${contentDigest}.${extname(fileName)}`)

  try {
    await access(path, fs.constants.R_OK)
    reporter.verbose(`Cache hit: ${url}`)
    downloadCache.set(url, path)

    return path
  } catch {
    if (downloadCache.has(url)) {
      // Already in download queue
      return downloadCache.get(url)
    }

    async function queuedDownload() {
      let tries = 0
      let downloaded = false

      while (!downloaded) {
        try {
          await downloadQueue.add(async () => {
            reporter.info(`Downloading: ${url}`)

            const response = await axios({
              method: `get`,
              url: `https:${url}`,
              responseType: `stream`,
            })

            await new Promise((resolve, reject) => {
              const file = fs.createWriteStream(path)

              file.on(`finish`, resolve)
              file.on(`error`, reject)
              response.data.pipe(file)
            })

            downloaded = true
          })
        } catch (e) {
          tries++

          if (tries === 3) {
            throw new Error(
              `Download of ${url} failed after three times:\n\n${e}`
            )
          }
          reporter.info(
            `Unable to download ${url}\n\nRetrying again after 1s (${tries}/3)`
          )
          console.error(e)
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      reporter.info(`Downloaded: ${url}, returning path`)

      return path
    }

    const downloadPromise = queuedDownload()

    downloadCache.set(url, downloadPromise)

    return downloadPromise
  }
}

interface processResultHelpers extends Pick<NodePluginArgs, 'store'> {}

// Analyze the resulting video and prepare field return values
export async function processResult(
  { publicPath }: ConvertVideoResult,
  { store }: processResultHelpers
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

interface prepareAndAnalyzeVideoArgs extends Pick<NodePluginArgs, 'store'> {
  video: VideoNode
  fieldArgs: DefaultTransformerFieldArgs
  cacheDirOriginal: string
}

// Get source videos metadata and download the file if required
export async function prepareAndAnalyzeVideo({
  video,
  fieldArgs,
  store,
  cacheDirOriginal,
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

  const metadata = await analyzeVideo({
    video,
    fieldArgs,
    type,
    cacheDirOriginal,
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
