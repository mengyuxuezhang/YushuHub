// Existing operation snapshots are independent of configuration plan rows.
// Prefer the enabled quote; otherwise retain the most recent configuration.
export async function consolidatePricingPlans(pool) {
  await pool.query(`DELETE old FROM ai_model_pricing_plans old
    JOIN ai_model_pricing_plans current ON current.capability_id=old.capability_id
      AND current.organization_id=old.organization_id
      AND (IF(current.status='enabled',1,0)>IF(old.status='enabled',1,0)
        OR (IF(current.status='enabled',1,0)=IF(old.status='enabled',1,0)
          AND (current.version>old.version OR (current.version=old.version AND current.id>old.id))))`)
}
