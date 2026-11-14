<?php
use Brain\Monkey;
use Brain\Monkey\Functions;
use Mockery\MockInterface;
use PHPUnit\Framework\TestCase;

final class WebhookTest extends TestCase
{
    use \Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;

    private const SECRET = 'whsec_test';
    private const INVOICE = 'inv_abc123';

    /** @var array<string,mixed> */
    private array $options = [];

    protected function setUp(): void
    {
        parent::setUp();
        Monkey\setUp();
        $this->options = [];
        Functions\when('get_option')->alias(fn($k, $d = false) => $k === 'woocommerce_zerocrypto_settings'
            ? ['webhook_secret' => self::SECRET]
            : ($this->options[$k] ?? $d));
        // add_option is the idempotency lock: it must fail when the name already exists (unique key in wp_options).
        Functions\when('add_option')->alias(function ($k, $v = '', $dep = '', $autoload = 'yes') {
            if (array_key_exists($k, $this->options)) {
                return false;
            }
            $this->options[$k] = $v;
            return true;
        });
        Functions\when('delete_option')->alias(function ($k) {
            unset($this->options[$k]);
            return true;
        });
        Functions\when('wc_format_decimal')->alias(fn($v, $dp = false) => number_format((float) $v, (int) $dp, '.', ''));
        Functions\when('wc_get_price_decimals')->justReturn(2);
        Functions\when('absint')->alias(fn($v) => abs((int) $v));
    }

    protected function tearDown(): void
    {
        Monkey\tearDown();
        parent::tearDown();
    }

    /** @param array<string,mixed> $data */
    private function event(string $type, array $data = [], string $id = 'evt_1'): string
    {
        return json_encode([
            'id' => $id,
            'type' => $type,
            'created_at' => '2026-11-12T00:00:00.000Z',
            'data' => $data + [
                'id' => self::INVOICE,
                'order_id' => '42',
                'price_amount' => '10.00',
                'price_currency' => 'USD',
            ],
        ]);
    }

    private function request(string $body, ?string $sig = null, string $ct = 'application/json', ?int $t = null): WP_REST_Request
    {
        $t ??= time();
        $sig ??= "t=$t,v1=" . hash_hmac('sha256', "$t.$body", self::SECRET);
        return new WP_REST_Request($body, ['0crypto_signature' => $sig, 'content_type' => $ct]);
    }

    /** @var array<string,mixed> */
    private array $meta = [];

    /** @param array<string,mixed>|null $meta */
    private function order(string $status = 'pending', ?array $meta = null, string $total = '10.00'): MockInterface
    {
        $o = \Mockery::mock('WC_Order');
        $this->meta = $meta ?? ['_zerocrypto_invoice_id' => self::INVOICE];
        $o->shouldReceive('get_meta')->andReturnUsing(fn($k) => $this->meta[$k] ?? '');
        $o->shouldReceive('update_meta_data')->andReturnUsing(function ($k, $v) {
            $this->meta[$k] = $v;
        });
        $o->shouldReceive('save')->zeroOrMoreTimes();
        $o->shouldReceive('get_status')->andReturn($status);
        $o->shouldReceive('needs_payment')->andReturn($status === 'pending' || $status === 'failed');
        $o->shouldReceive('get_total')->andReturn($total);
        $o->shouldReceive('get_currency')->andReturn('USD');
        return $o;
    }

    private function withOrder(MockInterface $o): void
    {
        Functions\when('wc_get_order')->alias(fn($id) => (int) $id === 42 ? $o : false);
    }

    public function testPaidCompletesPaymentOnce(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->once()->with(self::INVOICE);
        $this->withOrder($o);
        $r = ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')));
        $this->assertSame(200, $r->get_status());
    }

