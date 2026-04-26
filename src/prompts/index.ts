/**
 * Aggregate every prompt module into a single registry.
 */
import { PromptRegistry, type WaflePrompt } from "./registry.js";
import { onboardingTiendaNuevaPrompt } from "./onboarding-tienda-nueva.js";
import { pedidoEnviarPrompt } from "./pedido-enviar.js";
import { segmentarYCampaniaPrompt } from "./segmentar-y-campania.js";
import { conectarMetaYSyncPrompt } from "./conectar-meta-y-sync.js";
import { debugOrdenFallidaPrompt } from "./debug-orden-fallida.js";

export function createPromptRegistry(): PromptRegistry {
  const registry = new PromptRegistry();
  const all: WaflePrompt[] = [
    onboardingTiendaNuevaPrompt,
    pedidoEnviarPrompt,
    segmentarYCampaniaPrompt,
    conectarMetaYSyncPrompt,
    debugOrdenFallidaPrompt,
  ];
  for (const p of all) registry.register(p);
  return registry;
}

export {
  PromptRegistry,
  type WaflePrompt,
  type PromptArgument,
  type PromptListEntry,
  type RenderedPrompt,
} from "./registry.js";
