import ffmpeg, {
  FfmpegCommand,
  FfprobeData,
  FfprobeStream,
  ScreenshotsConfig,
} from 'fluent-ffmpeg'
import { access, copy, ensureDir, pathExists, remove, stat } from 'fs-extra'
import { NodePluginArgs } from 'gatsby'
import { createContentDigest } from 'gatsby-core-utils'
import { createFileNodeFromBuffer } from 'gatsby-source-filesystem'
import imagemin from 'imagemin'
import imageminMozjpeg from 'imagemin-mozjpeg'
import { tmpdir } from 'os'
import PQueue from 'p-queue'
import { parse, resolve } from 'path'
import { performance } from 'perf_hooks'
import sharp from 'sharp'

import { cacheContentfulVideo, generateTaskLabel } from './helpers'
import {
  ConvertVideoArgs,
  ConvertVideoResult,
  DefaultTransformerFieldArgs,
  ProfileConfig,
  ScreenshotTransformerFieldArgs,
  ScreenshotTransformerHelpers,
  VideoNode,
  VideoStreamMetadata,
} from './types'

// Execute FFPROBE and return metadata
export const executeFfprobe = (path: string): Promise<FfprobeData> =>
  new Promise((resolve, reject) => {
    ffmpeg(path).ffprobe((err, data) => {
      if (err) reject(err)
      resolve(data)
    })
  })
interface ExecuteFfmpegArgs extends Pick<NodePluginArgs, 'reporter'> {
  ffmpegSession: ffmpeg.FfmpegCommand
  cachePath: string
  video: VideoNode
  profileName: string
}

// Execute FFMMPEG and log progress
export const executeFfmpeg = async ({
  ffmpegSession,
  cachePath,
  reporter,
  video,
  profileName,
}: ExecuteFfmpegArgs) => {
  let startTime: number
  let lastLoggedPercent = 0.1
  const label = generateTaskLabel({ video, profileName })

  return new Promise<void>((resolve, reject) => {
    ffmpegSession
      .on(`start`, (commandLine) => {
        reporter.info(`${label} - Executing:\n\n${commandLine}\n`)
        startTime = performance.now()
      })
      .on(`progress`, (progress) => {
        if (progress.percent > lastLoggedPercent + 10) {
          const percent = Math.floor(progress.percent)
          const elapsedTime = Math.ceil((performance.now() - startTime) / 1000)
          const estTotalTime = (100 / percent) * elapsedTime
          const estTimeLeft = Math.ceil(estTotalTime - elapsedTime)
          const loggedTimeLeft =
            estTimeLeft !== Infinity && ` (~${estTimeLeft}s)`

          reporter.info(`${label} - ${percent}%${loggedTimeLeft}`)
          lastLoggedPercent = progress.percent
        }
      })
      .on(`error`, (err, stdout, stderr) => {
        reporter.info(`\n---\n${stdout}\n\n${stderr}\n---\n`)
        reporter.info(`${label} - An error occurred:`)
        console.error(err)
        reject(err)
      })
      .on(`end`, () => {
        reporter.info(`${label} - Conversion finished`)
        resolve()
      })
      .save(cachePath)
  })
}

// Analyze video and download if neccessary
interface AnalyzeVideoArgs extends Pick<NodePluginArgs, 'reporter'> {
  video: VideoNode
  fieldArgs: DefaultTransformerFieldArgs
  type: string
  cacheDirOriginal: string
}

export const analyzeVideo = async ({
  video,
  fieldArgs,
  type,
  cacheDirOriginal,
  reporter,
}: AnalyzeVideoArgs) => {
  let path
  let contentDigest = video.internal.contentDigest

  if (type === `File`) {
    path = video.absolutePath
  }

  if (type === `ContentfulAsset`) {
    contentDigest = createContentDigest([
      video.contentful_id,
      video.file.url,
      video.file.details.size,
    ])
    path = await cacheContentfulVideo({
      video,
      contentDigest,
      cacheDir: cacheDirOriginal,
      reporter,
    })
  }

  if (!path) {
    throw new Error(`Unable to locate video file for ${type} (${video.id})`)
  }

  const optionsHash = createContentDigest(fieldArgs)

  const filename = `${optionsHash}-${contentDigest}`

  const info = await executeFfprobe(path)

  return { path, filename, info }
}
export default class FFMPEG {
  queue: PQueue
  cacheDirOriginal: string
  cacheDirConverted: string
  rootDir: string
  profiles: Record<string, ProfileConfig<DefaultTransformerFieldArgs>>

