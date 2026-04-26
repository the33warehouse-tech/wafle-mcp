/**
 * Prompt: pedido_enviar
 *
 * Mark an order as shipped, save tracking, notify the customer.
 */
import type { WaflePrompt } from "./registry.js";

export const pedidoEnviarPrompt: WaflePrompt = {
  name: "pedido_enviar",
  description:
    "Marcar un pedido como enviado: registrar carrier + tracking, cambiar status a `shipped`, y disparar el email transaccional al cliente.",
  arguments: [
    { name: "store_slug", description: "Slug de la tienda dueña del pedido (ej. 'gamerland').", required: true },
    { name: "order_id", description: "ID numérico del pedido (ej. '87').", required: true },
    { name: "carrier", description: "Carrier slug: 'andreani' | 'oca' | 'viacargo' | 'correo_argentino' | otros.", required: true },
    { name: "tracking_number", description: "Código de tracking del carrier (ej. 'ABC123XYZ').", required: true },
    { name: "tracking_url", description: "URL pública para que el cliente vea el envío. Opcional — el carrier-resolver puede derivarla del código.", required: false },
    { name: "notify_customer", description: "'true' (default) para mandar el email; 'false' para silencioso.", required: false },
  ],
  handler: (args) => {
    const slug = args["store_slug"]!;
    const orderId = args["order_id"]!;
    const carrier = args["carrier"]!;
    const tracking = args["tracking_number"]!;
    const trackingUrl = args["tracking_url"];
    const notify = (args["notify_customer"] ?? "true").toLowerCase() !== "false";

    const lines: string[] = [];
    lines.push(`Marcá el pedido **#${orderId}** de la tienda \`${slug}\` como enviado.`);
    lines.push("");
    lines.push("## Plan");
    lines.push("");
    lines.push("### 1. Verificar el pedido antes de mover nada");
    lines.push(`Llamá \`wafle_orders_get\` con \`{ slug: "${slug}", order_id: ${orderId} }\`.`);
    lines.push("Confirmá que:");
    lines.push("- El status actual es `paid` o `processing` (no enviado ya, ni cancelado, ni reembolsado).");
    lines.push("- Hay un email de cliente para notificar.");
    lines.push("- El método de envío del pedido coincide con el carrier que vas a registrar (si no coincide, avisar y pedir confirmación).");
    lines.push("");
    lines.push("### 2. Marcar como enviado con tracking");
    lines.push(`Llamá \`wafle_orders_ship\` con:`);
    lines.push("```json");
    lines.push("{");
    lines.push(`  "slug": "${slug}",`);
    lines.push(`  "order_id": ${orderId},`);
    lines.push(`  "carrier": "${carrier}",`);
    lines.push(`  "tracking_number": "${tracking}",`);
    if (trackingUrl) lines.push(`  "tracking_url": "${trackingUrl}",`);
    lines.push(`  "notify_customer": ${notify}`);
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("### 3. (Opcional) Confirmar el email enviado");
    lines.push("Si el response trae un `message_id` o equivalente, podés llamar al endpoint de emails para mostrar al usuario subject + estado de delivery.");
    lines.push("");
    lines.push("### 4. Reportar");
    lines.push("Devolvé al usuario:");
    lines.push("- Cambio de status (`previous_status` → `shipped`).");
    lines.push("- Carrier + tracking guardado, con la URL de seguimiento.");
    lines.push(`- Si \`notify_customer=true\`: confirmá que el email salió a la dirección del cliente.`);
    lines.push("");
    lines.push("Si `wafle_orders_ship` devuelve `kind=validation` o `kind=conflict`, parar y mostrarle al usuario qué pasó (probablemente status ya cambiado).");

    return {
      description: `Enviar pedido #${orderId} de ${slug} (${carrier} ${tracking})`,
      messages: [
        {
          role: "user",
          content: { type: "text", text: lines.join("\n") },
        },
      ],
    };
  },
};
