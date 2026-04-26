# Abrir tienda nueva para un cliente

Conversación con Claude Desktop / Claude Code, MCP `wafle` conectado.

---

**Vos:**
> Acabo de cerrar a Calista, una clienta nueva. Necesito que le armes la tienda en wafle. Slug `calista`, nombre "Calista Beauty", dominio `calistabeauty.com.ar`, color de marca rosa pastel (`#f7c8d6`). Catálogo manual por ahora. Currency ARS.

**Claude:**

Voy a:
1. Crear la tienda con `wafle_stores_create`.
2. Confirmar settings con `wafle_stores_get`.
3. Pedirte los datos de MP y CBU para configurarle el gateway y método de transferencia.

```
[tool_use] wafle_stores_create
{
  "slug": "calista",
  "name": "Calista Beauty",
  "domain": "calistabeauty.com.ar",
  "theme_color": "#f7c8d6",
  "catalog_mode": "manual",
  "currency": "ARS"
}
[tool_result] { "id": 12, "slug": "calista", "name": "Calista Beauty", "key_prefix": "wfl_…" }

[tool_use] wafle_stores_get { "slug": "calista" }
[tool_result] { "store": { "id": 12, "slug": "calista", "domain": "calistabeauty.com.ar", "theme_color": "#f7c8d6", "payment_methods": [], "shipping_methods": [], "free_shipping_from": 0, … } }
```

Tienda creada (id `12`). Faltan: MP access token + public key, y los datos bancarios para transferencia (CBU, alias, titular, CUIT). Pasamelos y le configuro el gateway, los métodos de pago/envío, y los métodos de envío Andreani+OCA+retiro+gratis. Después le subo los productos manuales si me pasás el listado o el CSV.

---

**Vos:**
> MP: access token `APP_USR-xxx`, public key `APP_USR-yyy`. CBU `0000000000000000000001`, alias `CALISTA.BEAUTY`, titular "Calista SRL", CUIT `30-71234567-8`.

**Claude:**

```
[tool_use] wafle_gateways_create
{ "name":"MP Calista","type":"mp_ar","currency":"ARS","creds":{"access_token":"APP_USR-xxx","public_key":"APP_USR-yyy"},"store_slug":"calista" }
[tool_result] { "id": 73, "active": true }

[tool_use] wafle_gateways_test { "gateway_id": 73 }
[tool_result] { "ok": true, "merchant_id": "1234567890" }

[tool_use] wafle_gateways_create
{ "name":"Transfer Calista","type":"transfer","currency":"ARS","meta":{"cbu":"0000000000000000000001","cbu_alias":"CALISTA.BEAUTY","cbu_titular":"Calista SRL","cbu_cuit":"30-71234567-8"},"store_slug":"calista" }
[tool_result] { "id": 74, "active": true }

[tool_use] wafle_stores_update
{ "slug": "calista", "payment_methods":["mp","transfer"], "shipping_methods":["andreani","retiro","gratis"], "free_shipping_from": 80000 }
[tool_result] { "ok": true }
```

Listo. Calista tiene:
- Gateway MP `#73` (test ok, merchant `1234567890`).
- Gateway transferencia `#74`.
- Métodos de pago: MP + transferencia.
- Envíos: Andreani + retiro + gratis (umbral $80k).

Próximo paso: ¿me pasás los productos para cargarlos con `wafle_products_create_manual`, o querés que primero le configure los pixels de Meta/TikTok/GA4?
