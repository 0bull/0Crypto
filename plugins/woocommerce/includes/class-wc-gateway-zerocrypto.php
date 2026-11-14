<?php
defined('ABSPATH') || exit;

class WC_Gateway_ZeroCrypto extends WC_Payment_Gateway
{
    public function __construct()
    {
        $this->id = 'zerocrypto';
        $this->method_title = '0Crypto (crypto)';
        $this->method_description = 'Accept crypto payments through your self-hosted 0Crypto gateway.';
        $this->title = 'Pay with crypto';
        $this->has_fields = false;
        $this->supports = ['products'];
        $this->init_form_fields();
        $this->init_settings();
    }

    public function init_form_fields(): void
    {
        $hook = function_exists('rest_url') ? rest_url('0crypto/v1/webhook') : '/wp-json/0crypto/v1/webhook';
        $this->form_fields = [
            'enabled' => ['title' => 'Enable', 'type' => 'checkbox', 'label' => 'Enable 0Crypto', 'default' => 'no'],
            'gateway_url' => [
                'title' => 'Gateway URL',
                'type' => 'text',
                'description' => 'The https URL of your 0Crypto Worker, for example https://pay.example.com.',
                'default' => '',
            ],
            'api_key' => ['title' => 'API key', 'type' => 'password', 'description' => 'A 0c_live_ key from the 0Crypto admin.', 'default' => ''],
            'webhook_secret' => [
                'title' => 'Webhook secret',
                'type' => 'password',
                'description' => 'Must equal WEBHOOK_SECRET on the Worker. Set the Worker WEBHOOK_URL to: ' . esc_html($hook),
                'default' => '',
            ],
        ];
    }

    /** Settings API validator for the `gateway_url` field: https only, no trailing slash. */
    public function validate_gateway_url_field($key, $value): string
    {
        $value = untrailingslashit(trim((string) $value));
        $parts = wp_parse_url($value);
        if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host']) || isset($parts['user']) || isset($parts['query']) || isset($parts['fragment'])) {
            $this->add_error('0Crypto: the gateway URL must be an https URL such as https://pay.example.com.');
            return '';
        }
        return $value;
    }

    public function is_configured(): bool
    {
        return $this->get_option('gateway_url') !== '' && $this->get_option('api_key') !== '' && $this->get_option('webhook_secret') !== '';
    }

    public function is_available()
    {
        // The Worker prices invoices in USD or EUR only, in 2-decimal minor units: a store set to show 0 or 3 price
        // decimals would send amounts that never match what the webhook checks, so the gateway is hidden there.
        return parent::is_available() && $this->is_configured() && in_array(get_woocommerce_currency(), ['USD', 'EUR'], true)
            && (int) wc_get_price_decimals() === 2;
    }

    /** @return array<string,string> */
    private function fail(string $message): array
    {
        wc_add_notice($message, 'error');
        return ['result' => 'failure'];
    }

    public function process_payment($order_id)
    {
        $order = wc_get_order($order_id);
        if (!$order) {
            return $this->fail(__('Order not found.', '0crypto-woocommerce'));
        }
        $base = (string) $this->get_option('gateway_url');
        $host = strtolower((string) wp_parse_url($base, PHP_URL_HOST));
        if (!$this->is_configured() || wp_parse_url($base, PHP_URL_SCHEME) !== 'https' || $host === '') {
            return $this->fail(__('Crypto payment is not available right now.', '0crypto-woocommerce'));
        }

        // No customer PII: only the order id, the amount and where to return to.
        $payload = [
            'price_amount' => wc_format_decimal($order->get_total(), wc_get_price_decimals()),
            'price_currency' => $order->get_currency(),
            'order_id' => (string) $order->get_id(),
            'success_url' => $order->get_checkout_order_received_url(),
        ];
        $res = wp_remote_post(rtrim($base, '/') . '/api/v1/invoices', [
            'timeout' => 15,
            'redirection' => 0,
            'headers' => [
                'Authorization' => 'Bearer ' . $this->get_option('api_key'),
                'Content-Type' => 'application/json',
            ],
            'body' => wp_json_encode($payload),
        ]);
        $unavailable = __('Crypto payment is not available right now. Please try again or pick another method.', '0crypto-woocommerce');
        if (is_wp_error($res) || (int) wp_remote_retrieve_response_code($res) !== 201) {
            return $this->fail($unavailable);
        }
        $inv = json_decode((string) wp_remote_retrieve_body($res), true);
        $id = is_array($inv) ? ($inv['id'] ?? null) : null;
        $url = is_array($inv) ? ($inv['checkout_url'] ?? null) : null;
        if (!is_string($id) || $id === '' || !is_string($url)
            || wp_parse_url($url, PHP_URL_SCHEME) !== 'https'
            || strtolower((string) wp_parse_url($url, PHP_URL_HOST)) !== $host
            || wp_parse_url($url, PHP_URL_USER) !== null) {
            return $this->fail($unavailable);
        }

        // Keep every invoice of a retried checkout (the first may still get paid); the webhook accepts any of them.
        $ids = $order->get_meta('_zerocrypto_invoice_ids');
        $ids = is_array($ids) ? $ids : [];
        $ids[] = $id;
        $order->update_meta_data('_zerocrypto_invoice_id', $id);
        $order->update_meta_data('_zerocrypto_invoice_ids', array_slice($ids, -10));
        $order->save();
        return ['result' => 'success', 'redirect' => $url];
    }
}
