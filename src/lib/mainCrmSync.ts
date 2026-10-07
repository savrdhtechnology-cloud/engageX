import { supabase } from './supabase';

const MAIN_CRM_BRIDGE_URL = 'https://ldffgetuzoeupuhoaubn.supabase.co/functions/v1/engagex-crm-bridge';
const SOURCE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

type WorkspaceRef = { id: string; slug: string; name?: string | null };

async function callBridge(workspace: WorkspaceRef, payload: Record<string, unknown>) {
  if (workspace.slug !== 'savrdh-engagex') return { ok: true, skipped: true };

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('EngageX session is required for Main CRM sync.');
  if (!SOURCE_KEY) throw new Error('EngageX publishable key is missing.');

  const response = await fetch(MAIN_CRM_BRIDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + session.access_token,
      'x-source-apikey': SOURCE_KEY,
    },
    body: JSON.stringify({ workspaceId: workspace.id, ...payload }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(data?.error || 'Main CRM sync failed.');
  return data;
}

export async function syncEngageXRecord(
  workspace: WorkspaceRef | null,
  recordKind: 'contact' | 'prospect',
  record: any,
) {
  if (!workspace) return;
  return callBridge(workspace, { action: 'upsert', recordKind, record });
}

export async function deleteEngageXRecordFromMainCrm(
  workspace: WorkspaceRef | null,
  recordKind: 'contact' | 'prospect',
  recordId: string,
) {
  if (!workspace) return;
  return callBridge(workspace, { action: 'delete', recordKind, recordId });
}

async function fetchAll(table: 'engagex_contacts' | 'engagex_prospects', workspaceId: string) {
  const rows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('workspace_id', workspaceId)
      .range(offset, offset + 999);

    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

export async function reconcileEngageXMainCrm(workspace: WorkspaceRef | null) {
  if (!workspace || workspace.slug !== 'savrdh-engagex') return { synced: 0, removed: 0 };

  const [contacts, prospects, inventory] = await Promise.all([
    fetchAll('engagex_contacts', workspace.id),
    fetchAll('engagex_prospects', workspace.id),
    callBridge(workspace, { action: 'inventory' }),
  ]);

  const active = new Map<string, { kind: 'contact' | 'prospect'; record: any }>();
  for (const record of contacts) active.set('contact:' + record.id, { kind: 'contact', record });
  for (const record of prospects) active.set('prospect:' + record.id, { kind: 'prospect', record });

  const current = new Set<string>();
  for (const item of inventory?.records || []) {
    if (!item?.recordKind || !item?.recordId) continue;
    current.add(item.recordKind + ':' + item.recordId);
  }

  let synced = 0;
  let removed = 0;

  for (const [key, item] of active) {
    if (current.has(key)) continue;
    await syncEngageXRecord(workspace, item.kind, item.record);
    synced++;
  }

  for (const key of current) {
    if (active.has(key)) continue;

    const splitAt = key.indexOf(':');
    const kind = key.slice(0, splitAt) as 'contact' | 'prospect';
    const recordId = key.slice(splitAt + 1);

    await deleteEngageXRecordFromMainCrm(workspace, kind, recordId);
    removed++;
  }

  return { synced, removed };
}
