import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "**/generated/",
      "**/.svelte-kit/",
      "**/build/",
      "**/*.conf.js",
      "packages/database/src/generated/**",
      "scripts/**",
      "**/*.js",
      "**/*.svelte",
    ],
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/non-null-type-assertion": "off",
      "no-console": "off",
      "no-undef": "off",
      "no-useless-assignment": "off",
    },
  },
  {
    files: ["**/*.svelte", "**/*.test.ts", "**/tests/**"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  }
);
