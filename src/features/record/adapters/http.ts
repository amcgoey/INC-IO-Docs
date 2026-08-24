import type { FastifyPluginAsync } from 'fastify';
import { processRecord } from '../domain';
import type { RecordServicePort } from '../ports';

export interface RecordRoutesOptions {
  service?: RecordServicePort;
}

export const recordRoutes: FastifyPluginAsync<RecordRoutesOptions> = async (fastify, opts) => {
  const service: RecordServicePort = opts.service ?? { processRecord };

  fastify.post('/records', async (request, reply) => {
    const result = service.processRecord(request.body);
    return reply.status(200).send(result);
  });
};
