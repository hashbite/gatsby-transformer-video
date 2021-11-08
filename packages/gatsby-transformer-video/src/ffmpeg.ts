import ffmpeg, {
  FfmpegCommand,
  FfprobeData,
  FfprobeStream,
  ScreenshotsConfig,
} from 'fluent-ffmpeg'
import {
  copy,
  ensureDir,
  move,
  pathExists,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'fs-extra'
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

import { generateTaskLabel, queueFetchRemoteFile } from './helpers'
import {
  ConvertVideoArgs,
  ConvertVideoResult,
  DefaultTransformerFieldArgs,
  ProfileConfig,
  RestoreFromCacheArgs,
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
interface AnalyzeVideoArgs extends Pick<NodePluginArgs, 'reporter' | 'cache'> {
  video: VideoNode
  fieldArgs: DefaultTransformerFieldArgs
  type: string
}

export const analyzeAndFetchVideo = async ({
  video,
  fieldArgs,
  type,
  cache,
}: AnalyzeVideoArgs) => {
  let path
  let contentDigest = video.internal.contentDigest
  const { name } = parse(video.base || video.file.fileName)

  if (type === `File`) {
    path = video.absolutePath
  }

  if (type === `ContentfulAsset`) {
    const { ext } = parse(video.file.fileName)

    path = await queueFetchRemoteFile({
      url: `https:${video.file.url}`,
      cache,
      ext,
    })

    contentDigest = createContentDigest([
      video.contentful_id,
      video.file.url,
      video.file.details.size,
    ])
  }

  if (!path) {
    throw new Error(`Unable to locate video file for ${type} (${video.id})`)
  }

  const optionsHash = createContentDigest(fieldArgs)

  const filename = `${name}-${contentDigest}-${optionsHash}`

  const info = await executeFfprobe(path)

  return { path, filename, info }
}
export default class FFMPEG {
  queue: PQueue
  cachePathBin: string
  cachePathActive: string
  cachePathRolling: string
  rootDir: string
  profiles: Record<string, ProfileConfig<DefaultTransformerFieldArgs>>

  constructor({
    rootDir,
    cachePathBin,
    cachePathActive,
    cachePathRolling,
    ffmpegPath,
    ffprobePath,
    profiles,
  }: {
    rootDir: string
    cachePathBin: string
    cachePathActive: string
    cachePathRolling: string
    profiles: Record<string, ProfileConfig<DefaultTransformerFieldArgs>>
    ffmpegPath: string
    ffprobePath: string
  }) {
    this.queue = new PQueue({ concurrency: 1 })
    this.cachePathBin = cachePathBin
    this.cachePathActive = cachePathActive
    this.cachePathRolling = cachePathRolling
    this.rootDir = rootDir
    this.profiles = profiles

    if (ffmpegPath) {
      ffmpeg.setFfmpegPath(ffmpegPath)
    }
    if (ffprobePath) {
      ffmpeg.setFfprobePath(ffprobePath)
    }
  }

  // Restore file either from active or rolling cache directory
  restoreFromCache = async ({
    label,
    activePath,
    rollingPath,
    reporter,
  }: RestoreFromCacheArgs) => {
    const inActiveCache = await pathExists(activePath)

    if (!inActiveCache) {
      const inRollingCached = await pathExists(rollingPath)
      if (inRollingCached) {
        await move(rollingPath, activePath)
        reporter.info(`${label} - Restored from rolling cache`)
        return true
      }
    }
    return inActiveCache
  }

  // Queue video for conversion
  queueConvertVideo = async <T extends DefaultTransformerFieldArgs>(
    videoConversionData: ConvertVideoArgs<T>
  ) => this.queue.add(() => this.convertVideo(videoConversionData))

  // Converts a video based on a given profile, populates cache and public dir
  convertVideo = async <T extends DefaultTransformerFieldArgs>({
    profile,
    profileName,
    filename,
    sourcePath,
    publicDir,
    fieldArgs,
    info,
    reporter,
    video,
  }: ConvertVideoArgs<T>): Promise<ConvertVideoResult> => {
    const { cachePathActive, cachePathRolling } = this
    const label = generateTaskLabel({ video, profileName })
    const activePath = resolve(cachePathActive, 'videos', filename)
    const rollingPath = resolve(cachePathRolling, 'videos', filename)

    const restoredFromCache = await this.restoreFromCache({
      label,
      activePath,
      rollingPath,
      reporter,
    })

    if (!restoredFromCache) {
      const cachePath = activePath
      const { dir } = parse(activePath)
      await ensureDir(dir)
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
    const publicPath = resolve(publicDir, 'videos', filename)
    const publicExists = await pathExists(publicPath)

    if (!publicExists) {
      await copy(activePath, publicPath)
    }

    // Check if public and cache file vary in size
    const cacheFileStats = await stat(activePath)
    const publicFileStats = await stat(publicPath)

    if (publicExists && cacheFileStats.size !== publicFileStats.size) {
      await copy(activePath, publicPath, { overwrite: true })
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
      store,
      reporter,
    }: ScreenshotTransformerHelpers
  ) => {
    const { type } = video.internal
    const label = generateTaskLabel({ video, profileName: 'Screenshots' })
    let contentDigest = video.internal.contentDigest
    const { name: parentName } = parse(video.base || video.file.fileName)

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
      const { ext } = parse(video.file.fileName)

      path = await queueFetchRemoteFile({
        url: `https:${video.file.url}`,
        cache,
        ext,
      })

      contentDigest = createContentDigest([
        video.contentful_id,
        video.file.url,
        video.file.details.size,
      ])
    }

    const { timestamps, width } = fieldArgs
    const screenshotsOptions = {
      timestamps,
      size: `${width}x?`,
    }
    const foldername = `${parentName}-${contentDigest}-${createContentDigest({
      screenshotsOptions,
    })}`
    let screenshotPaths

    const { cachePathActive, cachePathRolling } = this
    const activePath = resolve(cachePathActive, 'screenshots', foldername)
    const rollingPath = resolve(cachePathRolling, 'screenshots', foldername)

    try {
      await this.restoreFromCache({
        label,
        activePath,
        rollingPath,
        reporter,
      })

      const screenshotNames = await readdir(activePath)
      screenshotPaths = screenshotNames.map((name) => resolve(activePath, name))
    } catch (err) {
      const tmpDir = resolve(tmpdir(), 'gatsby-transformer-video', foldername)
      const screenshotsConfig: ScreenshotsConfig = {
        filename: `%ss.png`,
        folder: tmpDir,
        ...screenshotsOptions,
      }

      await ensureDir(tmpDir)

      // Take raw screenshots and store to tmpDir
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

      // process raw screenshots and store to cache
      screenshotPaths = []
      await ensureDir(activePath)
      for (const screenshotRawName of screenshotRawNames) {
        try {
          const screenshotRawPath = resolve(tmpDir, screenshotRawName)

          // Transform to progressive jpg
          const jpgBuffer = await sharp(screenshotRawPath)
            .jpeg({
              quality: 80,
              progressive: true,
            })
            .toBuffer()

          // Optimize with imagemin
          const optimizedBuffer = await imagemin.buffer(jpgBuffer, {
            plugins: [imageminMozjpeg()],
          })

          // Store to fs cache
          await ensureDir(this.cachePathActive)
          const { name } = parse(screenshotRawName)
          const cachePath = resolve(activePath, `${name}.jpg`)
          await writeFile(cachePath, optimizedBuffer)
          screenshotPaths.push(cachePath)
        } catch (err) {
          reporter.info(
            `${label} - Failed to process screenshot ${screenshotRawName}`
          )
          console.error(err)
          throw err
        }
      }
      reporter.info(
        `${label} - Took ${screenshotRawNames.length} ${width}px screenshots`
      )
    }

    // loop paths
    const screenshotNodes = []
    for (const screenshotPath of screenshotPaths) {
      const screenshotBuffer = await readFile(screenshotPath)
      const { name } = parse(screenshotPath)

      // read file to buffer screenshotPath
      const node = await createFileNodeFromBuffer({
        ext: `.jpg`,
        name,
        buffer: screenshotBuffer,
        cache,
        store,
        createNode,
        createNodeId,
        parentNodeId: video.id,
      })

      screenshotNodes.push(node)
    }

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
