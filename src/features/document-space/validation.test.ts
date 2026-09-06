import { describe, it, expect, vi } from 'vitest';
import { validateDocumentSpaceTypes } from './validation';
import type { DocumentSpaceService } from './domain';

describe('DocumentSpaceTypes Validation Module', () => {
  it('returns no errors when all space types can successfully fetch their spaces', async () => {
    const mockService = {
      getAllTypes: () => [
        { id: 'projects' },
        { id: 'proposals' },
      ],
      getCollection: vi.fn().mockResolvedValue({ type: {}, spaces: [] }),
    } as unknown as DocumentSpaceService;

    const errors = await validateDocumentSpaceTypes(mockService);

    expect(errors).toEqual([]);
    expect(mockService.getCollection).toHaveBeenCalledTimes(2);
    expect(mockService.getCollection).toHaveBeenCalledWith('projects');
    expect(mockService.getCollection).toHaveBeenCalledWith('proposals');
  });

  it('returns formatted errors when one or more space types fail to fetch spaces', async () => {
    const mockService = {
      getAllTypes: () => [
        { id: 'valid-space' },
        { id: 'broken-space' },
        { id: 'another-broken' },
      ],
      getCollection: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'broken-space') {
          throw new Error('Network timeout');
        }
        if (id === 'another-broken') {
          throw 'Unknown string error';
        }
        return { type: {}, spaces: [] };
      }),
    } as unknown as DocumentSpaceService;

    const errors = await validateDocumentSpaceTypes(mockService);

    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe('DocumentSpaceType "broken-space" failed end-to-end validation: Network timeout');
    expect(errors[1]).toBe('DocumentSpaceType "another-broken" failed end-to-end validation: Unknown string error');
  });
});
