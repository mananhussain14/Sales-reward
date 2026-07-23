/**
 * Re-export of the canonical status pill.
 *
 * The mapping from a stored lifecycle state to a readable label, a tone, and an
 * icon now lives in a single reusable place — @/components/ui/badge — so the
 * same status reads identically across the Vendor and Retailer surfaces, and a
 * raw database enum is never printed (an unrecognized value renders "Unknown",
 * exactly as before). This module is kept so existing
 * `@/components/admin/status-badge` imports continue to resolve unchanged.
 */
export { StatusBadge } from "@/components/ui/badge";
