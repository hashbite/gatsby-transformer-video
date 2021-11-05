import { parse, resolve } from 'path'
import { performance } from 'perf_hooks'
import { tmpdir } from 'os'

import { createContentDigest } from 'gatsby-core-utils'
import { pathExists, stat, copy, ensureDir, remove, access } from 'fs-extra'
import ffmpeg, {
  FfmpegCommand,
  FfprobeStream,
  FfprobeData,
  ScreenshotsConfig,
} from 'fluent-ffmpeg'
import imagemin from 'imagemin'
import imageminGiflossy from 'imagemin-giflossy'
import imageminMozjpeg from 'imagemin-mozjpeg'
import PQueue from 'p-queue'
import sharp from 'sharp'
import { createFileNodeFromBuffer } from 'gatsby-source-filesystem'
import reporter from 'gatsby-cli/lib/reporter'

import { cacheContentfulVideo } from './helpers'

import profileH264 from './profiles/h264'
import profileH265 from './profiles/h265'
import profileVP9 from './profiles/vp9'
import profileWebP from './profiles/webp'
import profileGif from './profiles/gif'
import {
  DefaultTransformerFieldArgs,
  DefaultProfileArgs,
  VideoTransformerArgs,
  VideoNode,
  ConvertVideoArgs,
  ScreenshotTransformerFieldArgs,
  ScreenshotTransformerHelpers,
  H264TransformerFieldArgs,
  VP9TransformerFieldArgs,
  H265TransformerFieldArgs,
  VideoStreamMetadata,
  ConvertVideoResult,
} from './types'

export default class FFMPEG {
  queue: PQueue
  cacheDirOriginal: string
  cacheDirConverted: string
  rootDir: string
  profiles: unknown

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
    profiles: unknown
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

  // Execute FFPROBE and return metadata
  executeFfprobe = (path: string) =>
    new Promise((resolve, reject) => {
      ffmpeg(path).ffprobe((err, data) => {
        if (err) reject(err)
        resolve(data)
      })
    })

  // Execute FFMMPEG and log progress
  executeFfmpeg = async ({
    ffmpegSession,
    cachePath,
  }: {
    ffmpegSession: ffmpeg.FfmpegCommand
    cachePath: string
  }) => {
    let startTime: number
    let lastLoggedPercent = 0.1

    const { name } = parse(cachePath)

    return new Promise<void>((resolve, reject) => {
      ffmpegSession
        .on(`start`, (commandLine) => {
          reporter.info(`${name} - converting`)
          reporter.verbose(`${name} - executing:\n\n${commandLine}\n`)
          startTime = performance.now()
        })
        .on(`progress`, (progress) => {
          if (progress.percent > lastLoggedPercent + 10) {
            const percent = Math.floor(progress.percent)
            const elapsedTime = Math.ceil(
              (performance.now() - startTime) / 1000
            )
            const estTotalTime = (100 / percent) * elapsedTime
            const estTimeLeft = Math.ceil(estTotalTime - elapsedTime)
            const loggedTimeLeft =
              estTimeLeft !== Infinity && ` (~${estTimeLeft}s)`

            reporter.info(`${name} - ${percent}%${loggedTimeLeft}`)
            lastLoggedPercent = progress.percent
          }
        })
        .on(`error`, (err, stdout, stderr) => {
          reporter.info(`\n---\n${stdout}\n\n${stderr}\n---\n`)
          reporter.info(`${name} - An error occurred:`)
          console.error(err)
          reject(err)
        })
        .on(`end`, () => {
          reporter.info(`${name} - converted`)
          resolve()
        })
        .save(cachePath)
    })
  }

