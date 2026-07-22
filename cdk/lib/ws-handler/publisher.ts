import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { WsEvent } from './router';

interface WsManagementClient {
  send(command: PostToConnectionCommand): Promise<unknown>;
}

export type WsManagementClientFactory = (endpoint: string) => WsManagementClient;

const createAwsClient: WsManagementClientFactory = (endpoint) => {
  const client = new ApiGatewayManagementApiClient({ endpoint });
  return { send: (command) => client.send(command) };
};

function postCommand(connectionId: string, data: unknown): PostToConnectionCommand {
  return new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: JSON.stringify(data),
  });
}

/** Publisher for the API Gateway event that owns the current management endpoint. */
export function createWsEventPublisher(createClient = createAwsClient) {
  return async (event: WsEvent, connectionId: string, data: unknown): Promise<void> => {
    const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
    try {
      await createClient(endpoint).send(postCommand(connectionId, data));
    } catch (error) {
      if (error instanceof GoneException) return;
      throw error;
    }
  };
}

/** Publisher for HTTP-side callers that already know the WS management endpoint. */
export function createPeerPublisher(createClient = createAwsClient) {
  return async (
    endpoint: string,
    connectionId: string,
    data: unknown
  ): Promise<{ ok: true } | { ok: false; reason: 'gone' | string }> => {
    try {
      await createClient(endpoint).send(postCommand(connectionId, data));
      return { ok: true };
    } catch (error) {
      if (error instanceof GoneException) return { ok: false, reason: 'gone' };
      return { ok: false, reason: (error as Error).message };
    }
  };
}

export const postToPeer = createPeerPublisher();