    public function testSameEventIdTwiceCompletesOnlyOnce(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->once();
        $this->withOrder($o);
        $body = $this->event('invoice.paid');
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($body))->get_status());
        $r = ZeroCrypto_Webhook::handle($this->request($body));
        $this->assertSame(200, $r->get_status());
        $this->assertSame('duplicate', $r->get_data()['status']);
    }

    public function testPaidOnAlreadyPaidOrderDoesNotComplete(): void
    {
        $o = $this->order('processing');
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')))->get_status());
    }

    public function testPaidAmountMismatchPutsOrderOnHold(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->never();
        $o->shouldReceive('update_status')->once()->with('on-hold', \Mockery::on(fn($n) => str_contains($n, '10.00') && str_contains($n, '9.99')));
        $this->withOrder($o);
        $r = ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['price_amount' => '9.99'])));
        $this->assertSame(200, $r->get_status());
    }

    public function testPaidAmountWithTrailingZerosMatches(): void
    {
        foreach (['10', '10.0', '10.000', '10.0000'] as $amt) {
            $o = $this->order();
            $o->shouldReceive('payment_complete')->once()->with(self::INVOICE);
            $o->shouldReceive('update_status')->never();
            $this->withOrder($o);
            $r = ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['price_amount' => $amt], 'evt_' . md5($amt))));
            $this->assertSame(200, $r->get_status(), $amt);
        }
    }

    public function testPaidAmountFinerThanTheStoreIsStillAMismatch(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->never();
        $o->shouldReceive('update_status')->once()->with('on-hold', \Mockery::type('string'));
        $this->withOrder($o);
        ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['price_amount' => '10.001'])));
    }

    public function testPaidCurrencyMismatchPutsOrderOnHold(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->never();
        $o->shouldReceive('update_status')->once()->with('on-hold', \Mockery::type('string'));
        $this->withOrder($o);
        ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['price_currency' => 'EUR'])));
    }

    /**
     * A signed event this store cannot place (no Woo order id, unknown order, or an invoice the order never recorded: a
     * POS, link or API invoice on the same gateway) is acknowledged with 200 "ignored", so the Worker does not retry it 20
     * times. Every such case gets the same answer.
     */
    public function testUnplaceableEventsAreIgnoredWith200Uniformly(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->never();
        $o->shouldReceive('update_status')->never();
        $this->withOrder($o);
        $cases = [
            'mismatched invoice' => ['id' => 'inv_other'],
            'unknown order' => ['order_id' => '999'],
            'missing order_id' => ['order_id' => null],
            'non-numeric order_id' => ['order_id' => 'abc'],
            'numeric order_id as a JSON number' => ['order_id' => 42],
            'missing invoice id' => ['id' => null],
        ];
        $first = null;
        foreach ($cases as $name => $data) {
            $r = ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', $data, 'evt_' . md5($name))));
            $this->assertSame(200, $r->get_status(), $name);
            $this->assertSame(['status' => 'ignored'], $r->get_data(), $name);
            $first ??= $r->get_data();
            $this->assertSame($first, $r->get_data(), $name);
        }
    }

    public function testOrderWithoutInvoiceMetaIsIgnored(): void
    {
        $o = $this->order('pending', ['x' => 1]);
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $r = ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')));
        $this->assertSame(200, $r->get_status());
        $this->assertSame('ignored', $r->get_data()['status']);
    }

    public function testUnsignedUnknownOrderIsStill401(): void
    {
        $this->withOrder($this->order());
        $r = ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['order_id' => '999']), 't=1,v1=00'));
        $this->assertSame(401, $r->get_status());
    }

    public function test_old_signature_header_is_refused(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $body = $this->event('invoice.paid');
        $t = time();
        $sig = "t=$t," . 'v1=' . hash_hmac('sha256', "$t.$body", self::SECRET);
        $req = new WP_REST_Request($body, ['paygate_signature' => $sig, 'content_type' => 'application/json']);
        $this->assertSame(401, ZeroCrypto_Webhook::handle($req)->get_status());
    }

    public function testBadSignatureIs401(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $body = $this->event('invoice.paid');
        $t = time();
        $bad = "t=$t,v1=" . str_repeat('0', 64);
        $this->assertSame(401, ZeroCrypto_Webhook::handle($this->request($body, $bad))->get_status());
        $this->assertSame(401, ZeroCrypto_Webhook::handle($this->request($body, 'nope'))->get_status());
    }

    public function testStaleTimestampIs401(): void
    {
        $this->assertSame(401, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid'), null, 'application/json', time() - 301))->get_status());
        $this->assertSame(401, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid'), null, 'application/json', time() + 301))->get_status());
    }

    public function testMissingSecretConfiguredIs401(): void
    {
        Functions\when('get_option')->justReturn(['webhook_secret' => '']);
        $this->assertSame(401, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')))->get_status());
    }

    public function testOversizedBodyIs413(): void
    {
        $body = str_repeat('a', 1048577);
        $this->assertSame(413, ZeroCrypto_Webhook::handle($this->request($body))->get_status());
    }

    public function testNonJsonContentTypeIs415(): void
    {
        $this->assertSame(415, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid'), null, 'text/plain'))->get_status());
        $this->assertSame(415, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid'), null, ''))->get_status());
    }

    public function testJsonContentTypeWithCharsetAccepted(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->once();
        $this->withOrder($o);
        $r = ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid'), null, 'application/json; charset=utf-8'));
        $this->assertSame(200, $r->get_status());
    }

    public function testSignedButInvalidJsonIs400(): void
    {
        $this->assertSame(400, ZeroCrypto_Webhook::handle($this->request('not json'))->get_status());
    }

    public function testExpiredCancelsPendingOrder(): void
    {
        $o = $this->order('pending');
        $o->shouldReceive('update_status')->once()->with('cancelled', \Mockery::type('string'));
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.expired')))->get_status());
    }

    public function testExpiredLeavesNonPendingOrderUntouched(): void
    {
        $o = $this->order('processing');
        $o->shouldReceive('update_status')->never();
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.expired')))->get_status());
    }

    public function testLatePaymentSetsOnHoldWithNote(): void
    {
        $o = $this->order('cancelled');
        $o->shouldReceive('update_status')->once()->with('on-hold', \Mockery::type('string'));
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.late_payment')))->get_status());
    }

    public function testPartiallyPaidAddsNoteOnly(): void
    {
        $o = $this->order();
        $o->shouldReceive('add_order_note')->once()->with(\Mockery::type('string'));
        $o->shouldReceive('update_status')->never();
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.partially_paid')))->get_status());
    }

    public function testUnknownEventIs200AndIgnored(): void
    {
        $o = $this->order();
        $o->shouldReceive('update_status')->never();
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('routing.swap_failed')))->get_status());
    }

    public function testFailureAfterLockReleasesLockSoRetryCanSucceed(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->once()->andThrow(new RuntimeException('db down'));
        $this->withOrder($o);
        $body = $this->event('invoice.paid');
        $this->assertSame(500, ZeroCrypto_Webhook::handle($this->request($body))->get_status());
        $this->assertSame([], $this->options);
    }

    public function testEventIdListIsCappedAtFiftyAndNoLockRowsRemain(): void
    {
        $o = $this->order();
        $o->shouldReceive('add_order_note');
        $this->withOrder($o);
        for ($i = 0; $i < 55; $i++) {
            ZeroCrypto_Webhook::handle($this->request($this->event('invoice.partially_paid', [], "evt_$i")));
        }
        $this->assertCount(50, $this->meta['_zerocrypto_events']);
        $this->assertNotContains('evt_0', $this->meta['_zerocrypto_events']);
        $this->assertContains('evt_54', $this->meta['_zerocrypto_events']);
        $this->assertSame([], $this->options);
    }

    public function testNoOptionRowsRemainAfterSuccessAndDuplicateAfterSuccessDoesNotReprocess(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->once();
        $this->withOrder($o);
        $body = $this->event('invoice.paid');
        ZeroCrypto_Webhook::handle($this->request($body));
        $this->assertSame([], $this->options);
        $r = ZeroCrypto_Webhook::handle($this->request($body));
        $this->assertSame(200, $r->get_status());
        $this->assertSame('duplicate', $r->get_data()['status']);
        $this->assertSame([], $this->options);
    }

    public function testFreshInFlightLockReturns503(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $this->options['zerocrypto_evt_evt_1'] = time() - 5;
        $this->assertSame(503, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')))->get_status());
        $this->assertArrayHasKey('zerocrypto_evt_evt_1', $this->options);
    }

    public function testStaleLockIsReacquiredAndProcessed(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->once();
        $this->withOrder($o);
        $this->options['zerocrypto_evt_evt_1'] = time() - 61;
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')))->get_status());
        $this->assertSame([], $this->options);
    }

    public function testPaidOnCancelledOrderGoesOnHoldWithNote(): void
    {
        $o = $this->order('cancelled');
        $o->shouldReceive('payment_complete')->never();
        $o->shouldReceive('update_status')->once()->with('on-hold', \Mockery::on(
            fn($n) => str_contains($n, 'inv_abc123') && str_contains($n, '10.00') && str_contains($n, 'after it was cancelled')
        ));
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')))->get_status());
    }

    public function testPaidOnCompletedOrderIsNoOp(): void
    {
        $o = $this->order('completed');
        $o->shouldReceive('payment_complete')->never();
        $o->shouldReceive('update_status')->never();
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')))->get_status());
    }

    public function testFirstInvoicePaidAfterRetryCheckoutCompletesOrder(): void
    {
        $o = $this->order('pending', ['_zerocrypto_invoice_id' => 'inv_second', '_zerocrypto_invoice_ids' => [self::INVOICE, 'inv_second']]);
        $o->shouldReceive('payment_complete')->once()->with(self::INVOICE);
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')))->get_status());
    }

    public function testUnrecordedInvoiceIsIgnoredEvenWithIdsList(): void
    {
        $o = $this->order('pending', ['_zerocrypto_invoice_id' => 'inv_second', '_zerocrypto_invoice_ids' => ['inv_second']]);
        $o->shouldReceive('payment_complete')->never();
        $this->withOrder($o);
        $r = ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')));
        $this->assertSame(200, $r->get_status());
        $this->assertSame('ignored', $r->get_data()['status']);
    }

    public function testSecondInvoicePaidPutsOrderOnHoldAsOverpayment(): void
    {
        $o = $this->order('processing', [
            '_zerocrypto_invoice_id' => 'inv_second',
            '_zerocrypto_invoice_ids' => [self::INVOICE, 'inv_second'],
            '_zerocrypto_paid_invoice_id' => self::INVOICE,
        ]);
        $o->shouldReceive('payment_complete')->never();
        $o->shouldReceive('update_status')->once()->with('on-hold', \Mockery::on(fn($n) => str_contains($n, 'overpa')));
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['id' => 'inv_second'], 'evt_2')))->get_status());
    }

    public function testCompletingRecordsPaidInvoice(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->once();
        $this->withOrder($o);
        ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid')));
        $this->assertSame(self::INVOICE, $this->meta['_zerocrypto_paid_invoice_id']);
    }

    public function testIntegerAmountMatchesTwoDecimalTotal(): void
    {
        $o = $this->order();
        $o->shouldReceive('payment_complete')->once();
        $this->withOrder($o);
        ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['price_amount' => '10'])));
    }

    public function testRoundedTotalMatchesAndExtraPrecisionDoesNot(): void
    {
        $o = $this->order('pending', null, '19.999');
        $o->shouldReceive('payment_complete')->once();
        $this->withOrder($o);
        ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['price_amount' => '20.00'])));

        $o2 = $this->order('pending', null, '10.00');
        $o2->shouldReceive('payment_complete')->never();
        $o2->shouldReceive('update_status')->twice()->with('on-hold', \Mockery::type('string'));
        $this->withOrder($o2);
        ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['price_amount' => '10.001'], 'evt_a')));
        ZeroCrypto_Webhook::handle($this->request($this->event('invoice.paid', ['price_amount' => '1e1'], 'evt_b')));
    }

    public function testLatePaymentOnProcessingOrderOnlyAddsNote(): void
    {
        $o = $this->order('processing');
        $o->shouldReceive('update_status')->never();
        $o->shouldReceive('add_order_note')->once();
        $this->withOrder($o);
        $this->assertSame(200, ZeroCrypto_Webhook::handle($this->request($this->event('invoice.late_payment')))->get_status());
    }

    public function testLatePaymentOnPendingOrderGoesOnHold(): void
    {
        $o = $this->order('pending');
        $o->shouldReceive('update_status')->once()->with('on-hold', \Mockery::type('string'));
        $this->withOrder($o);
        ZeroCrypto_Webhook::handle($this->request($this->event('invoice.late_payment')));
    }
}
