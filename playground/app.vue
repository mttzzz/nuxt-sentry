<script setup lang="ts">
const config = useRuntimeConfig()
/* В stub-режиме (dev:prepare) playground резолвит свою копию @nuxt/schema из изолированного
   node_modules — аугментация PublicRuntimeConfig из src/module.ts до неё не доезжает, и
   public.sentry типизируется как {}. У консьюмеров (dist из prepack) тип полный. */
const sentry = config.public.sentry as { tunnelEndpoint?: string; project?: string } | undefined

async function triggerError() {
  try {
    await $fetch('/api/__throw')
  } catch (error) {
    // oxlint-disable-next-line no-console -- playground debug output
    console.error('caught', error)
  }
}
</script>

<template>
  <div style="font-family: system-ui; padding: 2rem; max-width: 720px; margin: 0 auto">
    <h1>nuxt-sentry playground</h1>
    <p>
      tunnel: <code>{{ sentry?.tunnelEndpoint }}</code>
    </p>
    <p>
      project: <code>{{ sentry?.project }}</code>
    </p>
    <button
      type="button"
      @click="triggerError"
    >
      Throw на /api/__throw
    </button>
  </div>
</template>
