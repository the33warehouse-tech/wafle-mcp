/**
 * Prompt: debug_orden_fallida
 *
 * Investigate a failed order, read the timeline, and (if appropriate)
 * retry payment via a secondary gateway.
 */
import type { WaflePrompt } from "./registry.js";

export const debugOrdenFallidaPrompt: WaflePrompt = {
  name: "debug_orden_fallida",
  description:
    "Diagnóstico completo de una orden con problema de pago/envío: estado actual, timeline, y opcionalmente reintento con un gateway secundario sin re-cobrar al cliente.",
  arguments: [
    { name: "store_slug", description: "Slug de la tienda (ej. 'gamerland').", required: true },
    { name: "order_id", description: "ID numérico de la orden a investigar.", required: true },
    { name: "user_complaint", description: "Reclamo textual del cliente (ej. 'pagué pero no me llegó nada'). Ayuda al asistente a contextualizar.", required: false },
    { name: "retry_gateway_type", description: "Si se sospecha rechazo del gateway primario, type del gateway secundario para reintentar ('transfer' | 'mp_ar' | 'stripe'). Si está vacío, sólo diagnostica.", required: false },
    { name: "followup_whatsapp", description: "Teléfono del cliente con código país (ej. '+5491155512345') para programar follow-up por WhatsApp si la transferencia no se acredita en 24h.", required: false },
  ],
  handler: (args) => {
    const slug = args["store_slug"]!;
    const orderId = args["order_id"]!;
    const complaint = args["user_complaint"];
    const retryType = args["retry_gateway_type"];
    const followupPhone = args["followup_whatsapp"];

    const lines: string[] = [];
    lines.push(`Investigá la orden **#${orderId}** de la tienda \`${slug}\`.`);
    if (complaint) {
      lines.push(`Reclamo del cliente: "${complaint}".`);
    }
    lines.push("");
    lines.push("## Plan (conservador — leer todo antes de tocar)");
    lines.push("");
    lines.push("### 1. Estado actual de la orden");
    lines.push(`Llamá \`wafle_orders_get\` con \`{ slug: "${slug}", order_id: ${orderId} }\`. Anotá:`);
    lines.push("- `status` y `payment_status`.");
    lines.push("- `customer.email` y `customer.name`.");
    lines.push("- `total_cents` y moneda.");
    lines.push("- Último `gateway_attempts[]` con su `reason` (ej. `cc_rejected_high_risk`, `cc_rejected_insufficient_amount`).");
    lines.push("");
    lines.push("### 2. Timeline cronológico");
    lines.push(`Llamá \`wafle_orders_timeline\` con \`{ slug: "${slug}", order_id: ${orderId} }\`. Verificá si hubo \`payment_intent_created\` → \`payment_attempt\` → \`payment_rejected\` (no se debitó plata) o \`payment_authorized\` → \`payment_captured\` (sí se cobró). Esto define qué decirle al cliente.`);
    lines.push("");
    lines.push("### 3. Diagnóstico claro");
    lines.push("Decile al usuario, en lenguaje simple:");
    lines.push("- Si NO se debitó plata: explicarle al cliente (vía sugerencia de respuesta al final) que la transacción nunca se completó — no hay reembolso pendiente, sólo retry.");
    lines.push("- Si SÍ se debitó: detener cualquier retry; el camino es esperar el webhook de captura o llamar `wafle_orders_refund` si decide cancelar.");
    lines.push("");
    if (retryType) {
      lines.push("### 4. Reintentar con gateway secundario");
      lines.push(`El usuario pidió retry vía \`type=${retryType}\`. Pasos:`);
      lines.push(`1. Llamá \`wafle_gateways_list { active_only: true }\` filtrando \`store_slug=${slug}\` y \`type=${retryType}\`. Tomá el primer activo.`);
      lines.push(`2. Llamá \`wafle_orders_retry_payment\` con \`{ slug: "${slug}", order_id: ${orderId}, gateway_id: <id>, notify_customer: true }\`. Asegurate de que la orden NO esté en \`paid\` antes de hacer esto.`);
      lines.push("3. Reportá: nuevo status (`awaiting_transfer` / `awaiting_payment`), datos de pago si aplica (CBU/alias para transferencia), deadline.");
      lines.push("");
    }
    if (followupPhone) {
      lines.push("### 5. Programar follow-up por WhatsApp");
      lines.push(`Si la orden quedó en \`awaiting_*\`, llamá \`wafle_orders_followup_create\` con \`{ slug: "${slug}", order_id: ${orderId}, trigger_at: "<24h-from-now ISO>", channel: "whatsapp", template: "payment_pending_followup", to: "${followupPhone}" }\`.`);
      lines.push("");
    }
    lines.push(`### ${retryType || followupPhone ? "6" : "4"}. Sugerencia de respuesta al cliente`);
    lines.push("Devolvé al usuario un párrafo listo para copiar/pegar al cliente, en su tono natural y honesto sobre qué pasó y qué tiene que hacer ahora.");
    lines.push("");
    lines.push("**Reglas inviolables:**");
    lines.push("- Nunca llamar `wafle_orders_refund` si el cliente NO pagó (no hay nada para reembolsar).");
    lines.push("- Nunca llamar `wafle_orders_retry_payment` si la orden ya está en `paid` o `shipped`.");
    lines.push("- Si encontrás algo raro (status inconsistente, gateway sin response, timeline con gap), parar y mostrarle al usuario el JSON crudo en lugar de inventar.");

    return {
      description: `Diagnóstico de orden #${orderId} en ${slug}`,
      messages: [
        {
          role: "user",
          content: { type: "text", text: lines.join("\n") },
        },
      ],
    };
  },
};
