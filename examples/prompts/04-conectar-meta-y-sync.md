# 04 — Conectar Meta a una tienda y sincronizar el catálogo al Catalog API

Conversación con Claude Desktop / Claude Code, MCP `wafle` conectado.

Caso: el Sr. quiere que el Trafficker arme campañas Advantage+ para gamerland. Para eso Meta necesita que los productos estén en su Catalog API actualizados. Hay que conectar la cuenta Meta de la tienda, mapear el catalog ID, lanzar una sync, y dejar visibilidad sobre las últimas 3 corridas para que él vea si quedó algún producto desincronizado.

---

**Vos:**
> Conectame Meta a gamerland. La cuenta es la del Sr., business manager `1877915902851559`, ad account `act_2110670543056408`, catalog ID `765432109876543`. Hacé la sync inicial de productos al Catalog y mostrame las últimas 3 syncs cuando termine.

**Claude:**

Cinco calls. Reviso primero si ya hay alguna conexión Meta configurada para no duplicar.

### Paso 1 — Ver conexiones ads existentes

```
[tool_use] wafle_ads_connections_list { "store_slug": "gamerland" }
[tool_result] {
  "connections": [
    { "id": 12, "platform": "google", "active": true, "last_sync_at": "2026-04-25T19:00:00Z" }
  ]
}
```

No hay Meta todavía. La creo.

### Paso 2 — Crear conexión Meta

```
[tool_use] wafle_ads_connections_create
{
  "store_slug": "gamerland",
  "platform": "meta",
  "config": {
    "business_manager_id": "1877915902851559",
    "ad_account_id": "act_2110670543056408",
    "catalog_id": "765432109876543"
  }
}
[tool_result] {
  "id": 18,
  "platform": "meta",
  "status": "needs_oauth",
  "oauth_url": "https://wafle.click/admin/stores/gamerland/ads/meta/connect?state=a8b3..."
}
```

Necesita OAuth (permisos `business_management`, `catalog_management`, `ads_read`). Si ya está pre-autorizada por el Sr. en el browser admin, esto se completa con un click. Asumo que sí (el Sr. ya tiene la cuenta linkeada en el panel).

### Paso 3 — Verificar handshake OAuth

```
[tool_use] wafle_ads_connections_test { "connection_id": 18 }
[tool_result] {
  "ok": true,
  "business_name": "BATTO",
  "catalog_name": "Gamerland Master",
  "products_in_catalog": 0,
  "scopes_granted": ["business_management","catalog_management","ads_read"]
}
```

OAuth ok. Catalog "Gamerland Master" todavía sin productos.

### Paso 4 — Disparar sync inicial

```
[tool_use] wafle_ads_catalog_sync
{
  "connection_id": 18,
  "mode": "full",
  "filters": { "in_stock": true }
}
[tool_result] {
  "sync_id": 504,
  "status": "running",
  "estimated_items": 4112
}
```

Sync inicial corriendo. 4112 productos en stock van a subir.

### Paso 5 — Esperar y reportar las últimas 3 syncs

```
[tool_use] wafle_ads_catalog_syncs_list
{ "connection_id": 18, "limit": 3 }
[tool_result] {
  "syncs": [
    { "id": 504, "started_at": "2026-04-26T03:32:11Z", "ended_at": "2026-04-26T03:35:48Z", "status": "ok",
      "items_pushed": 4087, "items_failed": 25, "duration_ms": 217312 }
  ]
}
```

(Solo hay 1 — la sync inicial. Cuando se programe la recurrente vas a ver las 3.)

### Resumen

- Meta conectado a gamerland (`connection_id=18`), business `BATTO`, catalog `Gamerland Master`.
- Sync inicial completa en 3m37s: **4087 productos OK**, 25 fallaron.
- Los 25 fallidos los podés inspeccionar:

```
[tool_use] wafle_ads_catalog_sync_failures { "sync_id": 504, "limit": 25 }
```

— casi siempre son productos sin imagen válida o con price=0, lo cual Meta rechaza con `ERROR_INVALID_OFFER`.

Si querés que la sync corra automáticamente cada 6h:

```
[tool_use] wafle_ads_catalog_schedule_set
{ "connection_id": 18, "interval": "6h", "filters": { "in_stock": true } }
```

Con eso queda activo: cada 6h pushea diff de productos modificados a Meta. El Trafficker ya puede armar las Advantage+.
