# Listar pedidos pendientes de Gamerland últimos 7 días

**Vos:**
> Listame las órdenes pendientes de Gamerland de los últimos 7 días con su estado de envío.

**Claude:**

```
[tool_use] wafle_orders_list
{
  "slug": "gamerland",
  "status": "pending",
  "from_ts": 1776556800,
  "per_page": 50
}
[tool_result] {
  "orders": [
    { "id":90, "status":"pending", "total":"54500", "customer":{"email":"smoke@test.cl","firstName":"S"}, "created":1777158121, "shipping":{"city":"CABA","postalCode":"1414"}, "meta":{"gatewayType":"mp_ar"} },
    { "id":89, "status":"pending", "total":"189000", … },
    { "id":86, "status":"pending", "total":"32000", … }
  ]
}
```

3 pedidos pendientes en los últimos 7 días:

| # | Cliente | Total | Ciudad | Pago | Antigüedad |
|---|---------|-------|--------|------|------------|
| 90 | smoke@test.cl | $54.500 | CABA | MP | 4h |
| 89 | … | $189.000 | … | MP | 1d |
| 86 | … | $32.000 | … | MP | 3d |

Los 3 están en `pending` esperando confirmación de pago de MP. Si querés:
- Ver el timeline de uno: `wafle_orders_timeline { order_id: 86 }` para entender por qué quedó atascado.
- Cancelar uno: `wafle_orders_cancel { order_id: 86 }` (con auto-refund si tiene captura parcial).
- Sólo los `paid` pero sin enviar: `status: "paid"` en el filtro.
