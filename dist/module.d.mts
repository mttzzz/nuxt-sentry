import * as _nuxt_schema from '@nuxt/schema';
import { PublicRuntimeSentryConfig, ModuleOptions } from '../dist/runtime/types.js';
export { ModuleOptions } from '../dist/runtime/types.js';

declare const _default: _nuxt_schema.NuxtModule<ModuleOptions, ModuleOptions, false>;

declare module 'nuxt/schema' {
    interface PublicRuntimeConfig {
        sentry?: PublicRuntimeSentryConfig;
    }
}

export { _default as default };
