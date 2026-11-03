import { setupPlugin, type PluginContext, type PluginOptions } from "./plugin.js";

export default {
  id: "memory-autopilot",
  async setup(ctx: PluginContext, options?: PluginOptions): Promise<() => Promise<void>> {
    return setupPlugin(ctx, options);
  },
};

export { setupPlugin } from "./plugin.js";
export type { PluginContext, PluginOptions } from "./plugin.js";
export * from "./types.js";
