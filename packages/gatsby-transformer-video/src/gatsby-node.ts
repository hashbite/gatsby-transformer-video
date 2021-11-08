import { move, pathExists, remove } from 'fs-extra'
import {
  CreateResolversArgs,
  CreateSchemaCustomizationArgs,
  ParentSpanPluginArgs,
} from 'gatsby'
import { ObjectTypeComposerFieldConfigMapDefinition } from 'graphql-compose'
import imagemin from 'imagemin'
import imageminGiflossy from 'imagemin-giflossy'
import os from 'os'
import { resolve } from 'path'

import { downloadLibs, libsAlreadyDownloaded, libsInstalled } from './binaries'
import FFMPEG from './ffmpeg'
import { getCacheDirs, prepareAndAnalyzeVideo, processResult } from './helpers'
import { profileGif } from './profiles/gif'
import { profileH264 } from './profiles/h264'
import { profileH265 } from './profiles/h265'
import { profileVP9 } from './profiles/vp9'
import { profileWebP } from './profiles/webp'
import {
  DefaultTransformerFieldArgs,
  GatsbyTransformerVideoOptions,
  H264TransformerFieldArgs,
  H265TransformerFieldArgs,
  ScreenshotTransformerFieldArgs,
  Transformer,
  VideoNode,
  VideoTransformerArgs,
  VP9TransformerFieldArgs,
  WrongFileTypeError,
} from './types'

const platform = os.platform()

const DEFAULT_ARGS = {
  maxWidth: { type: 'Int', defaultValue: 1920 },
  maxHeight: { type: 'Int', defaultValue: null },
  duration: { type: 'Int', defaultValue: null },
  fps: { type: 'Int', defaultValue: null },
  saturation: { type: 'Float', defaultValue: 1 },
  overlay: { type: 'String', defaultValue: null },
  overlayX: { type: 'String', defaultValue: `center` },
  overlayY: { type: 'String', defaultValue: `center` },
  overlayPadding: { type: 'Int', defaultValue: 10 },
  publicPath: {
    type: 'String',
    defaultValue: `static/videos`,
  },
}

exports.createSchemaCustomization = ({
  actions,
  schema,
}: CreateSchemaCustomizationArgs) => {
  const { createTypes } = actions

  const typeDefs = [
    schema.buildObjectType({
      name: `GatsbyVideo`,
      fields: {
        path: { type: `String` },
        absolutePath: { type: `String` },
        name: { type: `String` },
        ext: { type: `String` },
        formatName: { type: `String` },
        formatLongName: { type: `String` },
        startTime: { type: `Float` },
        duration: { type: `Float` },
        size: { type: `Int` },
        bitRate: { type: `Int` },
        width: { type: `Int` },
        height: { type: `Int` },
        aspectRatio: { type: `Float` },
      },
    }),
  ]

  createTypes(typeDefs)
}

