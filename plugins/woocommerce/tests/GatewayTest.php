<?php
use Brain\Monkey;
use Brain\Monkey\Functions;
use PHPUnit\Framework\TestCase;

final class GatewayTest extends TestCase
{
    use \Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;

    /** @var array<string,mixed>|null */
    private ?array $captured = null;
    private mixed $response = null;
    /** @var string[] */
    private array $notices = [];

    protected function setUp(): void
    {
        parent::setUp();
        Monkey\setUp();
        $this->captured = null;
        $this->notices = [];
        $this->response = ['response' => ['code' => 201], 'body' => json_encode([
            'id' => 'inv_abc123',
            'checkout_url' => 'https://pay.example.com/i/inv_abc123',
        ])];
        Functions\when('wp_remote_post')->alias(function ($url, $args) {
            $this->captured = ['url' => $url, 'args' => $args];
            return $this->response;
        });
        Functions\when('is_wp_error')->alias(fn($v) => $v instanceof WP_Error);
        Functions\when('wp_remote_retrieve_response_code')->alias(fn($r) => $r['response']['code'] ?? 0);
        Functions\when('wp_remote_retrieve_body')->alias(fn($r) => $r['body'] ?? '');
        Functions\when('wp_json_encode')->alias(fn($v) => json_encode($v));
        Functions\when('wc_format_decimal')->alias(fn($v, $dp = false) => number_format((float) $v, (int) $dp, '.', ''));
        Functions\when('wc_get_price_decimals')->justReturn(2);
        Functions\when('wp_parse_url')->alias(fn($u, $c = -1) => parse_url($u, $c));
        Functions\when('wc_add_notice')->alias(function ($m, $t = 'success') {
            $this->notices[] = $t . ':' . $m;
        });
        Functions\stubEscapeFunctions();
        Functions\stubTranslationFunctions();
        Functions\when('rest_url')->alias(fn($p) => 'https://shop.example.com/wp-json/' . $p);
        Functions\when('esc_url_raw')->returnArg(1);
        Functions\when('untrailingslashit')->alias(fn($s) => rtrim($s, '/'));
        Functions\when('apply_filters')->alias(fn($tag, $v) => $v);
        Functions\when('wc_get_order')->alias(fn($id) => $this->order);
    }

    protected function tearDown(): void
    {
        Monkey\tearDown();
        parent::tearDown();
    }

    private mixed $order = null;

    private function gateway(): WC_Gateway_ZeroCrypto
    {
        $g = new WC_Gateway_ZeroCrypto();
        $g->settings = ['gateway_url' => 'https://pay.example.com/', 'api_key' => '0c_live_' . str_repeat('k', 30), 'webhook_secret' => 's'];
        return $g;
    }

    private function mockOrder(): \Mockery\MockInterface
    {
        $o = \Mockery::mock('WC_Order');
        $o->shouldReceive('get_total')->andReturn('19.9');
        $o->shouldReceive('get_currency')->andReturn('USD');
        $o->shouldReceive('get_id')->andReturn(42);
        $o->shouldReceive('get_order_number')->andReturn('42');
        $o->shouldReceive('get_checkout_order_received_url')->andReturn('https://shop.example.com/checkout/order-received/42/?key=wc_order_x');
        // PII getters must never be consulted.
        foreach (['get_billing_email', 'get_billing_first_name', 'get_billing_last_name', 'get_billing_phone', 'get_formatted_billing_full_name', 'get_billing_address_1'] as $m) {
            $o->shouldReceive($m)->never();
        }
        $this->order = $o;
        return $o;
    }

    public function test_identity(): void
    {
        $g = $this->gateway();
        $this->assertSame('zerocrypto', $g->id);
        $this->assertSame('0Crypto (crypto)', $g->method_title);
        $this->assertStringContainsString('/wp-json/0crypto/v1/webhook', $g->form_fields['webhook_secret']['description']);
    }

    public function test_plugin_header(): void
    {
        $src = file_get_contents(dirname(__DIR__) . '/0crypto-woocommerce.php');
        $this->assertStringContainsString('Plugin Name: 0Crypto for WooCommerce', $src);
        $this->assertStringContainsString('Text Domain: 0crypto-woocommerce', $src);
    }

    public function testBuildsRightRequestWithoutPii(): void
    {
        $o = $this->mockOrder();
        $o->shouldReceive('get_meta')->with('_zerocrypto_invoice_ids')->andReturn('');
        $o->shouldReceive('update_meta_data')->once()->with('_zerocrypto_invoice_id', 'inv_abc123');
        $o->shouldReceive('update_meta_data')->once()->with('_zerocrypto_invoice_ids', ['inv_abc123']);
        $o->shouldReceive('save')->once();
        $r = $this->gateway()->process_payment(42);

        $this->assertSame('success', $r['result']);
        $this->assertSame('https://pay.example.com/i/inv_abc123', $r['redirect']);
        $this->assertSame('https://pay.example.com/api/v1/invoices', $this->captured['url']);
        $args = $this->captured['args'];
        $this->assertSame(15, $args['timeout']);
        $this->assertSame('Bearer 0c_live_' . str_repeat('k', 30), $args['headers']['Authorization']);
        $this->assertSame('application/json', $args['headers']['Content-Type']);
        $body = json_decode($args['body'], true);
        $this->assertEqualsCanonicalizing([
            'order_id' => '42',
            'price_amount' => '19.90',
            'price_currency' => 'USD',
            'success_url' => 'https://shop.example.com/checkout/order-received/42/?key=wc_order_x',
        ], $body);
    }

