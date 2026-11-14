<?php
defined('ABSPATH') || exit;

/**
 * REST endpoint POST /wp-json/0crypto/v1/webhook.
 *
 * Idempotency has two layers. Durable: handled event ids live in order meta `_zerocrypto_events` (last 50), checked first and
 * written (with the order saved) only after the event was applied. In flight: WordPress has no atomic order meta (under
 * HPOS orders are not posts, and wp_postmeta has no unique key), so concurrent deliveries are serialized by a row in
 * wp_options, whose option_name is UNIQUE: add_option() on an existing name fails. The row holds the acquire time; one
 * younger than 60 s makes the second delivery answer 503 (the Worker retries), an older one is stale (a crashed request)
 * and is taken over. The row is deleted in `finally` and by a shutdown function (fatal errors), so rows exist only while
 * a request is in flight. Known, accepted: if the order save fails after a partial-payment note was added, the retry adds
 * the note again.
 */
final class ZeroCrypto_Webhook
{
    public const MAX_BODY = 1048576;
    public const MAX_EVENTS = 50;
    public const LOCK_TTL = 60;
    private const LOCK_PREFIX = 'zerocrypto_evt_';

    public static function register(): void
    {
        add_action('rest_api_init', static function (): void {
            register_rest_route('0crypto/v1', '/webhook', [
                'methods' => 'POST',
                // Authentication is the HMAC signature, checked in handle(); there is no WordPress user.
                'permission_callback' => '__return_true',
                'callback' => [self::class, 'handle'],
            ]);
        });
    }

    private static function reply(int $status, string $message): WP_REST_Response
    {
        return new WP_REST_Response(['status' => $message], $status);
    }

    public static function handle(WP_REST_Request $request): WP_REST_Response
    {
        $contentType = strtolower(trim(explode(';', (string) $request->get_header('content_type'))[0]));
        if ($contentType !== 'application/json') {
            return self::reply(415, 'unsupported media type');
        }
        // The raw body, before any decode: the signature is over these exact bytes.
        $body = $request->get_body();
        if (strlen($body) > self::MAX_BODY) {
            return self::reply(413, 'payload too large');
        }

        $settings = get_option('woocommerce_zerocrypto_settings', []);
        $secret = is_array($settings) ? (string) ($settings['webhook_secret'] ?? '') : '';
        if (!ZeroCrypto_Signature::verify($secret, (string) $request->get_header('0crypto_signature'), $body, time())) {
            return self::reply(401, 'invalid signature');
        }

        $event = json_decode($body, true);
        if (!is_array($event) || !is_string($event['id'] ?? null) || !is_string($event['type'] ?? null) || !is_array($event['data'] ?? null)) {
            return self::reply(400, 'malformed event');
        }
        $eventId = $event['id'];
        $type = $event['type'];
        $data = $event['data'];
        if (!preg_match('/\A[A-Za-z0-9_:.\-]{1,100}\z/', $eventId)) {
            return self::reply(400, 'malformed event');
        }

        if (!in_array($type, ['invoice.paid', 'invoice.partially_paid', 'invoice.expired', 'invoice.late_payment'], true)) {
            return self::reply(200, 'ignored');
        }

        $invoiceId = $data['id'] ?? null;
        $orderRef = $data['order_id'] ?? null;
        // A signed event this store cannot place is not an error: the gateway also sends events for POS, payment-link,
        // subscription and API invoices, which carry no (or another system's) order_id. They are acknowledged with one
        // uniform 200 "ignored" (missing, non-numeric or unknown order_id, or an invoice the order never recorded), so
        // the Worker does not retry them, and the reply never says which case it was. Any invoice recorded for the
        // order is accepted (a retried checkout creates a new one; the first may still be paid).
        $ignored = static fn(): WP_REST_Response => self::reply(200, 'ignored');
        if (!is_string($invoiceId) || $invoiceId === '' || !is_string($orderRef) || !preg_match('/\A\d{1,18}\z/', $orderRef)) {
            return $ignored();
        }
        $order = wc_get_order((int) $orderRef);
        if (!$order || !self::knowsInvoice($order, $invoiceId)) {
            return $ignored();
        }

        $handled = $order->get_meta('_zerocrypto_events');
        $handled = is_array($handled) ? $handled : [];
        if (in_array($eventId, $handled, true)) {
            return self::reply(200, 'duplicate');
        }

        $lock = self::LOCK_PREFIX . $eventId;
        if (!self::acquire($lock)) {
            return self::reply(503, 'event in flight');
        }
        $released = false;
        register_shutdown_function(static function () use ($lock, &$released): void {
            if (!$released) {
                delete_option($lock);
            }
        });
        try {
            self::apply($order, $type, $data, $invoiceId);
            $handled[] = $eventId;
            $order->update_meta_data('_zerocrypto_events', array_slice($handled, -self::MAX_EVENTS));
            $order->save();
        } catch (\Throwable $e) {
            // Not recorded as handled, so the Worker's retry (it sees a 5xx) runs the event again.
            return self::reply(500, 'processing failed');
        } finally {
            delete_option($lock);
            $released = true;
        }
        return self::reply(200, 'ok');
    }