exports.createResolvers = async (
  {
    createResolvers,
    store,
    getCache,
    cache,
    createNodeId,
    getNode,
    reporter,
    actions: { createNode },
  }: CreateResolversArgs,
  {
    ffmpegPath,
    ffprobePath,
    downloadBinaries = true,
    profiles = {},
    cacheDirectory,
    cacheDirectoryBin,
  }: GatsbyTransformerVideoOptions
) => {
  const program = store.getState().program
  const rootDir = program.directory

  const alreadyInstalled = await libsInstalled()

  const { cachePathBin, cachePathActive, cachePathRolling } = getCacheDirs({
    cacheDirectory,
    cacheDirectoryBin,
  })

  // Support for PRESERVE_FILE_DOWNLOAD_CACHE flag
  cache.directory = resolve(
    rootDir,
    '.cache',
    'caches',
    'gatsby-source-filesystem'
  )

  // Set paths to our own binaries
  if (!alreadyInstalled && downloadBinaries && (!ffmpegPath || !ffprobePath)) {
    ffmpegPath = resolve(
      cachePathBin,
      `ffmpeg${platform === `win32` ? `.exe` : ``}`
    )
    ffprobePath = resolve(
      cachePathBin,
      `ffprobe${platform === `win32` ? `.exe` : ``}`
    )
  }

  const ffmpeg = new FFMPEG({
    rootDir,
    cachePathBin,
    cachePathActive,
    cachePathRolling,
    ffmpegPath,
    ffprobePath,
    profiles,
  })

  // Resolves a video with a given transformer & codec
  function resolveVideo<T extends DefaultTransformerFieldArgs>({
    transformer,
  }: {
    transformer: Transformer<T>
  }) {
    return async (video: VideoNode, fieldArgs: T) => {
      try {
        const { publicDir, path, name, info } = await prepareAndAnalyzeVideo({
          video,
          fieldArgs,
          store,
          reporter,
          cache,
        })

        const videoData = await transformer({
          video,
          publicDir,
          path,
          name,
          fieldArgs,
          info,
        })

        return await processResult(videoData, { store, reporter })
      } catch (err) {
        if (!(err instanceof WrongFileTypeError)) {
          throw err
        }

        return null
      }
    }
  }

  const videoFields: ObjectTypeComposerFieldConfigMapDefinition<any, any> = {
    videoH264: {
      type: `GatsbyVideo`,
      args: {
        ...DEFAULT_ARGS,
        crf: { type: 'Int', defaultValue: 28 },
        preset: { type: 'String', defaultValue: `medium` },
        maxRate: { type: 'String' },
        bufSize: { type: 'String' },
      },
      resolve: resolveVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
          video,
        }: VideoTransformerArgs<H264TransformerFieldArgs>) => {
          const filename = `${name}-h264.mp4`

          return ffmpeg.queueConvertVideo({
            profile: profileH264,
            profileName: 'H264',
            sourcePath: path,
            filename,
            publicDir,
            fieldArgs,
            info,
            reporter,
            video,
          })
        },
      }),
    },
    videoH265: {
      type: `GatsbyVideo`,
      args: {
        ...DEFAULT_ARGS,
        crf: { type: 'Int', defaultValue: 31 },
        preset: { type: 'String', defaultValue: `medium` },
        maxRate: { type: 'Int' },
        bufSize: { type: 'Int' },
      },
      resolve: resolveVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
          video,
        }: VideoTransformerArgs<H265TransformerFieldArgs>) => {
          const filename = `${name}-h265.mp4`

          return ffmpeg.queueConvertVideo({
            profile: profileH265,
            profileName: 'H265',
            sourcePath: path,
            filename,
            publicDir,
            fieldArgs,
            info,
            reporter,
            video,
          })
        },
      }),
    },
    videoVP9: {
      type: `GatsbyVideo`,
      args: {
        ...DEFAULT_ARGS,
        crf: { type: 'Int', defaultValue: 31 },
        bitrate: { type: 'String' },
        minrate: { type: 'String' },
        maxrate: { type: 'String' },
        cpuUsed: { type: 'Int', defaultValue: 1 },
      },
      resolve: resolveVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
          video,
        }: VideoTransformerArgs<VP9TransformerFieldArgs>) => {
          const filename = `${name}-vp9.webm`

          return ffmpeg.queueConvertVideo({
            profile: profileVP9,
            profileName: 'VP9',
            filename,
            sourcePath: path,
            publicDir,
            fieldArgs,
            info,
            reporter,
            video,
          })
        },
      }),
    },
    videoWebP: {
      type: `GatsbyVideo`,
      args: {
        ...DEFAULT_ARGS,
      },
      resolve: resolveVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
          video,
        }: VideoTransformerArgs<DefaultTransformerFieldArgs>) => {
          const filename = `${name}-webp.webp`

          return ffmpeg.queueConvertVideo({
            profile: profileWebP,
            profileName: 'WebP',
            filename,
            sourcePath: path,
            publicDir,
            fieldArgs,
            info,
            reporter,
            video,
          })
        },
      }),
    },
    videoGif: {
      type: `GatsbyVideo`,
      args: {
        ...DEFAULT_ARGS,
      },
      resolve: resolveVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
          video,
        }: VideoTransformerArgs<DefaultTransformerFieldArgs>) => {
          const filename = `${name}-gif.gif`

          const videoResult = await ffmpeg.queueConvertVideo({
            profile: profileGif,
            profileName: 'Gif',
            sourcePath: path,
            filename,
            publicDir,
            fieldArgs,
            info,
            reporter,
            video,
          })

          await imagemin([videoResult.publicPath], {
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

          return videoResult
        },
      }),
    },
    videoProfile: {
      type: `GatsbyVideo`,
      args: {
        profile: { type: 'String' },
        ...DEFAULT_ARGS,
      },
      resolve: resolveVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
          video,
        }: VideoTransformerArgs<any>) => {
          const profileName = fieldArgs.profile
          const profile = ffmpeg.profiles[profileName]

          if (!profile) {
            throw new Error(`Unable to locate FFMPEG profile ${profileName}`)
          }

          if (!profile.extension) {
            throw new Error(
              `FFMPEG profile ${profileName} has no extension specified`
            )
          }

          if (!profile.converter) {
            throw new Error(
              `FFMPEG profile ${profileName} has no converter function specified`
            )
          }

          const filename = `${name}-${profileName}.${profile.extension}`

          return ffmpeg.queueConvertVideo({
            profile: profile.converter,
            profileName: `Custom profile: ${profileName}`,
            sourcePath: path,
            filename,
            publicDir,
            fieldArgs,
            info,
            reporter,
            video,
          })
        },
      }),
    },
    videoScreenshots: {
      type: `[File]`,
      args: {
        timestamps: { type: ['String'], defaultValue: [`0`] },
        width: { type: 'Int', defaultValue: 600 },
      },
      resolve: async (
        video: VideoNode,
        fieldArgs: ScreenshotTransformerFieldArgs
      ) => {
        return ffmpeg.queueTakeScreenshots(video, fieldArgs, {
          cache,
          getNode,
          getCache,
          createNode,
          createNodeId,
          store,
          reporter,
        })
      },
    },
  }

  const resolvers = {
    ContentfulAsset: videoFields,
    File: videoFields,
  }
  createResolvers(resolvers)
}

