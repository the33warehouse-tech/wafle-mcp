# Comparar Lensitive vs Gamerland últimos 30 días

**Vos:**
> Mostrame analytics de Lensitive vs Gamerland últimos 30 días. Quiero saber quién está vendiendo más.

**Claude:**

```
[tool_use] wafle_analytics_summary { "slug": "lensitive", "range": "30d" }
[tool_result] { "range":"30d", "orders": 412, "revenue": 18400000, "conversion": { "views": 26000, "adds": 3120, "checkouts": 880, "submitted": 412 }, "top_products": { "lens-001": 88, "lens-014": 67, … } }

[tool_use] wafle_analytics_summary { "slug": "gamerland", "range": "30d" }
[tool_result] { "range":"30d", "orders": 287, "revenue": 24700000, "conversion": { "views": 41000, "adds": 4900, "checkouts": 740, "submitted": 287 }, "top_products": { "gl-011": 41, … } }
```

| KPI                | Lensitive | Gamerland | Δ |
|--------------------|-----------|-----------|---|
| Pedidos            | 412       | 287       | -30% |
| Revenue            | $18.4M    | $24.7M    | +34% |
| AOV                | $44.7k    | $86.1k    | +93% |
| Tasa add-to-cart   | 12.0%     | 12.0%     | = |
| Tasa checkout      | 28.2%     | 15.1%     | -47% |
| Tasa final         | 46.8%     | 38.8%     | -17% |

Lectura rápida:
- **Gamerland vende menos pero factura más** — tickets casi 2x más altos (gaming hardware vs anteojos). 
- **Lensitive convierte mucho mejor en checkout** (28% vs 15%) — Gamerland está perdiendo gente entre el carrito y el checkout. Sospecha: precios altos + métodos de pago/envío. Vale la pena revisar.
- **Tasa final** Lensitive 47% vs Gamerland 39%: si Gamerland igualara la conversión de Lensitive con los mismos visitantes, serían ~340 pedidos en vez de 287 → $29M en lugar de $24.7M.

Si querés profundizar pedile:
- Time-series con `wafle_analytics_by_period` (revenue diario).
- Carritos abandonados con `wafle_abandoned_list` para ver de dónde se está cayendo Gamerland.
