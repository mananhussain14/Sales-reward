<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# SalesReward — Project Rules

## What this is
SalesReward is a standalone web-based retail sales incentive platform,
controlled by a single vendor company.

## Current milestone
Build **only** the Vendor Admin foundation. Do not build beyond it yet.

The Vendor Admin will *later* manage (not now):
- Retailer shops and owner invitations
- Products and barcodes
- Incentive campaigns and challenges
- Sales claims
- Coins
- Cash-redemption requests
- Reports and audit logs

## Technology
Current:
- Next.js (App Router)
- TypeScript (strict mode)
- Tailwind CSS
- ESLint

Planned (do not add until requested):
- Supabase PostgreSQL
- Supabase Auth

## How to work
- Work in small steps. Do not build the complete application at once.
- Wait for approval before editing files.
- Do not build retailers, products, campaigns, claims, coins, or payouts yet.
- Do not add Supabase or install any packages until requested.
- Explain what a package does and why it's needed before installing it.
- Do not run destructive commands without approval.
- Run `npm run lint` and `npm run build` after meaningful changes.

## Security rules (apply as features are built)
- Do not expose secrets in browser code.
- Sensitive actions must run server-side.
- Validate all server inputs.
- Check exact permissions on the server for every sensitive action.
- Record sensitive admin actions in audit logs.
- Use migrations for all database changes.
