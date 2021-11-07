import { ensureDir } from 'fs-extra'
import {
  CreateResolversArgs,
  CreateSchemaCustomizationArgs,
  ParentSpanPluginArgs,
} from 'gatsby'
import { GraphQLFloat, GraphQLInt, GraphQLString } from 'gatsby/graphql'
import { ObjectTypeComposerFieldConfigMapDefinition } from 'graphql-compose'
import imagemin from 'imagemin'
import imageminGiflossy from 'imagemin-giflossy'
import os from 'os'
import { resolve } from 'path'

import { downloadLibs, libsAlreadyDownloaded, libsInstalled } from './binaries'
import FFMPEG from './ffmpeg'
import { prepareAndAnalyzeVideo, processResult } from './helpers'
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
const arch = os.arch()

// @todo make configurable
const CACHE_FOLDER_BIN = resolve(
  `.bin`,
  `gatsby-transformer-video`,
  `${platform}-${arch}`
)
const CACHE_FOLDER_VIDEOS = resolve(`.cache-video`)

const DEFAULT_ARGS = {
  maxWidth: { type: GraphQLInt, defaultValue: 1920 },
  maxHeight: { type: GraphQLInt, defaultValue: null },
  duration: { type: GraphQLInt, defaultValue: null },
  fps: { type: GraphQLInt, defaultValue: null },
  saturation: { type: GraphQLFloat, defaultValue: 1 },
  overlay: { type: GraphQLString, defaultValue: null },
  overlayX: { type: GraphQLString, defaultValue: `center` },
  overlayY: { type: GraphQLString, defaultValue: `center` },
  overlayPadding: { type: GraphQLInt, defaultValue: 10 },
  publicPath: {
    type: GraphQLString,
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
        path: GraphQLString,
        absolutePath: GraphQLString,
        name: GraphQLString,
        ext: GraphQLString,
        formatName: GraphQLString,
        formatLongName: GraphQLString,
        startTime: GraphQLFloat,
        duration: GraphQLFloat,
        size: GraphQLInt,
        bitRate: GraphQLInt,
        width: GraphQLInt,
        height: GraphQLInt,
        aspectRatio: GraphQLFloat,
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
  }: GatsbyTransformerVideoOptions
) => {
  const program = store.getState().program
  const rootDir = program.directory

  const alreadyInstalled = await libsInstalled()

  // Set paths to our own binaries
  if (!alreadyInstalled && downloadBinaries && (!ffmpegPath || !ffprobePath)) {
    ffmpegPath = resolve(
      CACHE_FOLDER_BIN,
      `ffmpeg${platform === `win32` ? `.exe` : ``}`
    )
    ffprobePath = resolve(
      CACHE_FOLDER_BIN,
      `ffprobe${platform === `win32` ? `.exe` : ``}`
    )
  }
  const cacheDir = CACHE_FOLDER_VIDEOS
  const cacheVideosDir = resolve(CACHE_FOLDER_VIDEOS, 'videos')
  const cacheScreenshotsDir = resolve(CACHE_FOLDER_VIDEOS, 'screenshots')

  // @todo move to init?
  await ensureDir(cacheVideosDir)
  await ensureDir(cacheScreenshotsDir)

  const ffmpeg = new FFMPEG({
    rootDir,
    cacheDir,
    cacheVideosDir,
    cacheScreenshotsDir,
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
        crf: { type: GraphQLInt, defaultValue: 28 },
        preset: { type: GraphQLString, defaultValue: `medium` },
        maxRate: { type: GraphQLString },
        bufSize: { type: GraphQLString },
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
          const cachePath = resolve(cacheVideosDir, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profileH264,
            profileName: 'H264',
            sourcePath: path,
            cachePath,
            publicPath,
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
        crf: { type: GraphQLInt, defaultValue: 31 },
        preset: { type: GraphQLString, defaultValue: `medium` },
        maxRate: { type: GraphQLInt },
        bufSize: { type: GraphQLInt },
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
          const cachePath = resolve(cacheVideosDir, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profileH265,
            profileName: 'H265',
            sourcePath: path,
            cachePath,
            publicPath,
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
        crf: { type: GraphQLInt, defaultValue: 31 },
        bitrate: { type: GraphQLString },
        minrate: { type: GraphQLString },
        maxrate: { type: GraphQLString },
        cpuUsed: { type: GraphQLInt, defaultValue: 1 },
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
          const cachePath = resolve(cacheVideosDir, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profileVP9,
            profileName: 'VP9',
            sourcePath: path,
            cachePath,
            publicPath,
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
          const cachePath = resolve(cacheVideosDir, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profileWebP,
            profileName: 'WebP',
            sourcePath: path,
            cachePath,
            publicPath,
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
          const cachePath = resolve(cacheVideosDir, filename)
          const publicPath = resolve(publicDir, filename)

          const absolutePath = await ffmpeg.queueConvertVideo({
            profile: profileGif,
            profileName: 'Gif',
            sourcePath: path,
            cachePath,
            publicPath,
            fieldArgs,
            info,
            reporter,
            video,
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
        },
      }),
    },
    videoProfile: {
      type: `GatsbyVideo`,
      args: {
        profile: { type: GraphQLString },
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
          const cachePath = resolve(cacheVideosDir, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profile.converter,
            profileName: `Custom profile: ${profileName}`,
            sourcePath: path,
            cachePath,
            publicPath,
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
        timestamps: { type: [GraphQLString], defaultValue: [`0`] },
        width: { type: GraphQLInt, defaultValue: 600 },
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

// Download FFMPEG & FFPROBE binaries if they are not available.
exports.onPreInit = async (
  { store, reporter }: ParentSpanPluginArgs,
  { downloadBinaries = true }
) => {
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
  const program = store.getState().program
  const rootDir = program.directory
  const binariesDir = resolve(rootDir, CACHE_FOLDER_BIN)

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
