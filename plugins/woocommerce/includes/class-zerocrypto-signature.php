<?php
defined('ABSPATH') || exit;

/**
 * Verifies the `0Crypto-Signature` header, byte for byte the Worker's verifyWebhook (src/webhooks/sign.ts):
 * header `t=<unix>,v1=<64 lowercase hex>`, signed string `<t>.<raw body>`, HMAC-SHA256 keyed by the webhook secret.
 * The Worker emits exactly one v1; as there, a repeated key keeps the last value.
 */
final class ZeroCrypto_Signature
{
    public static function verify(string $secret, string $header, string $body, int $now, int $tolerance = 300): bool
    {
        if ($secret === '' || $header === '') {
            return false;
        }
        $t = null;
        $v1 = null;
        foreach (explode(',', $header) as $part) {
            $i = strpos($part, '=');
            if ($i === false) {
                continue;
            }
            $k = trim(substr($part, 0, $i));
            $v = trim(substr($part, $i + 1));
            if ($k === 't') {
                $t = $v;
            } elseif ($k === 'v1') {
                $v1 = $v;
            }
        }
        if ($t === null || $v1 === null) {
            return false;
        }
        // \z, not $: PHP's $ also matches before a trailing newline.
        if (!preg_match('/\A\d{1,15}\z/', $t) || !preg_match('/\A[0-9a-f]{64}\z/', $v1)) {
            return false;
        }
        if (abs($now - (int) $t) > $tolerance) {
            return false;
        }
        return hash_equals(hash_hmac('sha256', $t . '.' . $body, $secret), $v1);
    }
}
