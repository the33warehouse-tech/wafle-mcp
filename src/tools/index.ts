/**
 * Aggregate all tool domains.
 */
import { ToolRegistry, type ToolContext, type WafleTool } from "./registry.js";
import { authTools } from "./auth.js";
import { storesTools } from "./stores.js";
import { productsTools } from "./products.js";
import { pricingTools } from "./pricing.js";
import { ordersTools } from "./orders.js";
import { customersTools } from "./customers.js";
import { gatewaysTools } from "./gateways.js";
import { shippingTools } from "./shipping.js";
import { couponsTools } from "./coupons.js";
import { abandonedTools } from "./abandoned.js";
import { analyticsTools } from "./analytics.js";
import { exportsTools } from "./exports.js";
import { pixelsTools } from "./pixels.js";
import { systemTools } from "./system.js";

export function createRegistry(ctx: ToolContext): ToolRegistry {
  const registry = new ToolRegistry(ctx);
  const all: WafleTool[] = [
    ...authTools,
    ...storesTools,
    ...productsTools,
    ...pricingTools,
    ...ordersTools,
    ...customersTools,
    ...gatewaysTools,
    ...shippingTools,
    ...couponsTools,
    ...abandonedTools,
    ...analyticsTools,
    ...exportsTools,
    ...pixelsTools,
    ...systemTools,
  ];
  for (const t of all) registry.register(t);
  return registry;
}
