import type { HttpRouterPort, SchemaQueryPort } from '../ports';

export interface FormRoutesOptions {
  schemaQuery: SchemaQueryPort;
}

export function registerFormRoutes(server: HttpRouterPort, opts: FormRoutesOptions): void {
  const schemaQuery = opts.schemaQuery;

  server.registerRoute({
    method: 'GET',
    url: '/forms',
    handler: async () => {
      const forms = await schemaQuery.getForms();
      return {
        status: 200,
        body: forms,
      };
    },
  });
}
