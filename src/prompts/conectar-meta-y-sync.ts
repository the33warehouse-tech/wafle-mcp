/**
 * Prompt: conectar_meta_y_sync
 *
 * Connect Meta to a wafle store, do an initial catalog sync, and report
 * the last 3 syncs.
 */
import type { WaflePrompt } from "./registry.js";

export const conectarMetaYSyncPrompt: WaflePrompt = {
  name: "conectar_meta_y_sync",
  description:
    "Conectar la cuenta Meta (Business Manager + ad account + catalog ID) a una tienda y disparar la sync inicial del catálogo al Catalog API de Meta. Reporta últimas 3 syncs y propone schedule recurrente.",
  arguments: [
    { name: "store_slug", description: "Slug de la tienda (ej. 'gamerland').", required: true },
    { name: "business_manager_id", description: "ID del Business Manager de Meta (ej. '1877915902851559').", required: true },
    { name: "ad_account_id", description: "ID de la ad account, formato 'act_XXXXXXXXXX'.", required: true },
    { name: "catalog_id", description: "ID del catalog en Meta (Commerce Manager).", required: true },
    { name: "filter_in_stock_only", description: "'true' (default) para subir sólo productos in_stock; 'false' para subir todo.", required: false },
    { name: "schedule_interval", description: "Intervalo de sync recurrente: '6h' | '12h' | '24h' | 'manual'. Default 'manual' (no programa).", required: false },
  ],
  handler: (args) => {
    const slug = args["store_slug"]!;
    const bm = args["business_manager_id"]!;
    const ad = args["ad_account_id"]!;
    const cat = args["catalog_id"]!;
    const inStock = (args["filter_in_stock_only"] ?? "true").toLowerCase() !== "false";
    const interval = args["schedule_interval"] ?? "manual";

    const lines: string[] = [];
    lines.push(`Conectá Meta a la tienda \`${slug}\` y sincronizá el catálogo al Commerce Manager.`);
    lines.push("");
    lines.push(`Business Manager: \`${bm}\`. Ad account: \`${ad}\`. Catalog: \`${cat}\`. Filtro in_stock: \`${inStock}\`. Schedule recurrente: \`${interval}\`.`);
    lines.push("");
    lines.push("## Plan");
    lines.push("");
    lines.push("### 1. Ver conexiones ads existentes (no duplicar)");
    lines.push(`Leé el resource \`wafle://stores/${slug}/ads/connections\` (o llamá \`wafle_ads_connections_list\`). Si ya hay una conexión Meta activa con el mismo \`ad_account_id\`/\`catalog_id\`, parar y reportar — no crear duplicado.`);
    lines.push("");
    lines.push("### 2. Crear la conexión Meta");
    lines.push("Llamá `wafle_ads_connections_create` con:");
    lines.push("```json");
    lines.push("{");
    lines.push(`  "store_slug": "${slug}",`);
    lines.push(`  "platform": "meta",`);
    lines.push(`  "config": {`);
    lines.push(`    "business_manager_id": "${bm}",`);
    lines.push(`    "ad_account_id": "${ad}",`);
    lines.push(`    "catalog_id": "${cat}"`);
    lines.push(`  }`);
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("Si el response viene con `status=needs_oauth` y un `oauth_url`: reportarle al usuario que tiene que abrir esa URL en el browser admin para completar el handshake. Esperar confirmación antes de continuar.");
    lines.push("");
    lines.push("### 3. Verificar handshake");
    lines.push("Una vez completado el OAuth, llamá `wafle_ads_connections_test` con el `connection_id`. Confirmá: `ok=true`, `business_name`, `catalog_name`, scopes incluyen `business_management`, `catalog_management`, `ads_read`.");
    lines.push("");
    lines.push("### 4. Disparar sync inicial");
    lines.push("Llamá `wafle_ads_catalog_sync` con:");
    lines.push("```json");
    lines.push("{");
    lines.push(`  "connection_id": <id>,`);
    lines.push(`  "mode": "full",`);
    lines.push(`  "filters": ${inStock ? '{ "in_stock": true }' : "{}"}`);
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("Esta tool es long-running. Si el server emite `notifications/progress`, esperá los updates y reportalos al usuario en línea (porcentaje, items pushados). Cuando termine, registrá `items_pushed`, `items_failed`, `duration_ms`.");
    lines.push("");
    lines.push("### 5. Listar últimas 3 syncs");
    lines.push(`Llamá \`wafle_ads_catalog_syncs_list\` con \`{ connection_id: <id>, limit: 3 }\` y mostrale al usuario una tabla compacta (started_at, status, items_pushed, items_failed, duration).`);
    lines.push("");
    if (interval !== "manual") {
      lines.push("### 6. Programar sync recurrente");
      lines.push(`Llamá \`wafle_ads_catalog_schedule_set\` con \`{ connection_id: <id>, interval: "${interval}", filters: ${inStock ? '{ "in_stock": true }' : "{}"} }\`.`);
      lines.push("");
    } else {
      lines.push("### 6. (No se programa sync recurrente)");
      lines.push(`El usuario eligió \`schedule_interval=manual\`. Sugerí: "Si querés sync automático cada 6h, decime y lo seteo con \`wafle_ads_catalog_schedule_set\`."`);
      lines.push("");
    }
    lines.push("### 7. Reportar errores de productos rechazados (si los hay)");
    lines.push("Si `items_failed > 0`: llamá `wafle_ads_catalog_sync_failures` con `{ sync_id, limit: 25 }` y mostrale al usuario los códigos de error frecuentes (`ERROR_INVALID_OFFER`, falta de imagen, price=0). Esto le da pistas accionables.");

    return {
      description: `Conectar Meta a ${slug} y sync catálogo`,
      messages: [
        {
          role: "user",
          content: { type: "text", text: lines.join("\n") },
        },
      ],
    };
  },
};
