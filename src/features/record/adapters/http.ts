import type { FastifyPluginAsync } from 'fastify';
import { processRecord } from '../domain';
import type { ActivityDispatcherPort, RecordServicePort } from '../ports';

export interface RecordRoutesOptions {
  service?: RecordServicePort;
  dispatcher?: ActivityDispatcherPort;
}

export const recordRoutes: FastifyPluginAsync<RecordRoutesOptions> = async (fastify, opts) => {
  const service: RecordServicePort = opts.service ?? { processRecord };
  const dispatcher: ActivityDispatcherPort | undefined = opts.dispatcher;

  fastify.post('/records', async (request, reply) => {
    const result = service.processRecord(request.body);
    if (!result.success) {
      return reply.status(400).send(result);
    }
    if (dispatcher) {
      await dispatcher.dispatch(result.activity);
    }
    return reply.status(200).send(result);
  });
};
