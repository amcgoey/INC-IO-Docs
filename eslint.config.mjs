import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'infra/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
