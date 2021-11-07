import { FfprobeData } from 'fluent-ffmpeg'
import { ensureDir } from 'fs-extra'
import {
  CreateResolversArgs,
  CreateSchemaCustomizationArgs,
  ParentSpanPluginArgs,
} from 'gatsby'
import reporter from 'gatsby-cli/lib/reporter'
import { GraphQLFloat, GraphQLInt, GraphQLString } from 'gatsby/graphql'
import { ObjectTypeComposerFieldConfigMapDefinition } from 'graphql-compose'
import imagemin from 'imagemin'
import imageminGiflossy from 'imagemin-giflossy'
import os from 'os'
import { parse, resolve } from 'path'

import { downloadLibs, libsAlreadyDownloaded, libsInstalled } from './binaries'
import FFMPEG from './ffmpeg'
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
} from './types'

const platform = os.platform()
const arch = os.arch()

const CACHE_FOLDER_BIN = resolve(
  `node_modules`,
  `.cache`,
  `gatsby-transformer-video-bin`,
  `${platform}-${arch}`
)
const CACHE_FOLDER_VIDEOS = resolve(
  `node_modules`,
  `.cache`,
  `gatsby-transformer-video`
)

class WrongFileTypeError extends Error {}

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
  const cacheDirOriginal = resolve(rootDir, CACHE_FOLDER_VIDEOS, `original`)
  const cacheDirConverted = resolve(rootDir, CACHE_FOLDER_VIDEOS, `converted`)

  await ensureDir(cacheDirOriginal)
  await ensureDir(cacheDirConverted)

  const alreadyInstalled = await libsInstalled()

  // Set paths to our own binaries
  if (!alreadyInstalled && downloadBinaries && (!ffmpegPath || !ffprobePath)) {
    ffmpegPath = resolve(
      rootDir,
      CACHE_FOLDER_BIN,
      `ffmpeg${platform === `win32` ? `.exe` : ``}`
    )
    ffprobePath = resolve(
      rootDir,
      CACHE_FOLDER_BIN,
      `ffprobe${platform === `win32` ? `.exe` : ``}`
    )
  }

  const ffmpeg = new FFMPEG({
    rootDir,
    cacheDirOriginal,
    cacheDirConverted,
    ffmpegPath,
    ffprobePath,
    profiles,
  })

  // Get source videos metadata and download the file if required
  async function prepareAndAnalyzeVideo({
    video,
    fieldArgs,
  }: {
    video: VideoNode
    fieldArgs: DefaultTransformerFieldArgs
  }) {
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

    const metadata = await ffmpeg.analyzeVideo({
      video,
      fieldArgs,
      type,
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

  // Analyze the resulting video and prepare field return values
  async function processResult({ publicPath }: { publicPath: string }) {
    try {
      const result: FfprobeData = await ffmpeg.executeFfprobe(publicPath)

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

  // Transform video with a given transformer & codec
  function transformVideo<T extends DefaultTransformerFieldArgs>({
    transformer,
  }: {
    transformer: Transformer<T>
  }) {
    return async (video: VideoNode, fieldArgs: T) => {
      try {
        const { publicDir, path, name, info } = await prepareAndAnalyzeVideo({
          video,
          fieldArgs,
        })

        const videoData = await transformer({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
        })

        return await processResult(videoData)
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
      resolve: transformVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
        }: VideoTransformerArgs<H264TransformerFieldArgs>) => {
          const filename = `${name}-h264.mp4`
          const cachePath = resolve(ffmpeg.cacheDirConverted, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profileH264,
            sourcePath: path,
            cachePath,
            publicPath,
            fieldArgs,
            info,
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
      resolve: transformVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
        }: VideoTransformerArgs<H265TransformerFieldArgs>) => {
          const filename = `${name}-h265.mp4`
          const cachePath = resolve(ffmpeg.cacheDirConverted, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profileH265,
            sourcePath: path,
            cachePath,
            publicPath,
            fieldArgs,
            info,
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
      resolve: transformVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
        }: VideoTransformerArgs<VP9TransformerFieldArgs>) => {
          const filename = `${name}-vp9.webm`
          const cachePath = resolve(ffmpeg.cacheDirConverted, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profileVP9,
            sourcePath: path,
            cachePath,
            publicPath,
            fieldArgs,
            info,
          })
        },
      }),
    },
    videoWebP: {
      type: `GatsbyVideo`,
      args: {
        ...DEFAULT_ARGS,
      },
      resolve: transformVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
        }: VideoTransformerArgs<DefaultTransformerFieldArgs>) => {
          const filename = `${name}-webp.webp`
          const cachePath = resolve(ffmpeg.cacheDirConverted, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profileWebP,
            sourcePath: path,
            cachePath,
            publicPath,
            fieldArgs,
            info,
          })
        },
      }),
    },
    videoGif: {
      type: `GatsbyVideo`,
      args: {
        ...DEFAULT_ARGS,
      },
      resolve: transformVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
        }: VideoTransformerArgs<DefaultTransformerFieldArgs>) => {
          const filename = `${name}-gif.gif`
          const cachePath = resolve(ffmpeg.cacheDirConverted, filename)
          const publicPath = resolve(publicDir, filename)

          const absolutePath = await ffmpeg.queueConvertVideo({
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
        },
      }),
    },
    videoProfile: {
      type: `GatsbyVideo`,
      args: {
        profile: { type: GraphQLString },
        ...DEFAULT_ARGS,
      },
      resolve: transformVideo({
        transformer: async ({
          publicDir,
          path,
          name,
          fieldArgs,
          info,
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
          const cachePath = resolve(ffmpeg.cacheDirConverted, filename)
          const publicPath = resolve(publicDir, filename)

          return ffmpeg.queueConvertVideo({
            profile: profile.converter,
            sourcePath: path,
            cachePath,
            publicPath,
            fieldArgs,
            info,
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

exports.onPreInit = async (
  { store }: ParentSpanPluginArgs,
  { downloadBinaries = true }
) => {
  console.log('Testing... FINDME')

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

      await downloadLibs({ binariesDir, platform })

      reporter.info(
        `Finished. This system is ready to convert videos with GatsbyJS`
      )
    } catch (err) {
      throw err
    }
  }
}