  constructor({
    rootDir,
    cacheDirOriginal,
    cacheDirConverted,
    ffmpegPath,
    ffprobePath,
    profiles,
  }: {
    cacheDirOriginal: string
    cacheDirConverted: string
    rootDir: string
    profiles: Record<string, ProfileConfig<DefaultTransformerFieldArgs>>
    ffmpegPath: string
    ffprobePath: string
  }) {
    this.queue = new PQueue({ concurrency: 1 })
    this.cacheDirOriginal = cacheDirOriginal
    this.cacheDirConverted = cacheDirConverted
    this.rootDir = rootDir
    this.profiles = profiles

    if (ffmpegPath) {
      ffmpeg.setFfmpegPath(ffmpegPath)
    }
    if (ffprobePath) {
      ffmpeg.setFfprobePath(ffprobePath)
    }
  }

  // Queue video for conversion
  queueConvertVideo = async <T extends DefaultTransformerFieldArgs>(
    videoConversionData: ConvertVideoArgs<T>
  ) => this.queue.add(() => this.convertVideo(videoConversionData))

  // Converts a video based on a given profile, populates cache and public dir
  convertVideo = async <T extends DefaultTransformerFieldArgs>({
    profile,
    profileName,
    sourcePath,
    cachePath,
    publicPath,
    fieldArgs,
    info,
    reporter,
    video,
  }: ConvertVideoArgs<T>): Promise<ConvertVideoResult> => {
    const alreadyExists = await pathExists(cachePath)

    if (!alreadyExists) {
      const ffmpegSession: FfmpegCommand = ffmpeg().input(sourcePath)
      const filters = this.createFilters({
        fieldArgs,
        info,
      })
      const videoStreamMetadata = this.parseVideoStream(info.streams)

      profile({
        ffmpegSession,
        filters,
        fieldArgs,
        videoStreamMetadata,
      })

      this.enhanceFfmpegForFilters({ ffmpegSession, fieldArgs })
      await executeFfmpeg({
        ffmpegSession,
        cachePath,
        reporter,
        video,
        profileName,
      })
    }

    // If public file does not exist, copy cached file
    const publicExists = await pathExists(publicPath)

    if (!publicExists) {
      await copy(cachePath, publicPath)
    }

    // Check if public and cache file vary in size
    const cacheFileStats = await stat(cachePath)
    const publicFileStats = await stat(publicPath)

    if (publicExists && cacheFileStats.size !== publicFileStats.size) {
      await copy(cachePath, publicPath, { overwrite: true })
    }

    return { publicPath }
  }

  // Queue take screenshots
  queueTakeScreenshots = (
    video: VideoNode,
    fieldArgs: ScreenshotTransformerFieldArgs,
    helpers: ScreenshotTransformerHelpers
  ) => this.queue.add(() => this.takeScreenshots(video, fieldArgs, helpers))

  takeScreenshots = async (
    video: VideoNode,
    fieldArgs: ScreenshotTransformerFieldArgs,
    {
      createNode,
      createNodeId,
      cache,
      getNode,
      store,
      reporter,
    }: ScreenshotTransformerHelpers
  ) => {
    const { type } = video.internal
    const label = generateTaskLabel({ video, profileName: 'Screenshots' })
    let contentDigest = video.internal.contentDigest

    let fileType = null
    if (type === `File`) {
      fileType = video.internal.mediaType
    }

    if (type === `ContentfulAsset`) {
      fileType = video.file.contentType
    }

    // Resolve videos only
    if (!fileType || fileType.indexOf(`video/`) === -1) {
      return null
    }

    let path: string

    if (type === `File`) {
      path = video.absolutePath
    }

    if (type === `ContentfulAsset`) {
      contentDigest = createContentDigest([
        video.contentful_id,
        video.file.url,
        video.file.details.size,
      ])
      path = await cacheContentfulVideo({
        video,
        contentDigest,
        cacheDir: this.cacheDirOriginal,
        reporter,
      })
    }

    const { timestamps, width } = fieldArgs
    const name = video.internal.contentDigest
    const tmpDir = resolve(tmpdir(), `gatsby-transformer-video`, name)
    const screenshotsConfig: ScreenshotsConfig = {
      timestamps,
      filename: `${contentDigest}-%ss.png`,
      folder: tmpDir,
      size: `${width}x?`,
    }

    // Restore from cache if possible
    const cacheKey = `screenshots-${createContentDigest(screenshotsConfig)}`
    const cachedScreenshotIds = await cache.get(cacheKey)

    if (Array.isArray(cachedScreenshotIds)) {
      const cachedScreenshots = cachedScreenshotIds.map((id) => getNode(id))

      if (cachedScreenshots.every((node) => typeof node !== 'undefined')) {
        return cachedScreenshots
      }
    }

    await ensureDir(tmpDir)

    const screenshotRawNames = await new Promise<string[]>(
      (resolve, reject) => {
        let paths: string[]
        ffmpeg(path)
          .on(`filenames`, function(filenames) {
            paths = filenames
            reporter.info(
              `${label} - Taking ${filenames.length} ${width}px screenshots`
            )
          })
          .on(`error`, (err, stdout, stderr) => {
            reporter.info(`${label} - Failed to take ${width}px screenshots:`)
            console.error(err)
            reject(err)
          })
          .on(`end`, () => {
            resolve(paths)
          })
          .screenshots(screenshotsConfig)
      }
    )

    const screenshotNodes = []

    for (const screenshotRawName of screenshotRawNames) {
      try {
        const rawScreenshotPath = resolve(tmpDir, screenshotRawName)
        const { name } = parse(rawScreenshotPath)

        try {
          await access(rawScreenshotPath)
        } catch {
          reporter.warn(`Screenshot ${rawScreenshotPath} could not be found!`)
          continue
        }

        const jpgBuffer = await sharp(rawScreenshotPath)
          .jpeg({
            quality: 80,
            progressive: true,
          })
          .toBuffer()

        const optimizedBuffer = await imagemin.buffer(jpgBuffer, {
          plugins: [imageminMozjpeg()],
        })

        const node = await createFileNodeFromBuffer({
          ext: `.jpg`,
          name,
          buffer: optimizedBuffer,
          cache,
          store,
          createNode,
          createNodeId,
          parentNodeId: video.id,
        })

        screenshotNodes.push(node)
      } catch (err) {
        reporter.info(`${label} - Failed to take screenshots:`)
        console.error(err)
        throw err
      }
    }

    // Cleanup
    await remove(tmpDir)

    // Store to cache
    const screenshotIds = screenshotNodes.map(({ id }) => id)
    await cache.set(cacheKey, screenshotIds)

    reporter.info(
      `${label} - Took ${screenshotNodes.length} ${width}px screenshots`
    )

    return screenshotNodes
  }

