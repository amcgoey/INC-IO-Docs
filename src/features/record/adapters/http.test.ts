import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { recordRoutes } from './http';
import type { RecordServicePort } from '../ports';

describe('Record HTTP driving adapter', () => {
  it('POST /records returns 200 and body when service returns success', async () => {
    const mockService: RecordServicePort = {
      processRecord: vi.fn().mockResolvedValue({
        success: true,
        data: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' },
        activity: {
          type: 'LOG_RECORD',
          payload: { record: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' } },
        },
      }),
    };

    const fastify = Fastify();
    await fastify.register(recordRoutes, { service: mockService });

    const validPayload = {
      id: 'rec-1',
      type: 'submittal',
      title: 'Structural Steel Spec',
    };

    const response = await fastify.inject({
      method: 'POST',
      url: '/records',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(mockService.processRecord).toHaveBeenCalledWith(validPayload);
    expect(response.json()).toEqual({
      success: true,
      data: validPayload,
      activity: {
        type: 'LOG_RECORD',
        payload: { record: validPayload },
      },
    });
  });

  it('POST /records returns 400 when service returns failure', async () => {
    const mockService: RecordServicePort = {
      processRecord: vi.fn().mockResolvedValue({
        success: false,
        errors: ['id: Expected string'],
      }),
    };

    const fastify = Fastify();
    await fastify.register(recordRoutes, { service: mockService });

    const invalidPayload = { title: 123 };

    const response = await fastify.inject({
      method: 'POST',
      url: '/records',
      payload: invalidPayload,
    });

    expect(response.statusCode).toBe(400);
    expect(mockService.processRecord).toHaveBeenCalledWith(invalidPayload);
    expect(response.json()).toEqual({
      success: false,
      errors: ['id: Expected string'],
    });
  });
});

