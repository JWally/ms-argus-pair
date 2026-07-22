import {
  GoneException,
  type PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { describe, expect, it, vi } from 'vitest';
import {
  createPeerPublisher,
  createWsEventPublisher,
  type WsManagementClientFactory,
} from '../cdk/lib/ws-handler/publisher';
import { event } from './fixtures/ws-router-harness';

function gone(): GoneException {
  return new GoneException({ message: 'stale connection', $metadata: { httpStatusCode: 410 } });
}

function clientFactory(send: ReturnType<typeof vi.fn>) {
  const endpoints: string[] = [];
  const createClient: WsManagementClientFactory = (endpoint) => {
    endpoints.push(endpoint);
    return { send };
  };
  return { createClient, endpoints };
}

describe('WebSocket API Gateway publisher', () => {
  it('derives the management endpoint and posts a JSON message', async () => {
    const send = vi.fn(async () => ({}));
    const { createClient, endpoints } = clientFactory(send);
    const publish = createWsEventPublisher(createClient);

    await publish(event(null), 'peer-connection', { kind: 'desktop-ready' });

    expect(endpoints).toEqual(['https://ws.example.test/prod']);
    const command = send.mock.calls[0]?.[0] as PostToConnectionCommand;
    expect(command.input).toEqual({
      ConnectionId: 'peer-connection',
      Data: JSON.stringify({ kind: 'desktop-ready' }),
    });
  });

  it('silently drops a message when API Gateway reports a stale connection', async () => {
    const send = vi.fn(async () => Promise.reject(gone()));
    const publish = createWsEventPublisher(clientFactory(send).createClient);

    await expect(publish(event(null), 'stale-connection', { kind: 'ignored' })).resolves.toBe(
      undefined
    );
  });

  it('propagates transport failures that are not stale connections', async () => {
    const failure = new Error('network unavailable');
    const send = vi.fn(async () => Promise.reject(failure));
    const publish = createWsEventPublisher(clientFactory(send).createClient);

    await expect(publish(event(null), 'peer-connection', {})).rejects.toBe(failure);
  });

  it('reports stale and unexpected failures to server-side peer callers', async () => {
    const staleSend = vi.fn(async () => Promise.reject(gone()));
    const failedSend = vi.fn(async () => Promise.reject(new Error('publish failed')));
    const stalePublisher = createPeerPublisher(clientFactory(staleSend).createClient);
    const failedPublisher = createPeerPublisher(clientFactory(failedSend).createClient);

    await expect(stalePublisher('https://ws.example.test/prod', 'peer', {})).resolves.toEqual({
      ok: false,
      reason: 'gone',
    });
    await expect(failedPublisher('https://ws.example.test/prod', 'peer', {})).resolves.toEqual({
      ok: false,
      reason: 'publish failed',
    });
  });
});
