import js from "@eslint/js";
import globals from "globals";
import react from "@eslint-react/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["node_modules/**", "build/**", "coverage/**", "reports/**", "playwright-report/**", "test-results/**"] },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "@eslint-react": react, "react-hooks": reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      "@eslint-react/no-missing-key": "error",
      "@eslint-react/no-duplicate-key": "error",
      "@eslint-react/dom-no-dangerously-set-innerhtml-with-children": "error",
      "@eslint-react/dom-no-script-url": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
];
