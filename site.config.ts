import { siteConfig } from './lib/site-config'

export default siteConfig({
  // the site's root Notion page (required)
  rootNotionPageId: '9bd61c547d8083db85288187828423ff',

  // if you want to restrict pages to a single notion workspace (optional)
  // (this should be a Notion ID; see the docs for how to extract this)
  rootNotionSpaceId: null,

  // basic site info (required)
  name: "Rachel's Investment Studio",
  domain: "nextjs-notion-starter-kit.transitivebullsh.it",
  author: "Rachel",

  // open graph metadata (optional)
  description: 'Independent investment research, portfolio analytics, and systematic strategy experiments.',

  // social usernames (optional)
  // twitter: 'transitive_bs', // optional
  github: 'rachelchen1124-dot',
  linkedin: 'rachel-simin-chen',
  // mastodon: '#', // optional mastodon profile URL, provides link verification
  // newsletter: '#', // optional newsletter URL
  // youtube: '#', // optional youtube channel name or `channel/UCGbXXXXXXXXXXXXXXXXXXXXXX`

  // default notion icon and cover images for site-wide consistency (optional)
  // page-specific values will override these site-wide defaults
  defaultPageIcon: null,
  defaultPageCover: null,
  defaultPageCoverPosition: 0.5,

  // whether or not to enable support for LQIP preview images (optional)
  isPreviewImageSupportEnabled: true,

  // whether or not redis is enabled for caching generated preview images (optional)
  // NOTE: if you enable redis, you need to set the `REDIS_HOST` and `REDIS_PASSWORD`
  // environment variables. see the readme for more info
  isRedisEnabled: false,

  // map of notion page IDs to URL paths (optional)
  // any pages defined here will override their default URL paths
  // example:
  //
  // pageUrlOverrides: {
  //   '/foo': '067dd719a912471ea9a3ac10710e7fdf',
  //   '/bar': '0be6efce9daf42688f65c76b89f8eb27'
  // }
  pageUrlOverrides: null,

  // whether to use the default notion navigation style or a custom one with links to
  // important pages. To use `navigationLinks`, set `navigationStyle` to `custom`.
   navigationStyle: 'custom',

navigationLinks: [
  {
    title: 'Research',
    pageId: '39d61c547d808075a27de44f2e620593'
  },
  {
    title: 'Strategy Lab',
    pageId: '39d61c547d8080fbb9dafdbef1ca6fbc'
  },
  {
    title: 'Portfolio',
    pageId: '39d61c547d8080eeb6d4d1129c93fb3b'
  },
  {
    title: 'Tools',
    pageId: '39d61c547d8080229e98c3379dd80f19'
  },
  
]
  }) 
