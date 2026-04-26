/**
 * Prompt: segmentar_y_campania
 *
 * Build a customer segment and schedule an email campaign against it.
 */
import type { WaflePrompt } from "./registry.js";

export const segmentarYCampaniaPrompt: WaflePrompt = {
  name: "segmentar_y_campania",
  description:
    "Segmentar clientes (criterio + nombre) y lanzar/agendar una campaña de email con un template existente y un subject custom.",
  arguments: [
    { name: "store_slug", description: "Slug de la tienda (ej. 'gamerland').", required: true },
    { name: "segment_name", description: "Nombre humano del segmento (ej. 'Top spenders abril').", required: true },
    { name: "criteria_description", description: "Descripción del criterio en lenguaje natural (ej. 'compraron > $50.000 en últimos 30 días'). El asistente lo traduce a las reglas estructuradas.", required: true },
    { name: "template_slug", description: "Slug del email template a usar (debe existir en la tienda).", required: true },
    { name: "subject", description: "Subject del email.", required: true },
    { name: "send_at", description: "Cuándo mandar (ISO 8601 UTC, ej. '2026-04-27T13:00:00Z'). Si está vacío, manda inmediato.", required: false },
    { name: "send_preview_to", description: "Email para mandar un preview personal antes del blast masivo. Opcional.", required: false },
  ],
  handler: (args) => {
    const slug = args["store_slug"]!;
    const name = args["segment_name"]!;
    const criteria = args["criteria_description"]!;
    const template = args["template_slug"]!;
    const subject = args["subject"]!;
    const sendAt = args["send_at"];
    const previewTo = args["send_preview_to"];

    const lines: string[] = [];
    lines.push(`Armá una campaña de email para la tienda \`${slug}\` apuntada al segmento **"${name}"**.`);
    lines.push("");
    lines.push(`Criterio del segmento (en lenguaje natural): **${criteria}**.`);
    lines.push(`Template: \`${template}\`. Subject: "${subject}".`);
    if (sendAt) {
      lines.push(`Programado para: \`${sendAt}\` (UTC).`);
    } else {
      lines.push(`Envío: inmediato (no se proveyó \`send_at\`).`);
    }
    lines.push("");
    lines.push("## Plan");
    lines.push("");
    lines.push("### 1. Verificar que el template existe y está activo");
    lines.push(`Llamá al endpoint de templates de la tienda (o leé el resource \`wafle://stores/${slug}/email/recent-campaigns\` como pista). Si \`${template}\` no existe o no está \`active=true\`, parar y avisar al usuario.`);
    lines.push("");
    lines.push("### 2. Traducir el criterio a reglas estructuradas");
    lines.push("Convertí la descripción a un objeto `criteria` con `all_of` / `any_of` y métricas estandarizadas. Ejemplos de métricas: `total_spent_cents`, `orders_count`, `last_order_at`, `tag`. Operadores: `>`, `>=`, `<`, `<=`, `==`, `!=`. Ventanas: `window_days`.");
    lines.push("");
    lines.push("### 3. Crear el segmento");
    lines.push(`Llamá \`wafle_customers_segments_create\` con \`{ store_slug: "${slug}", name: "${name}", description: "${criteria.replace(/"/g, '\\"')}", criteria: <objeto-traducido> }\`. Registrá el \`segment_id\` y el \`estimated_size\` para reportar al usuario.`);
    lines.push("");
    lines.push("### 4. Crear la campaña");
    lines.push("Llamá `wafle_marketing_campaigns_create` con:");
    lines.push("```json");
    lines.push("{");
    lines.push(`  "store_slug": "${slug}",`);
    lines.push(`  "name": "Campaña — ${name}",`);
    lines.push(`  "channel": "email",`);
    lines.push(`  "template_slug": "${template}",`);
    lines.push(`  "segment_id": <segment_id>,`);
    lines.push(`  "subject": "${subject.replace(/"/g, '\\"')}",`);
    if (sendAt) {
      lines.push(`  "schedule": { "type": "scheduled", "send_at": "${sendAt}" }`);
    } else {
      lines.push(`  "schedule": { "type": "immediate" }`);
    }
    lines.push("}");
    lines.push("```");
    lines.push("");
    if (previewTo) {
      lines.push("### 5. Preview personal antes del blast");
      lines.push(`Llamá \`wafle_marketing_campaigns_send_preview\` con \`{ campaign_id: <id>, to: "${previewTo}" }\` para que el usuario vea el render antes del envío masivo.`);
      lines.push("");
    }
    lines.push("### 6. Reportar al usuario");
    lines.push("Devolvé:");
    lines.push("- `segment_id` + `estimated_size`.");
    lines.push("- `campaign_id` + estado (`scheduled` con `send_at`, o `sending` para inmediato).");
    lines.push("- URL del preview en el panel para revisar el HTML antes que salga.");
    lines.push("- Comando para cancelar antes del envío: `wafle_marketing_campaigns_cancel { campaign_id }`.");

    return {
      description: `Segmento + campaña: ${name} en ${slug}`,
      messages: [
        {
          role: "user",
          content: { type: "text", text: lines.join("\n") },
        },
      ],
    };
  },
};
