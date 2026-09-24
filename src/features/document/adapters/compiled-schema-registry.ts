import { type TSchema } from '@sinclair/typebox';
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';
import { buildDocumentTypeSchema } from '../domain';
import type { CompiledSchemaRegistryPort, DocumentSchemaRegistryPort } from '../ports';

export class CompiledSchemaRegistry implements CompiledSchemaRegistryPort {
  private readonly compiledSchemas = new Map<string, TypeCheck<TSchema>>();
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(private readonly documentSchemaRegistry: DocumentSchemaRegistryPort) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initPromise) {
      this.initPromise = (async () => {
        const docTypes = await this.documentSchemaRegistry.loadAll();
        const newCompiled = new Map<string, TypeCheck<TSchema>>();

        for (const docType of docTypes) {
          const schema = buildDocumentTypeSchema(docType);
          const compiled = TypeCompiler.Compile(schema);
          newCompiled.set(docType.key, compiled);
        }

        this.compiledSchemas.clear();
        for (const [k, v] of newCompiled) {
          this.compiledSchemas.set(k, v);
        }
        this.initialized = true;
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }

    return this.initPromise;
  }

  get(key: string): TypeCheck<TSchema> | undefined {
    return this.compiledSchemas.get(key);
  }
}
