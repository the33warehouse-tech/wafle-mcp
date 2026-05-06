/**
 * Aggregate all tool domains.
 */
import { ToolRegistry, type ToolContext, type WafleTool } from "./registry.js";
import { authTools } from "./auth.js";
import { storesTools } from "./stores.js";
import { productsTools } from "./products.js";
import { pricingTools } from "./pricing.js";
import { ordersTools } from "./orders.js";
import { checkoutTools } from "./checkout.js";
import { customersTools } from "./customers.js";
import { gatewaysTools } from "./gateways.js";
import { shippingTools } from "./shipping.js";
import { couponsTools } from "./coupons.js";
import { abandonedTools } from "./abandoned.js";
import { analyticsTools } from "./analytics.js";
import { exportsTools } from "./exports.js";
import { pixelsTools } from "./pixels.js";
import { systemTools } from "./system.js";
import { metaTools } from "./meta.js";
import { aiTools } from "./ai.js";
import { agentsTools } from "./agents.js";
import { domainsTools } from "./domains.js";
import { adsWriterTools } from "./ads-writer.js";
import { adsOpsTools } from "./ads-ops.js";
import { usersTools } from "./users.js";

export function createRegistry(ctx: ToolContext): ToolRegistry {
  const registry = new ToolRegistry(ctx);
  const all: WafleTool[] = [
    ...authTools,
    ...usersTools,
    ...storesTools,
    ...productsTools,
    ...pricingTools,
    ...ordersTools,
    ...checkoutTools,
    ...customersTools,
    ...gatewaysTools,
    ...shippingTools,
    ...couponsTools,
    ...abandonedTools,
    ...analyticsTools,
    ...exportsTools,
    ...pixelsTools,
    ...systemTools,
    ...metaTools,
    ...aiTools,
    ...agentsTools,
    ...domainsTools,
    ...adsWriterTools,
    ...adsOpsTools,
  ];
  for (const t of all) registry.register(t);
  return registry;
}
