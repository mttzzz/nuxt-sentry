import { defineNitroPlugin } from "nitropack/runtime";
import { captureNitroError } from "../utils/capture-nitro-error.js";
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("error", captureNitroError);
});
