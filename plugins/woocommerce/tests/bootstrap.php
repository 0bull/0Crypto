<?php
// Test bootstrap: minimal WordPress/WooCommerce class stubs; functions are stubbed per test with Brain Monkey.
define('ABSPATH', __DIR__ . '/');

require_once dirname(__DIR__) . '/vendor/autoload.php';

class WP_REST_Request
{
    /** @param array<string,string> $headers lower-case, underscore-separated keys like WordPress */
    public function __construct(private string $body = '', private array $headers = [])
    {
    }
    public function get_body(): string
    {
        return $this->body;
    }
    public function get_header(string $key): ?string
    {
        return $this->headers[strtolower(str_replace('-', '_', $key))] ?? null;
    }
}

class WP_REST_Response
{
    public function __construct(private mixed $data = null, private int $status = 200)
    {
    }
    public function get_status(): int
    {
        return $this->status;
    }
    public function get_data(): mixed
    {
        return $this->data;
    }
}

class WP_Error
{
    public function __construct(public string $code = '', public string $message = '')
    {
    }
}

abstract class WC_Payment_Gateway
{
    public string $id = '';
    public string $method_title = '';
    public string $method_description = '';
    public string $title = '';
    public bool $has_fields = false;
    public array $supports = [];
    public array $form_fields = [];
    public array $settings = [];
    public array $errors = [];

    public function get_option($key, $default = '')
    {
        return $this->settings[$key] ?? $default;
    }
    public function is_available()
    {
        return true;
    }
    public function init_settings(): void
    {
    }
    public function add_error($e): void
    {
        $this->errors[] = $e;
    }
    public function get_field_key($key): string
    {
        return 'woocommerce_' . $this->id . '_' . $key;
    }
    public function get_option_key(): string
    {
        return 'woocommerce_' . $this->id . '_settings';
    }
}

require_once dirname(__DIR__) . '/includes/class-zerocrypto-signature.php';
require_once dirname(__DIR__) . '/includes/class-zerocrypto-webhook.php';
require_once dirname(__DIR__) . '/includes/class-wc-gateway-zerocrypto.php';
