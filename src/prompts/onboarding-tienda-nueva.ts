/**
 * Prompt: onboarding_tienda_nueva
 *
 * End-to-end onboarding of a new wafle store: create store, configure MP,
 * import catalog from CSV, and create a frontend-scoped API key.
 */
import type { WaflePrompt } from "./registry.js";

export const onboardingTiendaNuevaPrompt: WaflePrompt = {
  name: "onboarding_tienda_nueva",
  description:
    "Onboarding completo de una tienda nueva: crear store, configurar Mercado Pago, importar catálogo CSV (opcional), y crear una API key restringida para el frontend.",
  arguments: [
    { name: "store_name", description: "Nombre comercial de la tienda (ej. 'Calista').", required: true },
    { name: "store_slug", description: "Slug URL-safe lowercase (ej. 'calista'). Debe ser único.", required: true },
    { name: "domain", description: "Dominio público de la tienda (ej. 'calistabeauty.com.ar').", required: false },
    { name: "theme_color", description: "Color hex de marca (ej. '#f7c8d6').", required: false },
    { name: "currency", description: "Código ISO de moneda (ej. 'ARS', 'USD'). Default ARS.", required: false },
    { name: "catalog_mode", description: "Modo de catálogo: 'manual' | 'supabase_sync' | 'csv'. Default 'manual'.", required: false },
    { name: "mp_access_token", description: "Access token de Mercado Pago AR (formato APP_USR-...). Si presente, conecta MP automáticamente.", required: false },
    { name: "mp_public_key", description: "Public key de Mercado Pago AR (formato APP_USR-pk-...). Requerido junto con mp_access_token.", required: false },
    { name: "csv_url", description: "URL HTTPS del CSV de productos. Si presente, dispara import inicial.", required: false },
    { name: "frontend_scopes", description: "Scopes para la API key del frontend, separados por coma. Default: 'stores:read,products:read,orders:write'.", required: false },
  ],
  handler: (args) => {
    const name = args["store_name"]!;
    const slug = args["store_slug"]!;
    const domain = args["domain"] ?? `${slug}.com.ar`;
    const themeColor = args["theme_color"];
    const currency = args["currency"] ?? "ARS";
    const catalogMode = args["catalog_mode"] ?? "manual";
    const mpToken = args["mp_access_token"];
    const mpPublic = args["mp_public_key"];
    const csvUrl = args["csv_url"];
    const frontendScopes = args["frontend_scopes"] ?? "stores:read,products:read,orders:write";

    const lines: string[] = [];
    lines.push(`Onboardea la tienda **"${name}"** (slug=\`${slug}\`, dominio \`${domain}\`, currency=\`${currency}\`, catalog_mode=\`${catalogMode}\`${themeColor ? `, theme_color=\`${themeColor}\`` : ""}).`);
    lines.push("");
    lines.push("## Plan de ejecución (parar después de cada bloque crítico si algo falla)");
    lines.push("");
    lines.push("### 1. Crear el store");
    lines.push(`Usá \`wafle_stores_create\` con \`{ slug: "${slug}", name: "${name}", domain: "${domain}", currency: "${currency}", catalog_mode: "${catalogMode}"${themeColor ? `, theme_color: "${themeColor}"` : ""} }\`.`);
    lines.push("Después de crearlo, leé `wafle_stores_get` para confirmar la configuración inicial y registrá el `id` y `tenant_id`.");
    lines.push("");
    if (mpToken) {
      lines.push("### 2. Conectar Mercado Pago AR");
      lines.push(`Usá \`wafle_gateways_create\` con \`{ store_slug: "${slug}", type: "mp_ar", name: "MP ${name}", currency: "${currency}", creds: { access_token: "${mpToken}"${mpPublic ? `, public_key: "${mpPublic}"` : ""} } }\`.`);
      lines.push("Después corré `wafle_gateways_test` con el `gateway_id` devuelto. Si el test es ok, llamá `wafle_stores_update` con `payment_methods: [\"mp\"]` para activar el método.");
      lines.push("");
    } else {
      lines.push("### 2. (Sin gateway de pago)");
      lines.push("No se proveyó `mp_access_token`. Saltá este paso o pedile las credenciales al usuario antes de continuar.");
      lines.push("");
    }
    if (csvUrl) {
      lines.push("### 3. Importar catálogo desde CSV");
      lines.push(`Usá \`wafle_csv_import\` (o el flujo CSV que tu backend exponga) apuntando a \`${csvUrl}\`. Si la sync es asíncrona, el tool emite progress notifications — esperalas y reportá los counts finales (importados / actualizados / errores).`);
      lines.push("");
    } else {
      lines.push("### 3. (Sin catálogo inicial)");
      lines.push("No se proveyó `csv_url`. Saltá este paso, o sugerí al usuario `wafle_products_create_manual` para cargar productos uno por uno.");
      lines.push("");
    }
    lines.push("### 4. Crear API key restringida para el frontend");
    lines.push(`Usá \`wafle_auth_keys_create\` con \`{ store_slug: "${slug}", name: "frontend-${slug}", scopes: ${JSON.stringify(frontendScopes.split(",").map((s) => s.trim()).filter(Boolean))} }\`. **IMPORTANTE**: la key plain solo se devuelve una vez — pegala en la respuesta final tal cual la devuelve wafle.`);
    lines.push("");
    lines.push("### 5. Reportar al usuario");
    lines.push("Devolvé un resumen estructurado:");
    lines.push("- URL del store (`https://${domain}` y panel admin).");
    lines.push("- IDs (store_id, tenant_id, gateway_id si aplica).");
    lines.push("- API key del frontend (plain, una sola vez).");
    lines.push("- Conteo de productos importados (si hubo CSV).");
    lines.push("- Próximos pasos sugeridos: subir logo, configurar shipping, pegar pixels Meta/TikTok/GA4.");
    lines.push("");
    lines.push("Si cualquier paso falla con `kind=conflict` (slug duplicado) o `kind=validation`, parar y pedir aclaración antes de seguir.");

    return {
      description: `Onboarding de la tienda ${name} (${slug})`,
      messages: [
        {
          role: "user",
          content: { type: "text", text: lines.join("\n") },
        },
      ],
    };
  },
};
