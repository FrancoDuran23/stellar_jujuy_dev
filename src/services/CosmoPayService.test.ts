import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CosmoPayService } from './CosmoPayService.ts';

test('CosmoPayService - Mock mode initialization', () => {
  const service = new CosmoPayService({ apiKey: 'mock' });
  assert.equal(service.isMock, true);
});

test('CosmoPayService - Create deposit intent in mock mode', async () => {
  const service = new CosmoPayService({ apiKey: 'dv_test_mock' });
  const intent = await service.createDepositIntent({
    amount: '5.00',
    msg: 'Prueba Fondeo Astroam',
  });

  assert.ok(intent.id.startsWith('intent_mock_'));
  assert.ok(intent.uri.includes('web+stellar:pay?'));
  assert.ok(intent.uri.includes('amount=5.00'));
  assert.equal(intent.amount, '5.00');
  assert.equal(intent.isMock, true);
});

test('CosmoPayService - Validate transaction hash in mock mode', async () => {
  const service = new CosmoPayService({ apiKey: 'dv_test_mock' });
  const intent = await service.createDepositIntent({ amount: '5.00' });

  // Valid hash
  const validResult = await intent.validate('0x1234567890abcdef1234567890abcdef');
  assert.equal(validResult.valid, true);
  assert.equal(validResult.status, 'settled');

  // Invalid hash
  const invalidResult = await intent.validate('');
  assert.equal(invalidResult.valid, false);
});
