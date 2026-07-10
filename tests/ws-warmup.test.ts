import { describe, expect, it } from 'vitest';
import { handler } from '../cdk/lib/ws-handler';

describe('websocket warmup', () => {
  it('short-circuits synthetic warmup events before reading websocket context', async () => {
    await expect(handler({ source: 'serverless-plugin-warmup' })).resolves.toEqual({
      statusCode: 200,
      body: JSON.stringify({ warmed: true }),
    });
  });
});
