import type { ModulePublicRuntimeConfig } from './module.mjs'

declare module '@nuxt/schema' {
  interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}
}

export { type ModuleOptions } from '../dist/runtime/types.js'

export { default } from './module.mjs'

export { type ModulePublicRuntimeConfig } from './module.mjs'
