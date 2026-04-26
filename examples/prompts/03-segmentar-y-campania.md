# 03 — Segmentar audiencia y disparar campaña newsletter

Conversación con Claude Desktop / Claude Code, MCP `wafle` conectado.

Caso: el Sr. quiere reactivar a los clientes de gamerland que gastaron > $50k en los últimos 30 días. Idea: crear un segmento, lanzar una campaña con un template promo existente, y dejarla agendada para mañana 10am (hora AR).

---

**Vos:**
> Creame un segmento en gamerland: clientes que compraron > $50.000 en últimos 30 días. Nombre "Top spenders abril". Después armá una campaña con el template `promo_newsletter_abril` apuntando a ese segmento, subject "Te debemos un descuento — abrí esto", y dejala scheduled para mañana 10am hora Argentina.

**Claude:**

Tres calls. Reviso primero qué templates hay disponibles para no asumir.

### Paso 1 — Listar templates de email para confirmar el slug

```
[tool_use] wafle_email_templates_list { "store_slug": "gamerland" }
[tool_result] {
  "templates": [
    { "slug": "order_shipped", "type": "transactional", "active": true },
    { "slug": "abandoned_cart_24h", "type": "marketing", "active": true },
    { "slug": "promo_newsletter_abril", "type": "marketing", "active": true, "last_edited": "2026-04-23T11:02:00Z" }
  ]
}
```

`promo_newsletter_abril` existe y está activo.

### Paso 2 — Crear el segmento

```
[tool_use] wafle_customers_segments_create
{
  "store_slug": "gamerland",
  "name": "Top spenders abril",
  "description": "Compraron > $50k últimos 30 días",
  "criteria": {
    "all_of": [
      { "metric": "total_spent_cents", "op": ">", "value": 5000000, "window_days": 30 },
      { "metric": "orders_count", "op": ">=", "value": 1, "window_days": 30 }
    ]
  }
}
[tool_result] {
  "id": 47,
  "slug": "top-spenders-abril",
  "estimated_size": 312,
  "computed_at": "2026-04-26T03:31:12Z"
}
```

Segmento `#47` creado, ~312 contactos elegibles.

### Paso 3 — Crear campaña scheduled

`mañana 10am hora Argentina` en UTC = `2026-04-27T13:00:00Z` (AR es UTC-3).

```
[tool_use] wafle_marketing_campaigns_create
{
  "store_slug": "gamerland",
  "name": "Newsletter abril — Top spenders",
  "channel": "email",
  "template_slug": "promo_newsletter_abril",
  "segment_id": 47,
  "subject": "Te debemos un descuento — abrí esto",
  "schedule": { "type": "scheduled", "send_at": "2026-04-27T13:00:00Z" }
}
[tool_result] {
  "id": 134,
  "status": "scheduled",
  "send_at": "2026-04-27T13:00:00Z",
  "estimated_recipients": 312,
  "preview_url": "https://wafle.click/admin/stores/gamerland/marketing/campaigns/134/preview"
}
```

Listo:

- Segmento `#47` "Top spenders abril" → 312 contactos.
- Campaña `#134` con template `promo_newsletter_abril`, subject puesto.
- Scheduled para `mañana 27/04 a las 10:00 AR` (13:00 UTC).
- Podés revisar el render exacto en `https://wafle.click/admin/stores/gamerland/marketing/campaigns/134/preview` antes que salga.

Si querés mando un preview personal a tu mail antes del envío masivo:

```
[tool_use] wafle_marketing_campaigns_send_preview
{ "campaign_id": 134, "to": "facundorodriguezcasalok@gmail.com" }
```

Si en cualquier momento antes de las 10am querés cancelar: `wafle_marketing_campaigns_cancel { "campaign_id": 134 }`.
