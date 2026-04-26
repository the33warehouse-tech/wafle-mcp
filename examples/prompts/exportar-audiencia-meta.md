# Exportar audiencia Meta de buyers > $50k último mes

**Vos:**
> Necesito una audiencia de Meta de los compradores de Lensitive que gastaron más de 50.000 en el último mes. Para retargeting.

**Claude:**

```
[tool_use] wafle_customers_segments_list { "slug": "lensitive" }
[tool_result] { "segments": [
  { "slug": "high_value", "label": "Compras > $50k últimos 30d", "count": 137 },
  { "slug": "recovered", "label": "Recuperados de carrito abandonado" },
  …
] }
```

Existe un segmento `high_value` ya armado con la condición exacta (137 customers). Lo exporto en formato Meta:

```
[tool_use] wafle_exports_meta_audience
{ "slug": "lensitive", "segment": "high_value" }
[tool_result] (CSV, 137 filas con email_sha256, phone_sha256, fn_sha256, ln_sha256, country)
```

Listo. 137 contactos hasheados (SHA-256) en el formato que pide Meta para Custom Audiences. Te paso el CSV — subílo desde Ads Manager → Audiences → Create Audience → Customer List → "Add customers from your own file" y mapeás las columnas tal cual están (Meta auto-detecta `email_sha256`, `phone_sha256`).

Sugerencia: si querés segmentarlo más fino (p.ej. solo los que compraron lentes específicos), podemos cruzar con `wafle_customers_list` filtrando por SKUs comprados. Avisame.
