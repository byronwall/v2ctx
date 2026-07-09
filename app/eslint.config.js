import js from "@eslint/js";
import globals from "globals";
import solid from "eslint-plugin-solid";
import tseslint from "typescript-eslint";

const solidTypescript = solid.configs["flat/typescript"];

export default tseslint.config(
  {
    ignores: ["dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    ...solidTypescript,
    languageOptions: {
      ...solidTypescript.languageOptions,
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        ...solidTypescript.languageOptions?.parserOptions,
        ecmaFeatures: {
          ...solidTypescript.languageOptions?.parserOptions?.ecmaFeatures,
          jsx: true,
        },
      },
    },
    rules: {
      ...solidTypescript.rules,
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    files: ["src/**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
