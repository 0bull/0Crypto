<?php
/**
 * Plugin Name: 0Crypto for WooCommerce
 * Description: Accept crypto payments through your self-hosted 0Crypto gateway.
 * Version: 0.1.0
 * Requires at least: 6.2
 * Requires PHP: 8.1
 * Requires Plugins: woocommerce
 * WC requires at least: 8.0
 * License: proprietary
 * Text Domain: 0crypto-woocommerce
 */

defined('ABSPATH') || exit;

define('ZEROCRYPTO_WC_FILE', __FILE__);

// Declare High-Performance Order Storage (HPOS) compatibility. Order data goes through the WC_Order meta API only.
add_action('before_woocommerce_init', static function (): void {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', ZEROCRYPTO_WC_FILE, true);
    }
});

add_action('plugins_loaded', static function (): void {
    if (!class_exists('WC_Payment_Gateway')) {
        return;
    }
    require_once __DIR__ . '/includes/class-zerocrypto-signature.php';
    require_once __DIR__ . '/includes/class-zerocrypto-webhook.php';
    require_once __DIR__ . '/includes/class-wc-gateway-zerocrypto.php';

    ZeroCrypto_Webhook::register();
    add_filter('woocommerce_payment_gateways', static function (array $gateways): array {
        $gateways[] = 'WC_Gateway_ZeroCrypto';
        return $gateways;
    });
});
