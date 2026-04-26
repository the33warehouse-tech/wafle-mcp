# Wafle MCP — Prompts

> _MCP Prompts are server-defined parametric workflows. The client (Claude Desktop, Claude Code) shows them in a picker; pick one, fill in the args, the server returns a rendered user message that drives the conversation._

In Claude Desktop, click the prompts icon next to the wafle MCP and pick one — the client surfaces an arg form.

In Claude Code: `/mcp prompts list` (or its UI equivalent) to discover; `/mcp prompts get <name>` to invoke.

For LLM clients that don't expose the Prompts API, the server also offers a tool: `wafle_prompts_list` returns the same catalogue.

---

## Catalogue (5)

| Name | Use when |
|---|---|
| `onboarding_tienda_nueva` | Acabás de cerrar a un cliente, querés crear store + MP + catálogo + API key en una sola conversación. |
| `pedido_enviar` | Llegó el chofer, hay que marcar el pedido como enviado, registrar tracking, y notificar al cliente. |
| `segmentar_y_campania` | Querés crear un segmento de clientes y mandar/agendar una campaña de email. |
| `conectar_meta_y_sync` | Conectar Meta a una tienda y subir el catálogo al Catalog API para que el Trafficker arme campañas Advantage+. |
| `debug_orden_fallida` | Cliente reclama un pedido que no avanzó; necesitás diagnosticar y, si aplica, reintentar con otro gateway. |

---

## `onboarding_tienda_nueva`

**Args:**

| Name | Required | Description |
|---|---|---|
| `store_name` | yes | Nombre comercial (ej. "Calista"). |
| `store_slug` | yes | Slug URL-safe (ej. "calista"). |
| `domain` | no | Dominio público (default `<slug>.com.ar`). |
| `theme_color` | no | Hex de marca. |
| `currency` | no | ISO currency (default ARS). |
| `catalog_mode` | no | `manual` \| `supabase_sync` \| `csv` (default `manual`). |
| `mp_access_token` | no | Si presente, conecta MP automáticamente. |
| `mp_public_key` | no | Public key de MP (con el access token). |
| `csv_url` | no | Si presente, dispara import inicial. |
| `frontend_scopes` | no | CSV de scopes para la API key del frontend. Default `stores:read,products:read,orders:write`. |

**Behavior:** instructs Claude to call `wafle_stores_create` → `wafle_gateways_create` (if MP) → `wafle_csv_import` (if URL) → `wafle_auth_keys_create`, with stop conditions on each failure mode.

**Example invocation (Claude Desktop):**

Pick prompt → fill:
- store_name = `Calista`
- store_slug = `calista`
- mp_access_token = `APP_USR-...`
- csv_url = `https://drive.google.com/.../calista.csv`

Claude takes over and runs the 4-step sequence, reporting back the API key (one-time view).

---

## `pedido_enviar`

**Args:**

| Name | Required | Description |
|---|---|---|
| `store_slug` | yes | Slug de la tienda. |
| `order_id` | yes | ID numérico del pedido. |
| `carrier` | yes | `andreani` \| `oca` \| `viacargo` \| etc. |
| `tracking_number` | yes | Código de tracking. |
| `tracking_url` | no | URL pública del tracking. |
| `notify_customer` | no | `true` (default) o `false`. |

**Behavior:** Claude lee primero el pedido (`wafle_orders_get`), valida estado, luego marca como shipped (`wafle_orders_ship`) y reporta el outcome.

**Example:**

```
prompts/get pedido_enviar
{
  "store_slug": "gamerland",
  "order_id": "87",
  "carrier": "andreani",
  "tracking_number": "ABC123XYZ"
}
```

---

## `segmentar_y_campania`

**Args:**

| Name | Required | Description |
|---|---|---|
| `store_slug` | yes | |
| `segment_name` | yes | Nombre humano del segmento. |
| `criteria_description` | yes | Descripción en lenguaje natural ("compraron > $50k últimos 30 días"). El asistente la traduce a reglas estructuradas. |
| `template_slug` | yes | Slug del email template (debe existir). |
| `subject` | yes | Subject del email. |
| `send_at` | no | ISO 8601 UTC. Si vacío, manda inmediato. |
| `send_preview_to` | no | Email para preview personal antes del blast. |

**Behavior:** verifica template, traduce el criterio, crea segmento, crea campaña, opcionalmente manda preview personal.

---

## `conectar_meta_y_sync`

**Args:**

| Name | Required | Description |
|---|---|---|
| `store_slug` | yes | |
| `business_manager_id` | yes | Meta BM ID (ej. `1877915902851559`). |
| `ad_account_id` | yes | Formato `act_XXXXXXX`. |
| `catalog_id` | yes | ID del catalog en Commerce Manager. |
| `filter_in_stock_only` | no | `true` (default) \| `false`. |
| `schedule_interval` | no | `6h` \| `12h` \| `24h` \| `manual` (default). |

**Behavior:** chequea conexiones existentes, crea la nueva, gestiona OAuth, dispara sync inicial (long-running, emite progress), reporta últimas 3 syncs, opcionalmente programa recurrente.

---

## `debug_orden_fallida`

**Args:**

| Name | Required | Description |
|---|---|---|
| `store_slug` | yes | |
| `order_id` | yes | |
| `user_complaint` | no | Reclamo textual del cliente. |
| `retry_gateway_type` | no | Si está, reintenta con ese tipo (`transfer`, `mp_ar`, `stripe`). |
| `followup_whatsapp` | no | Teléfono con país para programar follow-up si transfer no se acredita. |

**Behavior:** lee orden + timeline, distingue "no se debitó plata" vs "se debitó", y opcionalmente reintenta + programa follow-up.

**Reglas inviolables incluidas:** nunca refund si no hubo cobro; nunca retry si la orden ya está en `paid`/`shipped`.

---

## Adding new prompts

1. Crear `src/prompts/<nombre>.ts` exportando un `WaflePrompt` (snake_case name, `arguments[]`, `handler`).
2. Importarlo y agregarlo en `src/prompts/index.ts`.
3. Agregar tests en `test/prompts.test.ts`.
4. Agregar fila acá.

Las reglas:
- Args en snake_case.
- Validación de longitud máxima por arg = 4000 chars (configurable en `registry.ts`).
- El handler devuelve `{ description?, messages: [{ role, content: { type: "text", text } }] }`. Por convención se devuelve **un único mensaje `user`** que define el plan.
- Las cadenas con valores del usuario van **dentro de bloques de código** o entre comillas para minimizar prompt injection (los args ya pasan por `String().trim()` y el length cap).

## Future work

- Multi-turn prompts (sistema → user → asistente con few-shot).
- Argument types (number, boolean) cuando MCP los formalice.
- Imágenes en prompts (mockups, screenshots) para workflows visuales.
