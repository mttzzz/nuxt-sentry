<script setup lang="ts">
const config = useRuntimeConfig()

async function triggerError() {
  try {
    await $fetch('/api/__throw')
  }
  catch (error) {
    console.error('caught', error)
  }
}
</script>

<template>
  <div style="font-family: system-ui; padding: 2rem; max-width: 720px; margin: 0 auto">
    <h1>nuxt-sentry playground</h1>
    <p>tunnel: <code>{{ config.public.sentry?.tunnelEndpoint }}</code></p>
    <p>project: <code>{{ config.public.sentry?.project }}</code></p>
    <button
      type="button"
      @click="triggerError"
    >
      Throw на /api/__throw
    </button>
  </div>
</template>
