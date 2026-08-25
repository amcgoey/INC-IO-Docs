import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'infra/pulumi/node_modules/**', 'infra/pulumi/dist/**', 'scratch/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
