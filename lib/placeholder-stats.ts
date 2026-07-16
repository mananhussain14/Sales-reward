/**
 * PLACEHOLDER dashboard metrics.
 *
 * These values are hard-coded sample data for building out the Vendor Admin
 * UI. They are NOT real and must be replaced by live server-side queries once
 * the data layer (Supabase) is added. Every card renders a visible
 * "Placeholder" marker so no one mistakes these figures for real numbers.
 */
export type DashboardStat = {
  key: string;
  label: string;
  value: string;
  /** Short supporting context shown under the value. */
  hint: string;
};

export const PLACEHOLDER_STATS: DashboardStat[] = [
  { key: "total-retailers", label: "Total Retailers", value: "—", hint: "All registered retailer shops" },
  { key: "active-retailers", label: "Active Retailers", value: "—", hint: "Retailers active in the last 30 days" },
  { key: "total-staff", label: "Total Staff", value: "—", hint: "Retail staff accounts across shops" },
  { key: "active-products", label: "Active Products", value: "—", hint: "Products currently eligible for claims" },
  { key: "active-campaigns", label: "Active Campaigns", value: "—", hint: "Incentive campaigns running now" },
  { key: "claims-awaiting-review", label: "Claims Awaiting Review", value: "—", hint: "Sales claims pending admin action" },
  { key: "pending-payouts", label: "Pending Payouts", value: "—", hint: "Cash-redemption requests to process" },
];
