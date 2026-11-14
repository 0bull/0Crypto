<?php
use PHPUnit\Framework\TestCase;

/**
 * The vector below is produced by the Worker's own signWebhook (src/webhooks/sign.ts) and pinned in
 * test/webhooks/webhooks.test.ts ("matches the pinned HMAC"). Both must change together.
 */
final class SignatureTest extends TestCase
{
    private const SECRET = 'whsec_test';
    private const BODY = '{"a":1}';
    private const HEADER = 't=1700000000,v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789';

    public function testWorkerVectorVerifies(): void
    {
        $this->assertTrue(ZeroCrypto_Signature::verify(self::SECRET, self::HEADER, self::BODY, 1700000100));
    }

    public function testChangedBodyFails(): void
    {
        $this->assertFalse(ZeroCrypto_Signature::verify(self::SECRET, self::HEADER, '{"a":2}', 1700000100));
    }

    public function testWrongSecretFails(): void
    {
        $this->assertFalse(ZeroCrypto_Signature::verify('other', self::HEADER, self::BODY, 1700000100));
    }

    public function testToleranceBothDirections(): void
    {
        $this->assertTrue(ZeroCrypto_Signature::verify(self::SECRET, self::HEADER, self::BODY, 1700000300));
        $this->assertFalse(ZeroCrypto_Signature::verify(self::SECRET, self::HEADER, self::BODY, 1700000301));
        $this->assertTrue(ZeroCrypto_Signature::verify(self::SECRET, self::HEADER, self::BODY, 1699999700));
        $this->assertFalse(ZeroCrypto_Signature::verify(self::SECRET, self::HEADER, self::BODY, 1699999699));
    }

    public function testMalformedHeadersFailWithoutThrowing(): void
    {
        foreach (['', 'garbage', 't=1700000000', 'v1=abc', 't=x,v1=' . str_repeat('a', 64), 't=1700000000,v1=ZZ', 't=-5,v1=' . str_repeat('0', 64), 't=1700000000,v1=' . strtoupper(substr(self::HEADER, 16))] as $h) {
            $this->assertFalse(ZeroCrypto_Signature::verify(self::SECRET, $h, self::BODY, 1700000100), $h);
        }
    }

    public function testEmptySecretFails(): void
    {
        $this->assertFalse(ZeroCrypto_Signature::verify('', self::HEADER, self::BODY, 1700000100));
    }
}
