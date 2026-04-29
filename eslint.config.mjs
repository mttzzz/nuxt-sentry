// @ts-check
import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({
  features: {
    tooling: true,
    stylistic: true,
  },
  dirs: {
    src: [
      './playground',
    ],
  },
})
  .append({
    files: ['test/fixtures/**/pages/index.vue', 'playground/**/pages/index.vue', 'test/fixtures/**/app.vue', 'playground/**/app.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  })