// Prepare rolling cache and download FFMPEG & FFPROBE binaries if they are not available.
exports.onPreInit = async (
  { reporter }: ParentSpanPluginArgs,
  {
    downloadBinaries = true,
    cacheDirectory,
    cacheDirectoryBin,
  }: GatsbyTransformerVideoOptions
) => {
  const {
    cachePathBin: binariesDir,
    cachePathActive,
    cachePathRolling,
  } = getCacheDirs({ cacheDirectory, cacheDirectoryBin })

  if (process.env.NODE_ENV === 'production') {
    const hasActiveCache = await pathExists(cachePathActive)
    const hasRollingCache = await pathExists(cachePathRolling)
    if (hasRollingCache && hasActiveCache) {
      reporter.info(`Found old rolling cache. Deleting it.`)
      await remove(cachePathRolling)
    }
    if (hasActiveCache) {
      reporter.info(`Found video cache. Creating rolling cache.`)
      await move(cachePathActive, cachePathRolling)
    } else {
      reporter.info(
        `No video cache found. This build will generate all videos and screenshots.`
      )
    }
  } else {
    reporter.info(`Rolling cache disabled for development environment`)
  }

  if (!downloadBinaries) {
    reporter.verbose(`Skipped download of FFMPEG & FFPROBE binaries`)
    return
  }

  const alreadyInstalled = await libsInstalled()

  if (alreadyInstalled) {
    reporter.verbose(`FFMPEG && FFPROBE are already available on this machine`)
    return
  }

  const arch = os.arch()

  try {
    await libsAlreadyDownloaded({ binariesDir })

    reporter.verbose(`FFMPEG & FFPROBE binaries already downloaded`)
  } catch {
    try {
      reporter.info(`FFMPEG & FFPROBE getting binaries for ${platform}@${arch}`)

      await downloadLibs({ binariesDir, platform, reporter })

      reporter.info(
        `Finished. This system is ready to convert videos with GatsbyJS`
      )
    } catch (err) {
      throw err
    }
  }
}

// Clean up rolling cache.
exports.onPostBuild = async (
  { reporter }: ParentSpanPluginArgs,
  { cacheDirectory }: GatsbyTransformerVideoOptions
) => {
  const { cachePathActive, cachePathRolling } = getCacheDirs({ cacheDirectory })

  const hasActiveCache = await pathExists(cachePathActive)
  const hasRollingCache = await pathExists(cachePathRolling)

  // Protect cache from partial rebuilds
  if (
    !hasActiveCache &&
    hasRollingCache &&
    process.env.NODE_ENV === 'production'
  ) {
    reporter.info(
      `Potential partial build detected. Setting rolling cache as cache for next build.`
    )
    await move(cachePathRolling, cachePathActive)
  }

  // Delete stale files in rolling cache @todo ensure this runs on full builds only, otherwise merge these two folders
  if (
    hasActiveCache &&
    hasRollingCache &&
    process.env.NODE_ENV === 'production'
  ) {
    // @todo List what files are deleted. Maybe like Gatsby v4 does it at the end?
    reporter.info(`Found rolling cache with leftover files. Deleting them.`)
    await remove(cachePathRolling)
  }
}
