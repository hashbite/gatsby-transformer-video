import axios from 'axios'
import fs from 'fs'
import { access } from 'fs-extra'
import reporter from 'gatsby-cli/lib/reporter'
import PQueue from 'p-queue'
import { extname, resolve } from 'path'

import { VideoNode } from './types'

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
