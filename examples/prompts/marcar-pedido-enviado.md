# Marcar un pedido como enviado

**Vos:**
> Marcale al pedido 87 de Gamerland que se envió por Andreani con tracking `ABC123`.

**Claude:**

```
[tool_use] wafle_orders_get { "slug": "gamerland", "order_id": 87 }
[tool_result] { "id": 87, "status": "paid", "customer": { "email": "cliente@x.com", "firstName": "Pedro" }, "total": "189000", … }

[tool_use] wafle_orders_ship
{
  "slug": "gamerland",
  "order_id": 87,
  "carrier": "andreani",
  "tracking_number": "ABC123",
  "tracking_url": "https://andreani.com.ar/seguimiento?codigo=ABC123",
  "notify_customer": true
}
[tool_result] { "ok": true, "status": "shipped", "shipped_at": 1777170123, "email_sent_to": "cliente@x.com" }
```

Pedido 87 marcado como enviado. Andreani, tracking `ABC123`. Status pasó de `paid` → `shipped`. Email automático ya salió a `cliente@x.com`.