  // Generate ffmpeg filters based on field args
  createFilters = <T extends DefaultTransformerFieldArgs>({
    fieldArgs,
    info,
  }: {
    fieldArgs: T
    info: FfprobeData
  }): string[] => {
    const {
      maxWidth,
      maxHeight,
      duration,
      fps,
      saturation,
      overlay,
      overlayX,
      overlayY,
      overlayPadding,
    } = fieldArgs
    const filters: string[] = []
    const { duration: sourceDuration } = info.streams[0]

    if (duration && sourceDuration) {
      filters.push(
        `setpts=${(duration / parseInt(sourceDuration)).toFixed(6)}*PTS`
      )
    }

    if (fps) {
      filters.push(`fps=${fps}`)
    }

    if (maxWidth || maxHeight) {
      filters.push(
        `scale=${this.generateScaleFilter({
          maxWidth,
          maxHeight,
        })}`
      )
    }

    if (saturation !== 1) {
      filters.push(`eq=saturation=${saturation}`)
    }

    if (overlay) {
      const padding = overlayPadding === undefined ? 10 : overlayPadding
      let x = overlayX === undefined ? `center` : overlayX
      let y = overlayY === undefined ? `center` : overlayY

      if (x === `start`) {
        x = padding.toString()
      }
      if (x === `center`) {
        x = `(main_w-overlay_w)/2`
      }
      if (x === `end`) {
        x = `main_w-overlay_w-${padding}`
      }

      if (y === `start`) {
        y = padding.toString()
      }
      if (y === `center`) {
        y = `(main_h-overlay_h)/2`
      }
      if (y === `end`) {
        y = `main_h-overlay_h-${padding}`
      }

      filters.push(`overlay=x=${x}:y=${y}`)
    }

    return filters
  }

  // Apply required changes from some filters to the fluent-ffmpeg session
  enhanceFfmpegForFilters = <T extends DefaultTransformerFieldArgs>({
    fieldArgs: { overlay, duration },
    ffmpegSession,
  }: {
    fieldArgs: T
    ffmpegSession: FfmpegCommand
  }) => {
    if (duration) {
      ffmpegSession.duration(duration).noAudio()
    }
    if (overlay) {
      const path = resolve(this.rootDir, overlay)
      ffmpegSession.input(path)
    }
  }

  // Create scale filter based on given field args
  generateScaleFilter({
    maxWidth,
    maxHeight,
  }: {
    maxWidth: number
    maxHeight: number
  }) {
    if (!maxHeight) {
      return `'min(${maxWidth},iw)':-2:flags=lanczos`
    }
    return `'min(iw*min(1\\,min(${maxWidth}/iw\\,${maxHeight}/ih)), iw)':-2:flags=lanczos`
  }

  // Locates video stream and returns metadata
  parseVideoStream = (streams: FfprobeStream[]): VideoStreamMetadata => {
    const videoStream = streams.find((stream) => stream.codec_type === `video`)
    if (!videoStream?.r_frame_rate) {
      throw new Error('Could not parse video')
    }
    const currentFps = parseInt(videoStream.r_frame_rate.split(`/`)[0])
    return { videoStream, currentFps }
  }
}
