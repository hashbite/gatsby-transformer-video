import React from 'react'
import { graphql } from 'gatsby'

import './styles.css'

function Video({
  video: {
    videoH264,
    videoH265,
    videoVP9,
    previewH264,
    previewWebP,
    previewGif,
    videoSepia,
    videoScreenshots,
  },
  ...props
}) {
  return (
    <div {...props}>
      <h3>Screenshots at 0s, 1s, 50% and 99%:</h3>
      <div className="screenshots">
        {videoScreenshots.map(({ publicURL }) => (
          <div key="path">
            <img src={publicURL} />
          </div>
        ))}
      </div>
      <h3>
        Animated preview via{` `}
        <a href="https://css-tricks.com/fallbacks-videos-images/">
          picture element
        </a>
        :
      </h3>
      <p>Fallbacks: h264, animated webP and Gifs</p>
      <picture>
        <source type="video/mp4" srcSet={previewH264.path} />
        <source type="image/webp" srcSet={previewWebP.path} />
        <img loading="lazy" src={previewGif.path} alt="" />
      </picture>
      <h3>Video as optimized h264 &amp; h265 &amp; VP9:</h3>
      <video
        playsInline
        preload="auto"
        poster={videoScreenshots[0].publicURL}
        controls
      >
        <source src={videoH265.path} type="video/mp4; codecs=hevc" />
        <source src={videoVP9.path} type="video/webm; codecs=vp9,opus" />
        <source src={videoH264.path} type="video/mp4; codecs=avc1" />
      </video>
      <h3>Custom video converter:</h3>
      <video
        playsInline
        preload="auto"
        poster={videoScreenshots[0].publicURL}
        controls
      >
        <source src={videoSepia.path} type="video/mp4; codecs=avc1" />
      </video>
    </div>
  )
}

const Index = ({ data }) => {
  return (
    <main>
      <h1>Using gatsby-transformer-video</h1>
      <div className="grid">
        <div>
          <h2>Via gatsby-source-filesystem</h2>
          <Video video={data.file} />
        </div>
        <div>
          <h2>Via gatsby-source-contentful</h2>
          <Video video={data.contentfulAsset} />
        </div>
      </div>
    </main>
  )
}

export default Index

export const query = graphql`
  query HomePageQuery {
    file(relativePath: { eq: "gatsby.mp4" }) {
      id
      videoH264 {
        path
      }
      videoH265 {
        path
      }
      videoVP9 {
        path
      }
      videoSepia: videoProfile(profile: "sepia", maxWidth: 600) {
        path
      }
      previewH264: videoH264(maxWidth: 600, fps: 4, duration: 2) {
        path
      }
      previewWebP: videoWebP(maxWidth: 600, fps: 4, duration: 2) {
        path
      }
      previewGif: videoGif(maxWidth: 600, fps: 4, duration: 2) {
        path
      }
      videoScreenshots(timestamps: ["0", "1", "50%", "99%"]) {
        publicURL
      }
    }
    contentfulAsset(contentful_id: { eq: "6HqTq5U2PLoVO0Qo7Vy0Yk" }) {
      id
      videoH264 {
        path
      }
      videoH265 {
        path
      }
      videoVP9 {
        path
      }
      videoSepia: videoProfile(profile: "sepia", maxWidth: 600) {
        path
      }
      previewH264: videoH264(maxWidth: 600, fps: 4, duration: 2) {
        path
      }
      previewWebP: videoWebP(maxWidth: 600, fps: 4, duration: 2) {
        path
      }
      previewGif: videoGif(maxWidth: 600, fps: 4, duration: 2) {
        path
      }
      videoScreenshots(timestamps: ["0", "1", "50%", "99%"]) {
        publicURL
      }
    }
  }
`