  // Analyze video and download if neccessary
  analyzeVideo = async ({
    video,
    fieldArgs,
    type,
  }: {
    video: VideoNode
    fieldArgs: DefaultTransformerFieldArgs
    type: string
  }) => {
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
        cacheDir: this.cacheDirOriginal,
      })
    }

    if (!path) {
      throw new Error(`Unable to locate video file for ${type} (${video.id})`)
    }

    const optionsHash = createContentDigest(fieldArgs)

    const filename = `${optionsHash}-${contentDigest}`

    const info = await this.executeFfprobe(path)

    return { path, filename, info }
  }

  // Queue video for conversion
  // @stephan
  queueConvertVideo = async <T extends DefaultTransformerFieldArgs>(
    videoConversionData: ConvertVideoArgs<T>
  ) => this.queue.add(() => this.convertVideo(videoConversionData))

  // Converts a video based on a given profile, populates cache and public dir
  convertVideo = async <T extends DefaultTransformerFieldArgs>({
    profile,
    sourcePath,
    cachePath,
    publicPath,
    fieldArgs,
    info,
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
      await this.executeFfmpeg({ ffmpegSession, cachePath })
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
    }: ScreenshotTransformerHelpers
  ) => {
    const { type } = video.internal
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
        reporter.verbose(`Returning cached screenshots`)
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
              `${name} - Taking ${filenames.length} ${width}px screenshots`
            )
          })
          .on(`error`, (err, stdout, stderr) => {
            reporter.info(`${name} - Failed to take ${width}px screenshots:`)
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
        reporter.info(`${name} - failed to take screenshots:`)
        console.error(err)
        throw err
      }
    }

    // Cleanup
    await remove(tmpDir)

    // Store to cache
    const screenshotIds = screenshotNodes.map(({ id }) => id)
    await cache.set(cacheKey, screenshotIds)

    return screenshotNodes
  }

  // Transformer:
  // createFromProfile = async ({
  //   publicDir,
  //   path,
  //   name,
  //   fieldArgs,
  //   info,
  // }: VideoTransformerArgs<any>) => {
  //   const profileName = fieldArgs.profile
  //   const profile = this.profiles[profileName]

  //   if (!profile) {
  //     throw new Error(`Unable to locate FFMPEG profile ${profileName}`)
  //   }

  //   if (!profile.extension) {
  //     throw new Error(
  //       `FFMPEG profile ${profileName} has no extension specified`
  //     )
  //   }

  //   if (!profile.converter) {
  //     throw new Error(
  //       `FFMPEG profile ${profileName} has no converter function specified`
  //     )
  //   }

  //   const filename = `${name}-${profileName}.${profile.extension}`
  //   const cachePath = resolve(this.cacheDirConverted, filename)
  //   const publicPath = resolve(publicDir, filename)

  //   return this.queueConvertVideo({
  //     profile: profile.converter,
  //     sourcePath: path,
  //     cachePath,
  //     publicPath,
  //     fieldArgs,
  //     info,
  //   })
  // }

  createH264 = async ({
    publicDir,
    path,
    name,
    fieldArgs,
    info,
  }: VideoTransformerArgs<H264TransformerFieldArgs>) => {
    const filename = `${name}-h264.mp4`
    const cachePath = resolve(this.cacheDirConverted, filename)
    const publicPath = resolve(publicDir, filename)

    return this.queueConvertVideo({
      profile: profileH264,
      sourcePath: path,
      cachePath,
      publicPath,
      fieldArgs,
      info,
    })
  }

  createH265 = async ({
    publicDir,
    path,
    name,
    fieldArgs,
    info,
  }: VideoTransformerArgs<H265TransformerFieldArgs>) => {
    const filename = `${name}-h265.mp4`
    const cachePath = resolve(this.cacheDirConverted, filename)
    const publicPath = resolve(publicDir, filename)

    return this.queueConvertVideo({
      profile: profileH265,
      sourcePath: path,
      cachePath,
      publicPath,
      fieldArgs,
      info,
    })
  }

  createVP9 = async ({
    publicDir,
    path,
    name,
    fieldArgs,
    info,
  }: VideoTransformerArgs<VP9TransformerFieldArgs>) => {
    const filename = `${name}-vp9.webm`
    const cachePath = resolve(this.cacheDirConverted, filename)
    const publicPath = resolve(publicDir, filename)

    return this.queueConvertVideo({
      profile: profileVP9,
      sourcePath: path,
      cachePath,
      publicPath,
      fieldArgs,
      info,
    })
  }

  createWebP = async ({
    publicDir,
    path,
    name,
    fieldArgs,
    info,
  }: VideoTransformerArgs<DefaultTransformerFieldArgs>) => {
    const filename = `${name}-webp.webp`
    const cachePath = resolve(this.cacheDirConverted, filename)
    const publicPath = resolve(publicDir, filename)

    return this.queueConvertVideo({
      profile: profileWebP,
      sourcePath: path,
      cachePath,
      publicPath,
      fieldArgs,
      info,
    })
  }

  createGif = async ({
    publicDir,
    path,
    name,
    fieldArgs,
    info,
  }: VideoTransformerArgs<DefaultTransformerFieldArgs>) => {
    const filename = `${name}-gif.gif`
    const cachePath = resolve(this.cacheDirConverted, filename)
    const publicPath = resolve(publicDir, filename)

    const absolutePath = await this.queueConvertVideo({
      profile: profileGif,
      sourcePath: path,
      cachePath,
      publicPath,
      fieldArgs,
      info,
    })

    await imagemin([publicPath], {
      destination: publicDir,
      plugins: [
        imageminGiflossy({
          optimizationLevel: 3,
          lossy: 120,
          noLogicalScreen: true,
          optimize: `3`,
        }),
      ],
    })

    return absolutePath
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
    const filters = []
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
