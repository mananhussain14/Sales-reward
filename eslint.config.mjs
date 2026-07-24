import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Supabase Edge Functions are DENO, not Next.js. They use `Deno.serve`, `Deno.env`
    // and `npm:` import specifiers, none of which resolve under this project's Node/
    // bundler settings — so linting them here reports errors about a runtime that is not
    // the one they run in. They are excluded from tsconfig.json for the same reason.
    // They are not unchecked: lib/receipts/receipt-edge-function-safety.test.ts asserts
    // their structural and security properties, and `supabase functions deploy`
    // typechecks them under Deno.
    "supabase/functions/**",
  ]),
  {
    // Honor the underscore-prefix convention for intentionally-unused bindings.
    // Some `useActionState` Server Actions receive (prevState, formData) but use
    // neither — the signature is fixed by React, so the params are named `_prevState`
    // / `_formData` to mark them deliberately unused. Without this, the default
    // `args: "after-used"` flags them because no later argument is used.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
