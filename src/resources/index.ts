/**
 * Aggregate every resource module into a single registry.
 */
import { ResourceRegistry, type ResourceContext, type WafleResource } from "./registry.js";
import { systemResources } from "./system.js";
import { storesResources } from "./stores.js";

export function createResourceRegistry(ctx: ResourceContext): ResourceRegistry {
  const registry = new ResourceRegistry(ctx);
  const all: WafleResource[] = [...systemResources, ...storesResources];
  for (const r of all) registry.register(r);
  return registry;
}

export {
  ResourceRegistry,
  type ResourceContext,
  type WafleResource,
  type ResourceParams,
  type ResourceListEntry,
} from "./registry.js";
