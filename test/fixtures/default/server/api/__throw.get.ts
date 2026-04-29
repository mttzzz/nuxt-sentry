export default defineEventHandler(() => {
  throw new Error('fixture-default: triggered unhandled')
})
