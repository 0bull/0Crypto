# 0Crypto for WooCommerce

Sends WooCommerce checkouts to your self-hosted 0Crypto gateway and marks orders paid from its signed webhooks.

## Requirements

- WordPress 6.2+, WooCommerce 8.0+, PHP 8.1+
- HPOS (custom order tables) compatible: the plugin only uses the `WC_Order` meta API.
- Classic (shortcode) checkout. The plugin does not register a Checkout Block payment method.
- A deployed 0Crypto Worker reachable over https, with an API key.

## Install

1. Copy the `plugins/woocommerce` folder to `wp-content/plugins/0crypto-woocommerce` (without `tests/`, `vendor/`, `composer.*`).
2. Activate **0Crypto for WooCommerce** in Plugins.

## Settings (WooCommerce > Settings > Payments > 0Crypto)

| Setting | Value |
|---|---|
| Gateway URL | Your Worker origin, https only, e.g. `https://pay.example.com` |
| API key | A `0c_live_...` key created in the 0Crypto admin |
| Webhook secret | The Worker's `WEBHOOK_SECRET` (shown as a password field) |

## Webhook URL

On the Worker set `WEBHOOK_URL` to `https://YOUR-SHOP/wp-json/0crypto/v1/webhook` (the settings page shows the exact URL) and `WEBHOOK_SECRET` to the same value as the Webhook secret above.

Behavior: the signature (`0Crypto-Signature`, 300 s tolerance) is checked over the raw body; bodies over 1 MB or not `application/json` are refused; the order is found by `data.order_id` and one of its recorded invoice ids must equal `data.id`. A signed event that matches no order here (no or non-numeric `order_id`, unknown order, or an invoice the order never recorded, such as a POS, payment-link or subscription invoice on the same gateway) is answered `200 {"status":"ignored"}`, the same reply for every case, so the gateway does not retry it. Each event id is handled once.

| Event | Effect |
|---|---|
| `invoice.paid` | `payment_complete` if the order still needs payment and the invoice amount and currency equal the order's; otherwise the order goes on-hold with a note |
| `invoice.partially_paid` | order note |
| `invoice.expired` | cancelled, only if still pending |
| `invoice.late_payment` | on-hold plus a note |

Customer name and email are never sent to 0Crypto; only the order id, total and currency are.

## Notes and limits

- The invoice's `order_id` is the WooCommerce order **id** (`get_id()`), not the displayed order number: the webhook finds the order by it, and sequential-order-number plugins can make the two differ.
- The gateway URL is trusted admin input (only users who can manage WooCommerce can set it); it must be https, and the checkout redirect is refused unless it is https on that same host.
- Every invoice created for an order (a retried checkout makes a new one) is recorded, and a webhook for any of them is accepted. If two get paid, the order goes on-hold with an overpayment note.
- Only USD and EUR stores set to 2 price decimals (WooCommerce > Settings > General > Number of decimals) are offered the gateway, which is what the Worker supports. Amounts are compared in minor units; trailing zeros do not matter (`10.000` equals `10.00`).
- Checkout Blocks are not supported yet.
- Run a manual smoke test against a real WooCommerce install (checkout, paid, expired, late, partial, a duplicate delivery) before release: the unit tests use class stubs, not WooCommerce.

## Tests

```
npm run test:woo    # from the repo root; or: cd plugins/woocommerce && composer install && vendor/bin/phpunit
```

Dev tools need PHP 8.2+ (PHPUnit 11); the plugin itself runs on 8.1.