    public function testNonHttpsCheckoutUrlIsRejected(): void
    {
        $o = $this->mockOrder();
        $o->shouldReceive('update_meta_data')->never();
        $this->response['body'] = json_encode(['id' => 'inv_abc123', 'checkout_url' => 'http://pay.example.com/i/inv_abc123']);
        $r = $this->gateway()->process_payment(42);
        $this->assertSame('failure', $r['result']);
        $this->assertArrayNotHasKey('redirect', $r);
        $this->assertCount(1, $this->notices);
    }

    public function testCheckoutUrlOnOtherHostIsRejected(): void
    {
        $o = $this->mockOrder();
        $o->shouldReceive('update_meta_data')->never();
        $this->response['body'] = json_encode(['id' => 'inv_abc123', 'checkout_url' => 'https://evil.example.net/i/inv_abc123']);
        $this->assertSame('failure', $this->gateway()->process_payment(42)['result']);
    }

    public function testGatewayErrorStatusFails(): void
    {
        $o = $this->mockOrder();
        $o->shouldReceive('update_meta_data')->never();
        $this->response = ['response' => ['code' => 401], 'body' => '{"error":{"code":"unauthorized"}}'];
        $this->assertSame('failure', $this->gateway()->process_payment(42)['result']);
    }

    public function testTransportErrorFails(): void
    {
        $o = $this->mockOrder();
        $o->shouldReceive('update_meta_data')->never();
        $this->response = new WP_Error('http_request_failed', 'timeout');
        $this->assertSame('failure', $this->gateway()->process_payment(42)['result']);
    }

    public function testMalformedResponseFails(): void
    {
        $o = $this->mockOrder();
        $o->shouldReceive('update_meta_data')->never();
        foreach (['not json', '{}', '{"id":5,"checkout_url":"https://pay.example.com/x"}', '{"id":"inv_a"}'] as $b) {
            $this->response = ['response' => ['code' => 201], 'body' => $b];
            $this->assertSame('failure', $this->gateway()->process_payment(42)['result'], $b);
        }
    }

    public function testUnknownOrderFails(): void
    {
        $this->order = false;
        $this->assertSame('failure', $this->gateway()->process_payment(7)['result']);
        $this->assertNull($this->captured);
    }

    public function testNonHttpsGatewaySettingIsRejected(): void
    {
        $g = $this->gateway();
        $this->assertSame('', $g->validate_gateway_url_field('gateway_url', 'http://pay.example.com'));
        $this->assertNotEmpty($g->errors);
        $this->assertSame('https://pay.example.com', $g->validate_gateway_url_field('gateway_url', ' https://pay.example.com/ '));
    }

    public function testGatewayWithoutSettingsIsUnavailable(): void
    {
        $g = new WC_Gateway_ZeroCrypto();
        $g->settings = ['enabled' => 'yes'];
        $this->assertFalse($g->is_configured());
        $this->assertTrue($this->gateway()->is_configured());
    }

    public function testRetriedCheckoutKeepsEveryInvoiceIdCappedAtTen(): void
    {
        $o = $this->mockOrder();
        $old = array_map(fn($i) => "inv_old$i", range(1, 10));
        $o->shouldReceive('get_meta')->with('_zerocrypto_invoice_ids')->andReturn($old);
        $o->shouldReceive('update_meta_data')->once()->with('_zerocrypto_invoice_id', 'inv_abc123');
        $o->shouldReceive('update_meta_data')->once()->with('_zerocrypto_invoice_ids', \Mockery::on(
            fn($v) => count($v) === 10 && end($v) === 'inv_abc123' && !in_array('inv_old1', $v, true)
        ));
        $o->shouldReceive('save')->once();
        $this->assertSame('success', $this->gateway()->process_payment(42)['result']);
    }

    public function testAvailableOnlyForUsdOrEurStores(): void
    {
        $g = $this->gateway();
        foreach (['USD' => true, 'EUR' => true, 'GBP' => false, 'JPY' => false] as $cur => $ok) {
            Functions\when('get_woocommerce_currency')->justReturn($cur);
            $this->assertSame($ok, $g->is_available(), $cur);
        }
    }

    /** The Worker prices in 2-decimal minor units; a store showing 0 or 3 decimals would never match an invoice amount. */
    public function testUnavailableUnlessTheStoreUsesTwoPriceDecimals(): void
    {
        $g = $this->gateway();
        Functions\when('get_woocommerce_currency')->justReturn('USD');
        foreach ([2 => true, 0 => false, 1 => false, 3 => false] as $dec => $ok) {
            Functions\when('wc_get_price_decimals')->justReturn($dec);
            $this->assertSame($ok, $g->is_available(), "decimals $dec");
        }
        Functions\when('wc_get_price_decimals')->justReturn('2'); // a filter returning a string is still two decimals
        $this->assertTrue($g->is_available());
    }
}