    private static function knowsInvoice($order, string $invoiceId): bool
    {
        $known = $order->get_meta('_zerocrypto_invoice_ids');
        $known = is_array($known) ? $known : [];
        $known[] = (string) $order->get_meta('_zerocrypto_invoice_id');
        foreach ($known as $k) {
            if (is_string($k) && $k !== '' && hash_equals($k, $invoiceId)) {
                return true;
            }
        }
        return false;
    }

    private static function acquire(string $lock): bool
    {
        if (add_option($lock, time(), '', 'no')) {
            return true;
        }
        $since = (int) get_option($lock, 0);
        if ($since > 0 && time() - $since < self::LOCK_TTL) {
            return false;
        }
        delete_option($lock);
        return (bool) add_option($lock, time(), '', 'no');
    }

    /**
     * Decimal string to integer minor units at $dec digits; null if malformed or finer than $dec. Trailing fraction
     * zeros carry no value and are dropped first, so "10", "10.0" and "10.000" are all 1000 at 2 digits.
     */
    private static function minor(string $s, int $dec): ?string
    {
        if (!preg_match('/\A(\d{1,12})(?:\.(\d+))?\z/', $s, $m)) {
            return null;
        }
        $frac = rtrim($m[2] ?? '', '0');
        if (strlen($frac) > $dec) {
            return null;
        }
        return ltrim($m[1] . str_pad($frac, $dec, '0'), '0') ?: '0';
    }

    /** @param array<string,mixed> $data */
    private static function apply($order, string $type, array $data, string $invoiceId): void
    {
        $dec = (int) wc_get_price_decimals();
        $price = is_string($data['price_amount'] ?? null) ? $data['price_amount'] : '';
        switch ($type) {
            case 'invoice.paid':
                $status = $order->get_status();
                if (!$order->needs_payment()) {
                    if (in_array($status, ['processing', 'completed'], true)) {
                        $paid = (string) $order->get_meta('_zerocrypto_paid_invoice_id');
                        if ($paid !== '' && $paid !== $invoiceId) {
                            $order->update_status('on-hold', "0Crypto: a second invoice ($invoiceId, amount $price) was paid for this order; the first ($paid) already completed it. This is an overpayment: review and refund one.");
                        }
                        return;
                    }
                    $order->update_status('on-hold', "0Crypto reports this order paid (invoice $invoiceId, amount $price) after it was $status. Review and fulfil or refund.");
                    return;
                }
                $expected = self::minor((string) wc_format_decimal($order->get_total(), $dec), $dec);
                $got = self::minor($price, $dec);
                $currency = $data['price_currency'] ?? null;
                if ($expected === null || $got === null || $got !== $expected
                    || !is_string($currency) || strtoupper($currency) !== strtoupper((string) $order->get_currency())) {
                    $order->update_status('on-hold', '0Crypto: invoice ' . $invoiceId . ' paid, but its amount or currency does not match this order (expected '
                        . wc_format_decimal($order->get_total(), $dec) . ' ' . $order->get_currency() . ', received ' . $price . ' ' . (is_string($currency) ? $currency : '?') . '). Check it before shipping.');
                    return;
                }
                $order->update_meta_data('_zerocrypto_paid_invoice_id', $invoiceId);
                $order->payment_complete($invoiceId);
                return;
            case 'invoice.expired':
                if ($order->get_status() === 'pending') {
                    $order->update_status('cancelled', '0Crypto: invoice expired without payment.');
                }
                return;
            case 'invoice.late_payment':
                if (in_array($order->get_status(), ['cancelled', 'pending'], true)) {
                    $order->update_status('on-hold', '0Crypto: a payment arrived after the invoice expired. Review it before fulfilling the order.');
                } else {
                    $order->add_order_note('0Crypto: a payment arrived after the invoice expired.');
                }
                return;
            case 'invoice.partially_paid':
                $order->add_order_note('0Crypto: a partial payment was received; the invoice is not yet fully paid.');
                return;
        }
    }
}
