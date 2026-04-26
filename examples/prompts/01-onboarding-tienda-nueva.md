# 01 — Onboarding completo de tienda nueva

Conversación con Claude Desktop / Claude Code, MCP `wafle` conectado. CEO ya autenticado con su API key (scopes amplios).

Caso real: el Sr. acaba de cerrar a una nueva clienta y quiere todo configurado en una sola conversación — tienda, conexión MP, importación de catálogo desde CSV de proveedor, y una API key con scopes mínimos para que el frontend de la marca pueda leer productos sin más permisos.

---

**Vos:**
> Onboarding completo: tienda "Calista" (slug `calista`, dominio `calistabeauty.com.ar`, color `#f7c8d6`, currency ARS, catalog mode CSV). Conectame Mercado Pago — access token `APP_USR-1234567890-...` y public key `APP_USR-pk-...`. Importá el catálogo desde el CSV que está en `https://drive.google.com/.../calista-catalogo-abril.csv` (mapping default por SKU). Y generame una API key SOLO con scopes `catalog:read` y `orders:create` para usar desde el frontend Next.js.

**Claude:**

Plan: 7 calls al MCP, en orden. Voy a parar después de cada bloque crítico para que confirmes antes de seguir si algo falla.

### Paso 1 — Crear la tienda

```
[tool_use] wafle_stores_create
{
  "slug": "calista",
  "name": "Calista",
  "domain": "calistabeauty.com.ar",
  "theme_color": "#f7c8d6",
  "currency": "ARS",
  "catalog_mode": "csv"
}
[tool_result] { "id": 14, "slug": "calista", "tenant_id": 14, "key_prefix": "wfl_8a3b…" }
```

Tienda creada (`id=14`, `tenant_id=14`).

### Paso 2 — Conectar Mercado Pago

```
[tool_use] wafle_gateways_create
{
  "store_slug": "calista",
  "type": "mp_ar",
  "name": "MP Calista",
  "currency": "ARS",
  "creds": {
    "access_token": "APP_USR-1234567890-...",
    "public_key": "APP_USR-pk-..."
  }
}
[tool_result] { "id": 91, "active": false, "needs_test": true }

[tool_use] wafle_gateways_test { "gateway_id": 91 }
[tool_result] { "ok": true, "merchant_id": "987654321", "country": "AR" }

[tool_use] wafle_stores_update
{ "slug": "calista", "payment_methods": ["mp"] }
[tool_result] { "ok": true }
```

MP conectado y activado. Merchant ID `987654321`.

### Paso 3 — Importar catálogo desde CSV

```
[tool_use] wafle_catalog_csv_create
{
  "store_slug": "calista",
  "name": "Catálogo abril",
  "url": "https://drive.google.com/.../calista-catalogo-abril.csv",
  "schedule": "manual",
  "mapping": {
    "sku": "SKU",
    "name": "Nombre",
    "price": "PVP",
    "stock": "Stock",
    "image": "Imagen",
    "description": "Descripcion"
  }
}
[tool_result] { "source_id": 22, "status": "configured" }

[tool_use] wafle_catalog_csv_run_now { "source_id": 22 }
[tool_result] { "run_id": 188, "status": "running" }

[tool_use] wafle_catalog_csv_run_status { "run_id": 188 }
[tool_result] { "status": "ok", "imported": 67, "updated": 0, "errors": 0, "duration_ms": 4310 }
```

67 productos importados sin errores.

### Paso 4 — Crear API key restringida para el frontend

```
[tool_use] wafle_auth_keys_create
{
  "store_slug": "calista",
  "name": "frontend-nextjs",
  "scopes": ["catalog:read", "orders:create"]
}
[tool_result] { "id": 305, "key": "wfl_pub_3a8b5c…<una-sola-vez>", "key_prefix": "wfl_pub_3a8b5c", "scopes": ["catalog:read","orders:create"] }
```

Listo. Anotá la key — solo se muestra UNA vez:
`wfl_pub_3a8b5c…`

### Resumen

- Tienda `calista` (`id=14`) viva en `calistabeauty.com.ar`.
- MP conectado (gateway `#91`), test ok.
- 67 productos importados via CSV (source `#22`).
- API key frontend creada con scopes mínimos (`catalog:read` + `orders:create`).

Próximos pasos sugeridos: subir logo y favicon (`wafle_stores_update_branding`), configurar shipping methods (Andreani / retiro / gratis ≥ $X), y pegarle a los pixels de Meta/TikTok/GA4 si tenés los IDs.
