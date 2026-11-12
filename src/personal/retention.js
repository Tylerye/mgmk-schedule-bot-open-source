// Read-only default. No publication, user, receipt or uncertain state is removed.
export async function retentionCandidates(store,now=Date.now()) {
 const inbox=await store.first("SELECT COUNT(*) count FROM inbox WHERE status='done' AND completed_at<?",now-7*86400000);
 const jobs=await store.first("SELECT COUNT(*) count FROM jobs WHERE status IN ('done','superseded','cancelled') AND kind IN ('callback','diagnostics','commands') AND completed_at<?",now-30*86400000);
 return {inbox:inbox.count,jobs:jobs.count};
}
