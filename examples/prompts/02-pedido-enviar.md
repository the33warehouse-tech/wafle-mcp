# 02 — Marcar pedido enviado y notificar al cliente

Conversación con Claude Desktop / Claude Code, MCP `wafle` conectado.

Caso típico: a la mañana llega el chofer de Andreani, el operador retira el pedido `#87` y le da un tracking. El Sr. quiere que en el mismo turn quede el pedido en estado `shipped`, con el tracking guardado, Y que al cliente le llegue un email del envío con el link de seguimiento. Una sola vuelta.

---

**Vos:**
> Marcame el pedido 87 de gamerland como enviado. Carrier Andreani, tracking `ABC123XYZ`. Mandale el email al cliente con el link de seguimiento.

**Claude:**

Antes de mover nada, leo el pedido para confirmar destinatario y estado actual:

```
[tool_use] wafle_orders_get { "store_slug": "gamerland", "order_id": 87 }
[tool_result] {
  "id": 87,
  "status": "paid",
  "customer": { "email": "juan@example.com", "name": "Juan Pérez" },
  "shipping": { "method": "andreani", "address": "Av. Corrientes 1234, CABA" },
  "items": [ { "sku": "PS5-DISC-825", "qty": 1, "price_cents": 89999900 } ],
  "total_cents": 89999900,
  "created_at": "2026-04-22T15:12:33Z"
}
```

Pedido `#87` está pagado (`status=paid`), método de envío Andreani, destino Juan Pérez (juan@example.com). Voy a:

1. Cambiar status a `shipped` con tracking.
2. Disparar el email transaccional `order_shipped` que ya tiene template configurado.

```
[tool_use] wafle_orders_update_status
{
  "store_slug": "gamerland",
  "order_id": 87,
  "status": "shipped",
  "tracking": { "carrier": "andreani", "code": "ABC123XYZ", "url": "https://andreani.com/tracking/ABC123XYZ" },
  "notify_customer": true
}
[tool_result] {
  "ok": true,
  "previous_status": "paid",
  "new_status": "shipped",
  "email_sent": { "to": "juan@example.com", "template": "order_shipped", "message_id": "msg_a8b3" },
  "timeline_entry_id": 412
}
```

Hecho. Pedido `#87`:
- Estado `paid` → `shipped`.
- Tracking Andreani `ABC123XYZ` guardado, link `https://andreani.com/tracking/ABC123XYZ`.
- Email `order_shipped` enviado a `juan@example.com` (msg_id `msg_a8b3`).
- Entrada de timeline `#412` con tu user como autor.

Si querés revisar el email exacto que se mandó:

```
[tool_use] wafle_emails_get { "message_id": "msg_a8b3" }
[tool_result] { "to": "juan@example.com", "subject": "Tu pedido #87 está en camino — Andreani ABC123XYZ", "rendered_html": "...", "status": "delivered" }
```

Delivered. Cualquier cosa que el cliente conteste por WhatsApp/mail te llega como ticket en el panel.
